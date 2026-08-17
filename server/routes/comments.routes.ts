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

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const COMMENT_SELECT = `
  SELECT
    c.comment_id,
    c.post_id,
    c.parent_comment_id,
    c.content,
    c.created_at,
    u.user_id       AS author_id,
    u.username      AS author_username,
    up.display_name AS author_display_name,
    up.avatar_url   AS author_avatar_url
  FROM comments c
  INNER JOIN users u          ON u.user_id  = c.author_id
  LEFT  JOIN user_profiles up ON up.user_id = c.author_id
`;

// ===========================================================================
// GET /api/posts/:postId/comments
// ===========================================================================

router.get("/posts/:postId/comments", async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const { page, limit } = listQuery.parse(req.query);
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `${COMMENT_SELECT}
       WHERE c.post_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC
       LIMIT $2 OFFSET $3`,
      [postId, limit, offset],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM comments
       WHERE post_id = $1 AND deleted_at IS NULL`,
      [postId],
    );
    const total = countRows[0].total;

    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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

// ===========================================================================
// POST /api/posts/:postId/comments
// ===========================================================================

const createCommentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Comentário vazio")
    .max(2000, "Comentário deve ter no máximo 2000 caracteres"),
  parentCommentId: z.string().uuid().nullish(),
});

router.post(
  "/posts/:postId/comments",
  requireAuth,
  rateLimit({ name: "create-comment", limit: 20, windowMs: 60_000 }),
  requirePostMembership,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { postId } = postIdParam.parse(req.params);
      const data = createCommentSchema.parse(req.body);
      const commentId = randomUUID();

      // A resposta precisa pertencer ao mesmo post — sem esta checagem dá para
      // pendurar um comentário do post A como resposta de um comentário do B.
      if (data.parentCommentId) {
        const { rows } = await client.query(
          `SELECT 1 FROM comments
           WHERE comment_id = $1 AND post_id = $2 AND deleted_at IS NULL`,
          [data.parentCommentId, postId],
        );
        if (rows.length === 0) {
          return res
            .status(400)
            .json({ error: "Comentário pai não encontrado neste post" });
        }
      }

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO comments
           (comment_id, post_id, author_id, parent_comment_id, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          commentId,
          postId,
          req.userId,
          data.parentCommentId ?? null,
          data.content,
        ],
      );
      await client.query(
        `UPDATE posts SET comments_count = comments_count + 1
         WHERE post_id = $1`,
        [postId],
      );
      await client.query("COMMIT");

      // Já devolve autor resolvido para o frontend renderizar sem novo fetch.
      const { rows } = await client.query(
        `${COMMENT_SELECT} WHERE c.comment_id = $1`,
        [commentId],
      );

      res.status(201).json({ comment: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Dados inválidos", details: err.flatten() });
      }
      next(err);
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// DELETE /api/comments/:commentId — soft delete, só o autor
// ===========================================================================

router.delete("/comments/:commentId", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { commentId } = z
      .object({ commentId: z.string().uuid("ID inválido") })
      .parse(req.params);

    await client.query("BEGIN");

    // O UPDATE condicional é a própria autorização: se o comentário não é do
    // usuário (ou já foi apagado), nenhuma linha volta e nada é decrementado.
    const { rows } = await client.query(
      `UPDATE comments
       SET deleted_at = NOW()
       WHERE comment_id = $1 AND author_id = $2 AND deleted_at IS NULL
       RETURNING post_id`,
      [commentId, req.userId],
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "Comentário não encontrado ou não é seu" });
    }

    await client.query(
      `UPDATE posts
       SET comments_count = GREATEST(0, comments_count - 1)
       WHERE post_id = $1`,
      [rows[0].post_id],
    );
    await client.query("COMMIT");

    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "ID de comentário inválido" });
    }
    next(err);
  } finally {
    client.release();
  }
});

export default router;
