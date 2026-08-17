import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { requireMembership } from "../middleware/membership.js";
import { rateLimit } from "../lib/rate-limit.js";

const router = Router();

const listPostsParams = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

const listPostsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  categoryId: z.string().uuid().optional(),
});

// ===========================================================================
// GET /api/communities/:communityId/posts
// ===========================================================================

router.get(
  "/communities/:communityId/posts",
  optionalAuth,
  async (req, res, next) => {
    try {
      const { communityId } = listPostsParams.parse(req.params);
      const { page, limit, categoryId } = listPostsQuery.parse(req.query);
      const offset = (page - 1) * limit;

      // req.userId é opcional aqui: sem sessão, liked_by_me é sempre false.
      // Sem esta coluna o botão de like renderiza "não curtido" após cada F5,
      // mesmo para quem já curtiu.
      const params: unknown[] = [communityId, req.userId ?? null];
      let categoryFilter = "";
      if (categoryId) {
        params.push(categoryId);
        categoryFilter = `AND p.community_category_id = $${params.length}`;
      }
      params.push(limit, offset);

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
           cc.slug             AS category_slug,
           EXISTS (
             SELECT 1 FROM post_reactions r
             WHERE r.post_id = p.post_id
               AND r.user_id = $2
               AND r.type = 'like'
           ) AS liked_by_me
         FROM posts p
         INNER JOIN users u           ON u.user_id  = p.author_id
         LEFT  JOIN user_profiles up  ON up.user_id = p.author_id
         LEFT  JOIN community_categories cc
               ON cc.community_category_id = p.community_category_id
         WHERE p.community_id = $1
           AND p.deleted_at IS NULL
           ${categoryFilter}
         ORDER BY p.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const countParams: unknown[] = [communityId];
      let countFilter = "";
      if (categoryId) {
        countParams.push(categoryId);
        countFilter = `AND community_category_id = $${countParams.length}`;
      }

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM posts
         WHERE community_id = $1 AND deleted_at IS NULL ${countFilter}`,
        countParams,
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
  },
);

// ===========================================================================
// POST /api/posts — publica uma discussão
// ===========================================================================

const createPostSchema = z.object({
  communityId: z.string().uuid("Comunidade inválida"),
  communityCategoryId: z.string().uuid().nullish(),
  title: z
    .string()
    .trim()
    .min(3, "Título deve ter no mínimo 3 caracteres")
    .max(200, "Título deve ter no máximo 200 caracteres"),
  content: z
    .string()
    .trim()
    .min(1, "Conteúdo obrigatório")
    .max(10_000, "Conteúdo muito longo"),
});

router.post(
  "/posts",
  requireAuth,
  rateLimit({ name: "create-post", limit: 10, windowMs: 60_000 }),
  requireMembership((req) => {
    const parsed = createPostSchema.safeParse(req.body);
    return parsed.success ? parsed.data.communityId : undefined;
  }),
  async (req, res, next) => {
    try {
      const data = createPostSchema.parse(req.body);
      const postId = randomUUID();

      await pool.query(
        `INSERT INTO posts
           (post_id, community_id, community_category_id, author_id, title, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          postId,
          data.communityId,
          data.communityCategoryId ?? null,
          req.userId,
          data.title,
          data.content,
        ],
      );

      // Devolve o post no mesmo formato do GET para o frontend inserir na lista
      // sem precisar de um segundo fetch nem remontar o objeto no cliente.
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
           cc.slug             AS category_slug,
           FALSE               AS liked_by_me
         FROM posts p
         INNER JOIN users u           ON u.user_id  = p.author_id
         LEFT  JOIN user_profiles up  ON up.user_id = p.author_id
         LEFT  JOIN community_categories cc
               ON cc.community_category_id = p.community_category_id
         WHERE p.post_id = $1`,
        [postId],
      );

      res.status(201).json({ post: rows[0] });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Dados inválidos", details: err.flatten() });
      }
      if ((err as { code?: string }).code === "23503") {
        return res
          .status(400)
          .json({ error: "Comunidade ou categoria inválida" });
      }
      next(err);
    }
  },
);

export default router;
