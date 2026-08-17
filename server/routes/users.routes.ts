import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// ===========================================================================
// GET /api/users?search= — busca de pessoas para iniciar uma conversa
// ===========================================================================

const searchQuery = z.object({
  search: z.string().trim().min(1, "Informe um termo de busca").max(50),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

router.get("/users", requireAuth, async (req, res, next) => {
  try {
    const { search, limit } = searchQuery.parse(req.query);

    const { rows } = await pool.query(
      `SELECT
         u.user_id,
         u.username,
         up.display_name,
         up.avatar_url
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.user_id
       WHERE u.deleted_at IS NULL
         AND u.user_id <> $1
         AND (u.username ILIKE $2 OR up.display_name ILIKE $2)
       ORDER BY u.username ASC
       LIMIT $3`,
      [req.userId, `%${search}%`, limit],
    );

    res.json({ data: rows });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Parâmetros inválidos", details: err.flatten() });
    }
    next(err);
  }
});

export default router;
