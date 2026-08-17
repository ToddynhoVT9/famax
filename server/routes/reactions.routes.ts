import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePostMembership } from "../middleware/membership.js";
import { rateLimit } from "../lib/rate-limit.js";

const router = Router();

const postIdParam = z.object({
  postId: z.string().uuid("ID de post inválido"),
});

// ===========================================================================
// POST /api/posts/:postId/reactions — toggle de like
// ===========================================================================
//
// Idempotente por construção: um DELETE que devolve linha significa "estava
// curtido, agora não está"; nenhuma linha significa o inverso. Duplo-clique ou
// duas abas não conseguem produzir like duplicado.
//
// O likes_count é recalculado com COUNT(*) em vez de ±1. Custa um índice scan
// a mais, mas o contador se autocorrige se algo dessincronizar — com ±1 um
// único erro fica no banco para sempre.
// ===========================================================================

router.post(
  "/posts/:postId/reactions",
  requireAuth,
  rateLimit({ name: "toggle-like", limit: 60, windowMs: 60_000 }),
  requirePostMembership,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { postId } = postIdParam.parse(req.params);

      await client.query("BEGIN");

      const { rows: removed } = await client.query(
        `DELETE FROM post_reactions
         WHERE post_id = $1 AND user_id = $2 AND type = 'like'
         RETURNING reaction_id`,
        [postId, req.userId],
      );

      const liked = removed.length === 0;
      if (liked) {
        await client.query(
          `INSERT INTO post_reactions (reaction_id, post_id, user_id, type)
           VALUES ($1, $2, $3, 'like')
           ON CONFLICT (post_id, user_id, type) DO NOTHING`,
          [randomUUID(), postId, req.userId],
        );
      }

      const { rows } = await client.query(
        `UPDATE posts
         SET likes_count = (
           SELECT COUNT(*) FROM post_reactions
           WHERE post_id = $1 AND type = 'like'
         )
         WHERE post_id = $1
         RETURNING likes_count`,
        [postId],
      );

      await client.query("COMMIT");

      res.json({ liked, likesCount: rows[0]?.likes_count ?? 0 });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "ID de post inválido" });
      }
      next(err);
    } finally {
      client.release();
    }
  },
);

export default router;
