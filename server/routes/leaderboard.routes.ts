import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { ACTIVE_BAN } from "../middleware/community-role.js";

const router = Router();

const params = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

const query = z.object({
  period: z.enum(["week", "all"]).default("week"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

// ===========================================================================
// GET /api/communities/:communityId/leaderboard?period=week|all
// ---------------------------------------------------------------------------
// "Maiores criadores": week = semana atual (segunda a domingo, ver
// famax_week_start na migration 014); all = soma de todas as semanas. As
// regras de pontos ficam em lib/points.ts.
//
// Fica de fora quem não soma pontos positivos, conta excluída e quem está
// banido da comunidade — o ranking é uma vitrine, e banido não é exemplo.
// Público como o feed: a comunidade inteira é visível para visitantes.
// ===========================================================================

router.get("/communities/:communityId/leaderboard", async (req, res, next) => {
  try {
    const { communityId } = params.parse(req.params);
    const { period, limit } = query.parse(req.query);

    const { rows: community } = await pool.query(
      "SELECT 1 FROM communities WHERE community_id = $1 AND deleted_at IS NULL",
      [communityId],
    );
    if (community.length === 0) {
      return res.status(404).json({ error: "Comunidade não encontrada" });
    }

    const { rows } = await pool.query(
      `SELECT
         u.user_id,
         u.username,
         up.display_name,
         up.avatar_url,
         SUM(lp.points)::int AS points
       FROM leaderboard_points lp
       INNER JOIN users u          ON u.user_id = lp.user_id AND u.deleted_at IS NULL
       LEFT  JOIN user_profiles up ON up.user_id = lp.user_id
       WHERE lp.community_id = $1
         AND ($2 = 'all' OR lp.period_start = famax_week_start(NOW()))
         AND NOT EXISTS (
           SELECT 1 FROM community_bans b
           WHERE b.community_id = lp.community_id AND b.user_id = lp.user_id AND ${ACTIVE_BAN("b")}
         )
       GROUP BY u.user_id, u.username, up.display_name, up.avatar_url
       HAVING SUM(lp.points) > 0
       ORDER BY points DESC, u.username ASC
       LIMIT $3`,
      [communityId, period, limit],
    );

    // Semana em texto (YYYY-MM-DD): o front mostra "desde segunda, dd/mm".
    const { rows: week } = await pool.query<{ start: string }>(
      "SELECT famax_week_start(NOW())::text AS start",
    );

    res.json({
      period,
      weekStart: week[0].start,
      data: rows.map((row, index) => ({ ...row, rank: index + 1 })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
