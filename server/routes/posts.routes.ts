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
  // "Ajudar os outros": posts que ainda não têm nenhum comentário.
  unanswered: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const postIdParam = z.object({
  postId: z.string().uuid("ID de post inválido"),
});

/**
 * Formato único de post para listagem, criação e edição — o front insere ou
 * substitui na lista sem remontar o objeto. $1 é o usuário atual (ou null),
 * usado só no liked_by_me.
 */
const POST_SELECT = `
  SELECT
    p.post_id,
    p.title,
    p.content,
    p.likes_count,
    p.comments_count,
    p.created_at,
    p.edited_at,
    p.community_category_id,
    p.community_id,
    cm.name             AS community_name,
    u.user_id           AS author_id,
    u.username          AS author_username,
    up.display_name     AS author_display_name,
    up.avatar_url       AS author_avatar_url,
    cc.name             AS category_name,
    cc.slug             AS category_slug,
    EXISTS (
      SELECT 1 FROM post_reactions r
      WHERE r.post_id = p.post_id
        AND r.user_id = $1
        AND r.type = 'like'
    ) AS liked_by_me
  FROM posts p
  INNER JOIN communities cm    ON cm.community_id = p.community_id
  INNER JOIN users u           ON u.user_id  = p.author_id
  LEFT  JOIN user_profiles up  ON up.user_id = p.author_id
  LEFT  JOIN community_categories cc
        ON cc.community_category_id = p.community_category_id
`;

async function loadPost(postId: string, viewerId: string | undefined) {
  const { rows } = await pool.query(`${POST_SELECT} WHERE p.post_id = $2`, [
    viewerId ?? null,
    postId,
  ]);
  return rows[0];
}

function zodError(res: import("express").Response, err: z.ZodError, label: string) {
  return res
    .status(400)
    .json({ error: err.issues[0]?.message ?? label, details: err.flatten() });
}

// ===========================================================================
// GET /api/communities/:communityId/posts
// ===========================================================================

