import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";

const router = Router();

const listPostsParams = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

const listPostsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get("/communities/:communityId/posts", async (req, res, next) => {
  try {
    const { communityId } = listPostsParams.parse(req.params);
    const { page, limit } = listPostsQuery.parse(req.query);
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT
         p.post_id,
         p.title,
         p.content,
         p.likes_count,
         p.comments_count,
         p.created_at,
         u.user_id           AS author_id,
         u.username          AS author_username,
         up.display_name     AS author_display_name,
         up.avatar_url       AS author_avatar_url,
         cc.name             AS category_name,
         cc.slug             AS category_slug
       FROM posts p
       INNER JOIN users u           ON u.user_id  = p.author_id
       LEFT  JOIN user_profiles up  ON up.user_id = p.author_id
       LEFT  JOIN community_categories cc
             ON cc.community_category_id = p.community_category_id
       WHERE p.community_id = $1
         AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [communityId, limit, offset],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM posts
       WHERE community_id = $1 AND deleted_at IS NULL`,
      [communityId],
    );
    const total = countRows[0].total;

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
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
