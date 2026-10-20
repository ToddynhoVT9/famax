import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Leitura das notificações do usuário logado. Quem cria é lib/notify.ts,
 * dentro da transação de cada ação.
 */
const router = Router();

/**
 * Esconde avisos sobre algo que foi apagado (post, comentário ou comunidade
 * com soft delete) — o link levaria a um 404. "Conteúdo removido" é a
 * exceção: ele existe justamente porque o conteúdo foi apagado.
 */
const VISIBLE = `
  (n.type = 'content_removed' OR (
     (n.post_id IS NULL OR p.deleted_at IS NULL)
     AND (n.comment_id IS NULL OR c.deleted_at IS NULL)
     AND (n.community_id IS NULL OR cm.deleted_at IS NULL)
  ))`;

const JOINS = `
  LEFT JOIN posts p        ON p.post_id = n.post_id
  LEFT JOIN comments c     ON c.comment_id = n.comment_id
  LEFT JOIN communities cm ON cm.community_id = n.community_id`;

/** Cursor opaco: created_at exato (texto, com microssegundos) + id. */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const valid =
    createdAt && !Number.isNaN(Date.parse(createdAt)) && z.string().uuid().safeParse(id).success;
  return valid ? { createdAt, id } : null;
}

async function unreadCount(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM notifications n
     ${JOINS}
     WHERE n.user_id = $1 AND n.read_at IS NULL AND ${VISIBLE}`,
    [userId],
  );
  return rows[0].n;
}

// ===========================================================================
// GET /api/notifications?cursor=&limit= — mais recentes primeiro
// ---------------------------------------------------------------------------
// Cursor e não página: avisos novos chegam o tempo todo e deslocariam o
// OFFSET. Já vem com o que o front precisa para escrever o texto (nome de
// quem agiu, título do post, trecho do comentário, nome da comunidade) e,
// nas curtidas, quantas pessoas além da última curtiram.
// ===========================================================================

const listQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get("/notifications", requireAuth, async (req, res, next) => {
  try {
    const { cursor, limit } = listQuery.parse(req.query);
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) {
      return res.status(400).json({ error: "Cursor inválido" });
    }

    const { rows } = await pool.query(
      `SELECT
         n.notification_id,
         n.type,
         n.read_at,
         n.created_at,
         n.created_at::text AS created_at_text,
         n.post_id,
         n.comment_id,
         n.community_id,
         n.data,
         a.user_id         AS actor_id,
         a.username        AS actor_username,
         ap.display_name   AS actor_display_name,
         ap.avatar_url     AS actor_avatar_url,
         p.title           AS post_title,
         cm.name           AS community_name,
         CASE WHEN c.deleted_at IS NULL THEN LEFT(c.content, 140) END AS comment_excerpt,
         CASE WHEN n.type = 'post_like' THEN (
           SELECT COUNT(*)::int FROM post_reactions r
           WHERE r.post_id = n.post_id AND r.type = 'like' AND r.user_id <> n.user_id
         ) END AS likes_count
       FROM notifications n
       ${JOINS}
       LEFT JOIN users a          ON a.user_id = n.actor_id AND a.deleted_at IS NULL
       LEFT JOIN user_profiles ap ON ap.user_id = a.user_id
       WHERE n.user_id = $1
         AND ${VISIBLE}
         AND ($2::timestamptz IS NULL OR (n.created_at, n.notification_id) < ($2::timestamptz, $3::uuid))
       ORDER BY n.created_at DESC, n.notification_id DESC
       LIMIT $4`,
      [req.userId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    res.json({
      data: page.map(({ created_at_text: _text, ...row }) => row),
      nextCursor: hasMore && last ? encodeCursor(last.created_at_text, last.notification_id) : null,
      unread: await unreadCount(req.userId!),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Parâmetros inválidos", details: err.flatten() });
    }
    next(err);
  }
});

// ===========================================================================
// GET /api/notifications/unread-count — o badge do sininho (polling)
// ===========================================================================

router.get("/notifications/unread-count", requireAuth, async (req, res, next) => {
  try {
    res.json({ unread: await unreadCount(req.userId!) });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/notifications/read — { ids?: uuid[] }; sem ids, marca todas
// ===========================================================================

const readSchema = z.object({
  ids: z.array(z.string().uuid("ID de notificação inválido")).min(1).max(100).optional(),
});

router.post("/notifications/read", requireAuth, async (req, res, next) => {
  try {
    const { ids } = readSchema.parse(req.body ?? {});

    // user_id no WHERE: ids de outra pessoa simplesmente não casam.
    await pool.query(
      `UPDATE notifications SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL
         AND ($2::uuid[] IS NULL OR notification_id = ANY($2::uuid[]))`,
      [req.userId, ids ?? null],
    );

    res.json({ unread: await unreadCount(req.userId!) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: err.issues[0]?.message ?? "Dados inválidos", details: err.flatten() });
    }
    next(err);
  }
});

export default router;