router.get(
  "/communities/:communityId/posts",
  optionalAuth,
  async (req, res, next) => {
    try {
      const { communityId } = listPostsParams.parse(req.params);
      const { page, limit, categoryId, unanswered } = listPostsQuery.parse(req.query);
      const offset = (page - 1) * limit;

      // Os filtros valem igual para a página e para a contagem; montados uma
      // vez, com os parâmetros começando depois do $1 (viewer) do POST_SELECT.
      const filterParams: unknown[] = [communityId];
      const filters = ["p.community_id = $2", "p.deleted_at IS NULL"];
      if (categoryId) {
        filterParams.push(categoryId);
        filters.push(`p.community_category_id = $${filterParams.length + 1}`);
      }
      if (unanswered) {
        filters.push("p.comments_count = 0");
      }
      const where = filters.join(" AND ");

      // req.userId é opcional aqui: sem sessão, liked_by_me é sempre false.
      const params = [req.userId ?? null, ...filterParams, limit, offset];
      const { rows } = await pool.query(
        `${POST_SELECT}
         WHERE ${where}
         ORDER BY p.created_at DESC, p.post_id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      // A contagem reaproveita o mesmo WHERE (que numera a partir de $2). O
      // $1 só é declarado para a numeração bater — o Postgres recusa
      // parâmetro enviado e não referenciado.
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM posts p
         WHERE $1::uuid IS NULL AND ${where}`,
        [null, ...filterParams],
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
      if (err instanceof z.ZodError) return zodError(res, err, "Parâmetros inválidos");
      next(err);
    }
  },
);

// ===========================================================================
// GET /api/posts/:postId — página individual do post
// ---------------------------------------------------------------------------
// Mesmo formato do feed (POST_SELECT), já com o nome da comunidade para o
// breadcrumb. Post excluído — ou em comunidade excluída — é 404.
// ===========================================================================

router.get("/posts/:postId", optionalAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const { rows } = await pool.query(
      `${POST_SELECT}
       WHERE p.post_id = $2 AND p.deleted_at IS NULL AND cm.deleted_at IS NULL`,
      [req.userId ?? null, postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Post não encontrado" });
    }
    res.json({ post: rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err, "ID de post inválido");
    next(err);
  }
});

// ===========================================================================
// POST /api/posts — publica uma discussão
// ===========================================================================

const titleSchema = z
  .string()
  .trim()
  .min(3, "Título deve ter no mínimo 3 caracteres")
  .max(200, "Título deve ter no máximo 200 caracteres");

const contentSchema = z
  .string()
  .trim()
  .min(1, "Conteúdo obrigatório")
  .max(10_000, "Conteúdo muito longo");

const createPostSchema = z.object({
  communityId: z.string().uuid("Comunidade inválida"),
  communityCategoryId: z.string().uuid().nullish(),
  title: titleSchema,
  content: contentSchema,
});

/**
 * A FK só garante que a subcategoria existe, não que é desta comunidade: sem
 * esta checagem dava para publicar na comunidade A usando uma subcategoria da
 * comunidade B.
 */
async function categoryBelongs(categoryId: string, communityId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM community_categories
     WHERE community_category_id = $1 AND community_id = $2`,
    [categoryId, communityId],
  );
  return rows.length > 0;
}

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

      if (
        data.communityCategoryId &&
        !(await categoryBelongs(data.communityCategoryId, data.communityId))
      ) {
        return res
          .status(400)
          .json({ error: "Categoria não pertence a esta comunidade" });
      }

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
      res.status(201).json({ post: await loadPost(postId, req.userId) });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err, "Dados inválidos");
      if ((err as { code?: string }).code === "23503") {
        return res
          .status(400)
          .json({ error: "Comunidade ou categoria inválida" });
      }
      next(err);
    }
  },
);

// ===========================================================================
// PATCH /api/posts/:postId — autor edita título, conteúdo e subcategoria
// ===========================================================================

const editPostSchema = z
  .object({
    title: titleSchema.optional(),
    content: contentSchema.optional(),
    communityCategoryId: z.string().uuid("Categoria inválida").nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "Nada para atualizar");

router.patch("/posts/:postId", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const data = editPostSchema.parse(req.body);

    const { rows } = await pool.query<{ author_id: string; community_id: string }>(
      "SELECT author_id, community_id FROM posts WHERE post_id = $1 AND deleted_at IS NULL",
      [postId],
    );
    const post = rows[0];
    // Post de outra pessoa responde como inexistente: não confirma nada.
    if (!post || post.author_id !== req.userId) {
      return res.status(404).json({ error: "Post não encontrado ou não é seu" });
    }

    if (
      data.communityCategoryId &&
      !(await categoryBelongs(data.communityCategoryId, post.community_id))
    ) {
      return res.status(400).json({ error: "Categoria não pertence a esta comunidade" });
    }

    const sets = ["edited_at = NOW()"];
    const params: unknown[] = [postId];
    if (data.title !== undefined) {
      params.push(data.title);
      sets.push(`title = $${params.length}`);
    }
    if (data.content !== undefined) {
      params.push(data.content);
      sets.push(`content = $${params.length}`);
    }
    if (data.communityCategoryId !== undefined) {
      params.push(data.communityCategoryId);
      sets.push(`community_category_id = $${params.length}`);
    }

    await pool.query(`UPDATE posts SET ${sets.join(", ")} WHERE post_id = $1`, params);

    res.json({ post: await loadPost(postId, req.userId) });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err, "Dados inválidos");
    next(err);
  }
});

// ===========================================================================
// DELETE /api/posts/:postId — soft delete pelo autor
// ---------------------------------------------------------------------------
// Comentários e reações ficam no banco; o post some das listagens e o
// requirePostMembership (que filtra deleted_at) passa a recusar comentário e
// curtida nele. O prompt de moderação estende a regra para moderadores.
// ===========================================================================

router.delete("/posts/:postId", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);

    // O UPDATE condicional é a própria autorização.
    const { rowCount } = await pool.query(
      `UPDATE posts SET deleted_at = NOW()
       WHERE post_id = $1 AND author_id = $2 AND deleted_at IS NULL`,
      [postId, req.userId],
    );
    if (!rowCount) {
      return res.status(404).json({ error: "Post não encontrado ou não é seu" });
    }

    res.status(204).end();
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err, "ID de post inválido");
    next(err);
  }
});

export default router;
