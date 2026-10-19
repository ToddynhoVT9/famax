import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import {
  ACTIVE_BAN,
  requireCommunityRole,
} from "../middleware/community-role.js";
import { rateLimit } from "../lib/rate-limit.js";
import { banUser } from "../lib/moderation.js";

/**
 * Membros, papéis, transferência de dono e banimentos de uma comunidade.
 * Denúncias ficam em reports.routes.ts.
 */
const router = Router();

const communityIdParam = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

const memberParams = communityIdParam.extend({
  userId: z.string().uuid("ID de usuário inválido"),
});

const fromParams = (req: import("express").Request) => {
  const parsed = communityIdParam.safeParse(req.params);
  return parsed.success ? parsed.data.communityId : undefined;
};

function zodError(res: import("express").Response, err: z.ZodError) {
  return res
    .status(400)
    .json({ error: err.issues[0]?.message ?? "Dados inválidos", details: err.flatten() });
}

// ===========================================================================
// GET /api/communities/:communityId/members?role=&page=&limit=
// ---------------------------------------------------------------------------
// Público, como a própria comunidade: quem participa já aparece nos posts.
// Dono primeiro, depois moderadores, depois por data de entrada.
// ===========================================================================

const listMembersQuery = z.object({
  role: z.enum(["owner", "moderator", "member"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get(
  "/communities/:communityId/members",
  optionalAuth,
  async (req, res, next) => {
    try {
      const { communityId } = communityIdParam.parse(req.params);
      const { role, page, limit } = listMembersQuery.parse(req.query);

      const { rows: exists } = await pool.query(
        "SELECT 1 FROM communities WHERE community_id = $1 AND deleted_at IS NULL",
        [communityId],
      );
      if (exists.length === 0) {
        return res.status(404).json({ error: "Comunidade não encontrada" });
      }

      const params: unknown[] = [communityId];
      let where = "cm.community_id = $1 AND u.deleted_at IS NULL";
      if (role) {
        params.push(role);
        where += ` AND cm.role = $${params.length}`;
      }

      const { rows: countRows } = await pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM community_members cm
         INNER JOIN users u ON u.user_id = cm.user_id
         WHERE ${where}`,
        params,
      );
      const total = countRows[0].total;

      params.push(limit, (page - 1) * limit);
      const { rows } = await pool.query(
        `SELECT
           u.user_id,
           u.username,
           up.display_name,
           up.avatar_url,
           cm.role,
           cm.joined_at
         FROM community_members cm
         INNER JOIN users u          ON u.user_id = cm.user_id
         LEFT  JOIN user_profiles up ON up.user_id = cm.user_id
         WHERE ${where}
         ORDER BY
           CASE cm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
           cm.joined_at ASC,
           u.user_id ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      res.json({
        data: rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

// ===========================================================================
// PATCH /api/communities/:communityId/members/:userId — dono promove a
// moderador ou rebaixa a membro
// ===========================================================================

const roleSchema = z.object({
  role: z.enum(["moderator", "member"], {
    errorMap: () => ({ message: "Papel deve ser moderator ou member" }),
  }),
});

router.patch(
  "/communities/:communityId/members/:userId",
  requireAuth,
  requireCommunityRole(["owner"], fromParams),
  async (req, res, next) => {
    try {
      const { communityId, userId } = memberParams.parse(req.params);
      const { role } = roleSchema.parse(req.body ?? {});

      if (userId === req.userId) {
        return res
          .status(400)
          .json({ error: "Para deixar de ser dono, transfira a comunidade" });
      }

      // role <> 'owner' no WHERE: o papel do dono só muda pela transferência.
      const { rows } = await pool.query(
        `UPDATE community_members SET role = $3
         WHERE community_id = $1 AND user_id = $2 AND role <> 'owner'
         RETURNING user_id, role, joined_at`,
        [communityId, userId, role],
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Essa pessoa não participa da comunidade" });
      }

      res.json({ member: rows[0] });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

// ===========================================================================
// POST /api/communities/:communityId/transfer — o dono passa a comunidade
// ---------------------------------------------------------------------------
// Confirmação como na exclusão: o nome exato da comunidade no corpo. O novo
// dono precisa já ser membro; o antigo vira moderador (continua ajudando,
// mas pode ser rebaixado pelo novo dono).
// ===========================================================================

const transferSchema = z.object({
  userId: z.string().uuid("Escolha um membro"),
  confirmName: z.string({ required_error: "Confirme digitando o nome da comunidade" }),
});

router.post(
  "/communities/:communityId/transfer",
  requireAuth,
  requireCommunityRole(["owner"], fromParams),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { communityId } = communityIdParam.parse(req.params);
      const { userId, confirmName } = transferSchema.parse(req.body ?? {});

      if (userId === req.userId) {
        return res.status(400).json({ error: "Você já é o dono" });
      }

      const { rows: community } = await client.query<{ name: string }>(
        "SELECT name FROM communities WHERE community_id = $1",
        [communityId],
      );
      if (confirmName.trim() !== community[0]?.name) {
        return res
          .status(400)
          .json({ error: "O nome digitado não confere com o nome da comunidade" });
      }

      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE community_members SET role = 'owner'
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, userId],
      );
      if (!rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Essa pessoa não participa da comunidade" });
      }
      await client.query(
        `UPDATE community_members SET role = 'moderator'
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, req.userId],
      );
      await client.query(
        "UPDATE communities SET owner_id = $2 WHERE community_id = $1",
        [communityId, userId],
      );
      await client.query("COMMIT");

      res.json({ transferred: true, ownerId: userId });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// Banimentos
// ===========================================================================

// GET /api/communities/:communityId/bans — bans valendo, para a moderação.
router.get(
  "/communities/:communityId/bans",
  requireAuth,
  requireCommunityRole(["owner", "moderator"], fromParams),
  async (req, res, next) => {
    try {
      const { communityId } = communityIdParam.parse(req.params);
      const { rows } = await pool.query(
        `SELECT
           b.user_id,
           u.username,
           up.display_name,
           b.reason,
           b.expires_at,
           b.created_at,
           b.banned_by,
           bu.username AS banned_by_username
         FROM community_bans b
         INNER JOIN users u          ON u.user_id = b.user_id
         LEFT  JOIN user_profiles up ON up.user_id = b.user_id
         LEFT  JOIN users bu         ON bu.user_id = b.banned_by
         WHERE b.community_id = $1 AND ${ACTIVE_BAN("b")}
         ORDER BY b.created_at DESC`,
        [communityId],
      );
      res.json({ data: rows });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

const banSchema = z.object({
  reason: z.string().trim().max(500, "Motivo muito longo").nullish(),
  // Sem prazo = permanente.
  durationDays: z.coerce.number().int().min(1).max(3650).nullish(),
});

// POST /api/communities/:communityId/bans/:userId
router.post(
  "/communities/:communityId/bans/:userId",
  requireAuth,
  rateLimit({ name: "ban-user", limit: 30, windowMs: 60_000 }),
  requireCommunityRole(["owner", "moderator"], fromParams),
  async (req, res, next) => {
    try {
      const { communityId, userId } = memberParams.parse(req.params);
      const input = banSchema.parse(req.body ?? {});

      const result = await banUser(communityId, userId, { userId: req.userId! }, input);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.status(201).json({ ban: result.ban });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

// DELETE /api/communities/:communityId/bans/:userId — desfaz o ban. A pessoa
// não volta sozinha para os membros: entra de novo se quiser.
router.delete(
  "/communities/:communityId/bans/:userId",
  requireAuth,
  requireCommunityRole(["owner", "moderator"], fromParams),
  async (req, res, next) => {
    try {
      const { communityId, userId } = memberParams.parse(req.params);
      const { rowCount } = await pool.query(
        "DELETE FROM community_bans WHERE community_id = $1 AND user_id = $2",
        [communityId, userId],
      );
      if (!rowCount) {
        return res.status(404).json({ error: "Essa pessoa não está banida" });
      }
      res.status(204).end();
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

export default router;
