import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { profileAccess } from "../lib/profile.js";
import { notify } from "../lib/notify.js";
import { isBlockedBetween } from "../lib/blocks.js";

const router = Router();

const userIdParam = z.object({
  userId: z.string().uuid("ID de usuário inválido"),
});

const listQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});


/**
 * Seguidores de uma conta viva (conta excluída não conta). Recebe o client da
 * transação: contar pelo pool com uma conexão ainda presa abriria uma segunda
 * conexão sem necessidade.
 */
async function followersCount(client: PoolClient, userId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM follows f
     INNER JOIN users u ON u.user_id = f.follower_id AND u.deleted_at IS NULL
     WHERE f.following_id = $1`,
    [userId],
  );
  return rows[0].n;
}

// ===========================================================================
// POST /api/users/:userId/follow — seguir
// DELETE /api/users/:userId/follow — deixar de seguir
// ---------------------------------------------------------------------------
// Idempotentes: seguir quem já segue (ou deixar quem não segue) responde o
// estado atual sem erro — duplo clique e duas abas não quebram nada.
//
// Perfil privado também pode ser seguido: a privacidade esconde o conteúdo
// do perfil e as listas, não impede o vínculo. Os posts da pessoa nas
// comunidades já são públicos de qualquer jeito.
// ===========================================================================

router.post(
  "/users/:userId/follow",
  requireAuth,
  rateLimit({ name: "follow", limit: 30, windowMs: 60_000 }),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { userId } = userIdParam.parse(req.params);
      if (userId === req.userId) {
        return res.status(400).json({ error: "Você não pode seguir a si mesmo" });
      }

      await client.query("BEGIN");
      const { rows: target } = await client.query(
        "SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL",
        [userId],
      );
      if (target.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      if (await isBlockedBetween(req.userId!, userId, client)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Não é possível seguir esta pessoa" });
      }

      const { rowCount } = await client.query(
        `INSERT INTO follows (follow_id, follower_id, following_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (follower_id, following_id) DO NOTHING`,
        [randomUUID(), req.userId, userId],
      );
      if (rowCount) {
        await notify(client, { userId, type: "follow", actorId: req.userId! });
      }
      const count = await followersCount(client, userId);
      await client.query("COMMIT");

      res.json({ following: true, followersCount: count });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  },
);

router.delete("/users/:userId/follow", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { userId } = userIdParam.parse(req.params);

    await client.query("BEGIN");
    await client.query(
      "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2",
      [req.userId, userId],
    );
    // O "começou a seguir você" de quem já não segue some junto.
    await client.query(
      "DELETE FROM notifications WHERE type = 'follow' AND user_id = $1 AND actor_id = $2",
      [userId, req.userId],
    );
    const count = await followersCount(client, userId);
    await client.query("COMMIT");

    res.json({ following: false, followersCount: count });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ===========================================================================
// GET /api/users/:userId/followers e /following — listas do perfil
// ---------------------------------------------------------------------------
// Seguem a privacidade do perfil, como as abas de posts e respostas: perfil
// privado de outra pessoa é 403. Paginadas por cursor (mais recentes
// primeiro) porque a lista muda enquanto alguém rola por ela.
//
// followed_by_me diz se QUEM VÊ segue cada pessoa da lista (botão Seguir ao
// lado de cada nome); sem sessão é sempre false.
// ===========================================================================

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const valid =
    createdAt && !Number.isNaN(Date.parse(createdAt)) && z.string().uuid().safeParse(id).success;
  return valid ? { createdAt, id } : null;
}

for (const direction of ["followers", "following"] as const) {
  // followers: quem segue o perfil; following: quem o perfil segue. Os nomes
  // de coluna saem desta tabela fixa, nunca da requisição.
  const [ownColumn, otherColumn] =
    direction === "followers" ? ["following_id", "follower_id"] : ["follower_id", "following_id"];

  router.get(`/users/:userId/${direction}`, optionalAuth, async (req, res, next) => {
    try {
      const { userId } = userIdParam.parse(req.params);
      const { cursor, limit } = listQuery.parse(req.query);
      const after = cursor ? decodeCursor(cursor) : null;
      if (cursor && !after) {
        return res.status(400).json({ error: "Cursor inválido" });
      }

      const access = await profileAccess(userId, req.userId);
      if (!access) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      if (!access.canView) {
        return res.status(403).json({ error: "Este perfil é privado" });
      }

      const { rows } = await pool.query(
        `SELECT
           u.user_id,
           u.username,
           up.display_name,
           up.avatar_url,
           f.created_at AS followed_at,
           f.created_at::text AS created_at_text,
           f.follow_id,
           EXISTS (
             SELECT 1 FROM follows mine
             WHERE mine.follower_id = $2 AND mine.following_id = u.user_id
           ) AS followed_by_me
         FROM follows f
         INNER JOIN users u          ON u.user_id = f.${otherColumn} AND u.deleted_at IS NULL
         LEFT  JOIN user_profiles up ON up.user_id = u.user_id
         WHERE f.${ownColumn} = $1
           AND ($3::timestamptz IS NULL OR (f.created_at, f.follow_id) < ($3::timestamptz, $4::uuid))
         ORDER BY f.created_at DESC, f.follow_id DESC
         LIMIT $5`,
        [userId, req.userId ?? null, after?.createdAt ?? null, after?.id ?? null, limit + 1],
      );

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];

      res.json({
        data: page.map(({ created_at_text: _text, follow_id: _id, ...row }) => row),
        nextCursor: hasMore && last ? encodeCursor(last.created_at_text, last.follow_id) : null,
      });
    } catch (err) {
      next(err);
    }
  });
}

export default router;
