import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";

/**
 * Bloquear e desbloquear (efeitos em lib/blocks.ts e na migration 026).
 */
const router = Router();

const userIdParam = z.object({
  userId: z.string().uuid("ID de usuário inválido"),
});

// ===========================================================================
// POST /api/users/:userId/block — bloquear
// DELETE /api/users/:userId/block — desbloquear
// ---------------------------------------------------------------------------
// Idempotentes. Bloquear desfaz os follows entre os dois (nos dois sentidos):
// seguir alguém que você bloqueou, ou ser seguido por ele, não faz sentido.
// Também apaga os avisos que o bloqueado gerou para quem bloqueou.
// Desbloquear não devolve nada disso.
// ===========================================================================

router.post(
  "/users/:userId/block",
  requireAuth,
  rateLimit({ name: "block", limit: 30, windowMs: 60_000 }),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { userId } = userIdParam.parse(req.params);
      if (userId === req.userId) {
        return res.status(400).json({ error: "Você não pode bloquear a si mesmo" });
      }
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL", [userId]);
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      await client.query(
        `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [req.userId, userId],
      );
      await client.query(
        `DELETE FROM follows
         WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)`,
        [req.userId, userId],
      );
      // Os avisos que o bloqueado já tinha gerado para quem bloqueou somem
      // junto (os novos já não são criados — ver lib/notify.ts).
      await client.query("DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2", [req.userId, userId]);
      await client.query("COMMIT");
      res.json({ blocked: true });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof z.ZodError) return res.status(400).json({ error: "ID de usuário inválido" });
      next(err);
    } finally {
      client.release();
    }
  },
);

router.delete("/users/:userId/block", requireAuth, async (req, res, next) => {
  try {
    const { userId } = userIdParam.parse(req.params);
    await pool.query("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2", [req.userId, userId]);
    res.json({ blocked: false });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "ID de usuário inválido" });
    next(err);
  }
});

// ===========================================================================
// GET /api/me/blocks — lista de bloqueados (configurações)
// ===========================================================================

router.get("/me/blocks", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.username, up.display_name, up.avatar_url, b.created_at AS blocked_at
       FROM user_blocks b
       INNER JOIN users u          ON u.user_id = b.blocked_id
       LEFT  JOIN user_profiles up ON up.user_id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [req.userId],
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
