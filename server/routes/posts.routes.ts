import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";
import {
  deleteImageByUrl,
  isStorageEnabled,
  uploadImage,
  validateImage,
} from "../lib/storage.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { requireMembership } from "../middleware/membership.js";
import type { CommunityRole } from "../middleware/community-role.js";
import { rateLimit } from "../lib/rate-limit.js";
import { removePost } from "../lib/moderation.js";
import { addPoints, POINTS } from "../lib/points.js";
import { notifyMentions } from "../lib/mentions.js";
import { NSFW_FORBIDDEN, isAdult, nsfwHiddenSql } from "../lib/nsfw.js";

const router = Router();

const listPostsParams = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

const listPostsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  categoryId: z.string().uuid().optional(),
  // "Ajudar os outros": perguntas sem resposta aceita.
  unanswered: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  sort: z.enum(["new", "top", "comments", "hot"]).default("new"),
});

/**
 * "Em alta": pontuação por reações e comentários com decaimento pelo tempo,
 * no espírito do Hacker News:
 *
 *   score = (2 × reações + comentários + 1) / (idade em horas + 2) ^ 1.5
 *
 *  - reação vale o dobro do comentário (é o sinal mais comum de "gostei");
 *  - o +1 dá a todo post novo um ponto de partida, para não empatar em zero;
 *  - o +2 nas horas evita divisão por quase zero no primeiro minuto;
 *  - o expoente 1.5 faz um post de ontem precisar de ~10× mais interação
 *    que um de 4 horas atrás para ficar à frente dele.
 *
 * Usa os contadores desnormalizados do post (likes_count soma todas as
 * reações), então é barato: nenhum JOIN extra. Depende de NOW(), por isso
 * não tem índice e a ordem pode mudar levemente entre uma página e outra.
 */
const HOT_SCORE = `
  ((p.likes_count * 2 + p.comments_count + 1)::float8
   / power(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 + 2, 1.5))`;

/** Fixados primeiro (o mais recente no topo), em qualquer ordenação. */
const PINNED_FIRST = "(p.pinned_at IS NOT NULL) DESC, p.pinned_at DESC";

/** ORDER BY de cada ordenação — strings fixas, nunca vindas da requisição. */
const SORT_ORDER: Record<"new" | "top" | "comments" | "hot", string> = {
  new: "p.created_at DESC, p.post_id DESC",
  top: "p.likes_count DESC, p.created_at DESC, p.post_id DESC",
  comments: "p.comments_count DESC, p.created_at DESC, p.post_id DESC",
  hot: `${HOT_SCORE} DESC, p.created_at DESC, p.post_id DESC`,
};

const postIdParam = z.object({
  postId: z.string().uuid("ID de post inválido"),
});

/**
 * Formato único de post para listagem, criação e edição — o front insere ou
 * substitui na lista sem remontar o objeto. $1 é o usuário atual (ou null),
 * usado no liked_by_me / my_reaction e no viewer_role.
 *
 * likes_count é o total de reações de qualquer tipo; reaction_counts traz a
 * contagem por tipo ({ "like": 3, "love": 1 }) e my_reaction a de quem vê.
 *
 * author_role desenha o selo "Dono"/"Moderador"; viewer_role diz ao front se
 * quem vê pode moderar o post (a regra final continua no DELETE).
 */
const POST_SELECT = `
  SELECT
    p.post_id,
    p.title,
    -- +18 para quem não pode ver: sem conteúdo nem imagens, só o título.
    CASE WHEN nsfw.hidden THEN '' ELSE p.content END AS content,
    (p.is_nsfw OR cm.is_nsfw) AS is_nsfw,
    nsfw.hidden AS nsfw_hidden,
    p.is_nsfw AS post_is_nsfw,
    p.likes_count,
    p.comments_count,
    p.created_at,
    p.edited_at,
    p.pinned_at,
    p.resolved_comment_id,
    p.community_category_id,
    p.community_id,
    cm.name             AS community_name,
    u.user_id           AS author_id,
    u.username          AS author_username,
    up.display_name     AS author_display_name,
    up.avatar_url       AS author_avatar_url,
    cc.name             AS category_name,
    cc.slug             AS category_slug,
    (SELECT r.role FROM community_members r
     WHERE r.community_id = p.community_id AND r.user_id = p.author_id) AS author_role,
    (SELECT r.role FROM community_members r
     WHERE r.community_id = p.community_id AND r.user_id = $1) AS viewer_role,
    EXISTS (
      SELECT 1 FROM post_reactions r
      WHERE r.post_id = p.post_id AND r.user_id = $1
    ) AS liked_by_me,
    (SELECT r.type FROM post_reactions r
     WHERE r.post_id = p.post_id AND r.user_id = $1) AS my_reaction,
    (SELECT COALESCE(jsonb_object_agg(rc.type, rc.n), '{}'::jsonb)
     FROM (SELECT r.type, COUNT(*)::int AS n FROM post_reactions r
           WHERE r.post_id = p.post_id GROUP BY r.type) rc) AS reaction_counts,
    EXISTS (
      SELECT 1 FROM saved_posts s WHERE s.post_id = p.post_id AND s.user_id = $1
    ) AS saved_by_me,
    EXISTS (
      SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_id = p.author_id
    ) AS author_blocked_by_me,
    CASE WHEN nsfw.hidden THEN '[]'::jsonb ELSE (SELECT COALESCE(
       jsonb_agg(jsonb_build_object('image_id', pi.image_id, 'url', pi.url)
                 ORDER BY pi.position, pi.created_at),
       '[]'::jsonb)
     FROM post_images pi WHERE pi.post_id = p.post_id) END AS images
  FROM posts p
  INNER JOIN communities cm    ON cm.community_id = p.community_id
  CROSS JOIN LATERAL (SELECT ${nsfwHiddenSql("$1")} AS hidden) nsfw
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


// ===========================================================================
// GET /api/communities/:communityId/posts
// ===========================================================================

router.get(
  "/communities/:communityId/posts",
  optionalAuth,
  async (req, res, next) => {
    try {
      const { communityId } = listPostsParams.parse(req.params);
      const { page, limit, categoryId, unanswered, sort } = listPostsQuery.parse(req.query);
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
        filters.push("p.resolved_comment_id IS NULL");
      }
      const where = filters.join(" AND ");

      // req.userId é opcional aqui: sem sessão, liked_by_me é sempre false.
      const params = [req.userId ?? null, ...filterParams, limit, offset];
      const { rows } = await pool.query(
        `${POST_SELECT}
         WHERE ${where}
         ORDER BY ${PINNED_FIRST}, ${SORT_ORDER[sort]}
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
        sort,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ===========================================================================
// GET /api/feed/following — aba "Seguindo" da home
// ---------------------------------------------------------------------------
// Posts recentes de quem o usuário segue, de todas as comunidades. Todas as
// comunidades do FAMAX são públicas (não existe comunidade fechada), então o
// único filtro é o de sempre: post e comunidade no ar. Mesmo formato e mesma
// paginação do feed da comunidade, para o front reaproveitar post-thread.
// ===========================================================================

const followingFeedQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

router.get("/feed/following", requireAuth, async (req, res, next) => {
  try {
    const { page, limit } = followingFeedQuery.parse(req.query);
    const where = `
      p.deleted_at IS NULL
      AND cm.deleted_at IS NULL
      AND p.author_id IN (SELECT following_id FROM follows WHERE follower_id = $1)`;

    const { rows } = await pool.query(
      `${POST_SELECT}
       WHERE ${where}
       ORDER BY p.created_at DESC, p.post_id DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, (page - 1) * limit],
    );
    const { rows: countRows } = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM posts p
       INNER JOIN communities cm ON cm.community_id = p.community_id
       WHERE ${where}`,
      [req.userId],
    );
    const total = countRows[0].total;

    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

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
  // Post +18 numa comunidade comum (exige is_adult de quem publica).
  isNsfw: z.boolean().default(false),
});

/**
 * Publicar conteúdo +18 — post marcado ou em comunidade +18 — exige
 * is_adult. Devolve a mensagem de erro, ou null.
 */
async function nsfwPublishError(userId: string, communityId: string, isNsfw: boolean): Promise<string | null> {
  const { rows } = await pool.query<{ is_nsfw: boolean }>(
    "SELECT is_nsfw FROM communities WHERE community_id = $1",
    [communityId],
  );
  if (!isNsfw && !rows[0]?.is_nsfw) return null;
  return (await isAdult(userId)) ? null : NSFW_FORBIDDEN;
}

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

      const nsfwError = await nsfwPublishError(req.userId!, data.communityId, data.isNsfw);
      if (nsfwError) return res.status(403).json({ error: nsfwError });

      if (
        data.communityCategoryId &&
        !(await categoryBelongs(data.communityCategoryId, data.communityId))
      ) {
        return res
          .status(400)
          .json({ error: "Categoria não pertence a esta comunidade" });
      }

      const postId = randomUUID();

      // Post e pontos do ranking juntos: um não existe sem o outro.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO posts
             (post_id, community_id, community_category_id, author_id, title, content, is_nsfw)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            postId,
            data.communityId,
            data.communityCategoryId ?? null,
            req.userId,
            data.title,
            data.content,
            data.isNsfw,
          ],
        );
        await addPoints(client, {
          userId: req.userId!,
          communityId: data.communityId,
          points: POINTS.postPublished,
        });
        await notifyMentions(client, {
          content: data.content,
          actorId: req.userId!,
          postId,
          communityId: data.communityId,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // Devolve o post no mesmo formato do GET para o frontend inserir na lista
      // sem precisar de um segundo fetch nem remontar o objeto no cliente.
      res.status(201).json({ post: await loadPost(postId, req.userId) });
    } catch (err) {
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
    isNsfw: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "Nada para atualizar");

router.patch("/posts/:postId", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const data = editPostSchema.parse(req.body);

    const { rows } = await pool.query<{ author_id: string; community_id: string; content: string }>(
      "SELECT author_id, community_id, content FROM posts WHERE post_id = $1 AND deleted_at IS NULL",
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
    if (data.isNsfw && !(await isAdult(req.userId))) {
      return res.status(403).json({ error: NSFW_FORBIDDEN });
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
    if (data.isNsfw !== undefined) {
      params.push(data.isNsfw);
      sets.push(`is_nsfw = $${params.length}`);
    }

    // Edição e menções novas juntas: só quem não estava mencionado antes é
    // avisado (corrigir um erro de digitação não repete o aviso).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE posts SET ${sets.join(", ")} WHERE post_id = $1`, params);
      if (data.content !== undefined) {
        await notifyMentions(client, {
          content: data.content,
          previousContent: post.content,
          actorId: req.userId!,
          postId,
          communityId: post.community_id,
        });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ post: await loadPost(postId, req.userId) });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// DELETE /api/posts/:postId — soft delete pelo autor ou pela moderação
// ---------------------------------------------------------------------------
// Comentários e reações ficam no banco; o post some das listagens e o
// requirePostMembership (que filtra deleted_at) passa a recusar comentário e
// curtida nele. Dono e moderadores também removem, respeitando a hierarquia
// (lib/moderation.ts); deleted_by registra quem foi.
// ===========================================================================

router.delete("/posts/:postId", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);

    const result = await removePost(postId, { userId: req.userId! });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/posts/:postId/images — o autor anexa imagens (multipart "images")
// DELETE /api/posts/:postId/images/:imageId — o autor tira uma
// ---------------------------------------------------------------------------
// Até MAX_POST_IMAGES por post, 2MB cada, PNG/JPEG/WebP conferidos pelos
// magic bytes (lib/storage.ts). O post é criado primeiro (JSON) e as imagens
// vêm em seguida: assim não sobra imagem órfã no Storage de um post que
// nunca chegou a existir.
//
// Tudo é validado ANTES de subir qualquer arquivo — limite, tipo e tamanho —
// para um lote com uma imagem ruim não deixar as outras pela metade.
// ===========================================================================

const MAX_POST_IMAGES = 4;
const MAX_POST_IMAGE_BYTES = 2 * 1024 * 1024;

const imagesUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_POST_IMAGE_BYTES,
    files: MAX_POST_IMAGES,
    fieldArrayIndexLimit: 0,
  },
});

const imageIdParam = z.object({
  postId: z.string().uuid("ID de post inválido"),
  imageId: z.string().uuid("ID de imagem inválido"),
});

/** Post vivo do usuário, com quantas imagens já tem; null se não for dele. */
async function ownPostImages(postId: string, userId: string) {
  const { rows } = await pool.query<{ images: number }>(
    `SELECT (SELECT COUNT(*)::int FROM post_images pi WHERE pi.post_id = p.post_id) AS images
     FROM posts p
     WHERE p.post_id = $1 AND p.author_id = $2 AND p.deleted_at IS NULL`,
    [postId, userId],
  );
  return rows[0] ?? null;
}

router.post(
  "/posts/:postId/images",
  requireAuth,
  rateLimit({ name: "post-images", limit: 20, windowMs: 60_000 }),
  imagesUpload.array("images", MAX_POST_IMAGES),
  async (req, res, next) => {
    try {
      const { postId } = postIdParam.parse(req.params);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'Envie as imagens no campo "images"' });
      }

      const post = await ownPostImages(postId, req.userId!);
      if (!post) {
        return res.status(404).json({ error: "Post não encontrado ou não é seu" });
      }
      if (post.images + files.length > MAX_POST_IMAGES) {
        return res.status(400).json({
          error: `Cada post pode ter no máximo ${MAX_POST_IMAGES} imagens (este já tem ${post.images})`,
        });
      }
      for (const file of files) {
        validateImage(file.buffer, { maxBytes: MAX_POST_IMAGE_BYTES, label: "Cada imagem" });
      }
      if (!isStorageEnabled()) {
        return res.status(503).json({ error: "Upload de imagens não está configurado no servidor" });
      }

      const urls: string[] = [];
      for (const file of files) {
        const url = await uploadImage(file.buffer, {
          bucket: config.SUPABASE_USER_MEDIA_BUCKET,
          folder: `posts/${postId}`,
          maxBytes: MAX_POST_IMAGE_BYTES,
          label: "Cada imagem",
        });
        if (url) urls.push(url);
      }

      // position continua de onde parou; a contagem é refeita aqui porque
      // outra aba pode ter anexado algo durante o upload.
      await pool.query(
        `INSERT INTO post_images (image_id, post_id, url, position)
         SELECT u.id, $1, u.url,
                (SELECT COALESCE(MAX(position) + 1, 0) FROM post_images WHERE post_id = $1) + u.ord - 1
         FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS u(id, url, ord)`,
        [postId, urls.map(() => randomUUID()), urls],
      );

      res.status(201).json({ post: await loadPost(postId, req.userId) });
    } catch (err) {
      next(err);
    }
  },
);

router.delete("/posts/:postId/images/:imageId", requireAuth, async (req, res, next) => {
  try {
    const { postId, imageId } = imageIdParam.parse(req.params);
    const { rows } = await pool.query<{ url: string }>(
      `DELETE FROM post_images pi
       USING posts p
       WHERE pi.image_id = $1 AND pi.post_id = $2
         AND p.post_id = pi.post_id AND p.author_id = $3 AND p.deleted_at IS NULL
       RETURNING pi.url`,
      [imageId, postId, req.userId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Imagem não encontrada ou o post não é seu" });
    }
    // Depois do banco: um objeto órfão no Storage é inofensivo (ver storage.ts).
    await deleteImageByUrl(rows[0].url, config.SUPABASE_USER_MEDIA_BUCKET);
    res.json({ post: await loadPost(postId, req.userId) });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/posts/:postId/save — salvar (favoritos)
// DELETE /api/posts/:postId/save — tirar dos salvos
// ---------------------------------------------------------------------------
// Qualquer pessoa com sessão salva qualquer post no ar — não precisa ser
// membro, como não precisa para ler. Idempotentes: salvar o que já está
// salvo (ou tirar o que não está) responde o estado atual.
// ===========================================================================

router.post(
  "/posts/:postId/save",
  requireAuth,
  rateLimit({ name: "save-post", limit: 60, windowMs: 60_000 }),
  async (req, res, next) => {
    try {
      const { postId } = postIdParam.parse(req.params);
      const { rowCount } = await pool.query(
        `INSERT INTO saved_posts (user_id, post_id)
         SELECT $1, p.post_id
         FROM posts p
         INNER JOIN communities c ON c.community_id = p.community_id
         WHERE p.post_id = $2 AND p.deleted_at IS NULL AND c.deleted_at IS NULL
         ON CONFLICT (user_id, post_id) DO NOTHING`,
        [req.userId, postId],
      );
      if (!rowCount) {
        // Nada inserido: ou já estava salvo, ou o post não existe.
        const { rows } = await pool.query(
          "SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2",
          [req.userId, postId],
        );
        if (rows.length === 0) return res.status(404).json({ error: "Post não encontrado" });
      }
      res.json({ saved: true });
    } catch (err) {
      next(err);
    }
  },
);

router.delete("/posts/:postId/save", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    await pool.query("DELETE FROM saved_posts WHERE user_id = $1 AND post_id = $2", [
      req.userId,
      postId,
    ]);
    res.json({ saved: false });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /api/me/saved — aba "Salvos" do próprio perfil
// ---------------------------------------------------------------------------
// Privada: só existe para o usuário logado. Mais recentemente salvos
// primeiro; post apagado (ou em comunidade apagada) some da lista.
// ===========================================================================

const savedQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

router.get("/me/saved", requireAuth, async (req, res, next) => {
  try {
    const { page, limit } = savedQuery.parse(req.query);
    const { rows } = await pool.query(
      `${POST_SELECT}
       INNER JOIN saved_posts sv ON sv.post_id = p.post_id AND sv.user_id = $1
       WHERE p.deleted_at IS NULL AND cm.deleted_at IS NULL
       ORDER BY sv.created_at DESC, p.post_id DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, (page - 1) * limit],
    );
    const { rows: countRows } = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM saved_posts sv
       INNER JOIN posts p        ON p.post_id = sv.post_id
       INNER JOIN communities cm ON cm.community_id = p.community_id
       WHERE sv.user_id = $1 AND p.deleted_at IS NULL AND cm.deleted_at IS NULL`,
      [req.userId],
    );
    const total = countRows[0].total;
    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/posts/:postId/pin — fixar no topo (dono e moderadores)
// DELETE /api/posts/:postId/pin — desafixar
// ---------------------------------------------------------------------------
// Até MAX_PINNED por comunidade. A comunidade é travada (FOR UPDATE) durante
// a contagem: dois moderadores fixando ao mesmo tempo não passam juntos do
// limite. Fixar o que já está fixado não muda nada (nem a ordem).
// ===========================================================================

const MAX_PINNED = 3;

async function staffContext(postId: string, userId: string) {
  const { rows } = await pool.query<{ community_id: string; role: CommunityRole | null }>(
    `SELECT p.community_id,
            (SELECT r.role FROM community_members r
             WHERE r.community_id = p.community_id AND r.user_id = $2) AS role
     FROM posts p
     INNER JOIN communities c ON c.community_id = p.community_id
     WHERE p.post_id = $1 AND p.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [postId, userId],
  );
  return rows[0] ?? null;
}

router.post("/posts/:postId/pin", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const context = await staffContext(postId, req.userId!);
    if (!context) return res.status(404).json({ error: "Post não encontrado" });
    if (context.role !== "owner" && context.role !== "moderator") {
      return res.status(403).json({ error: "Só o dono e os moderadores podem fixar posts" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM communities WHERE community_id = $1 FOR UPDATE", [
        context.community_id,
      ]);
      const { rows } = await client.query<{ pinned: number; already: boolean }>(
        `SELECT COUNT(*)::int AS pinned, BOOL_OR(post_id = $2) AS already
         FROM posts
         WHERE community_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL`,
        [context.community_id, postId],
      );
      if (!rows[0].already) {
        if (rows[0].pinned >= MAX_PINNED) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Esta comunidade já tem ${MAX_PINNED} posts fixados. Desafixe um antes.`,
          });
        }
        await client.query("UPDATE posts SET pinned_at = NOW() WHERE post_id = $1", [postId]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ post: await loadPost(postId, req.userId) });
  } catch (err) {
    next(err);
  }
});

router.delete("/posts/:postId/pin", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const context = await staffContext(postId, req.userId!);
    if (!context) return res.status(404).json({ error: "Post não encontrado" });
    if (context.role !== "owner" && context.role !== "moderator") {
      return res.status(403).json({ error: "Só o dono e os moderadores podem desafixar posts" });
    }
    await pool.query("UPDATE posts SET pinned_at = NULL WHERE post_id = $1", [postId]);
    res.json({ post: await loadPost(postId, req.userId) });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// PUT /api/posts/:postId/resolution — o autor marca a resposta aceita
// DELETE /api/posts/:postId/resolution — desmarca
// ---------------------------------------------------------------------------
// Só o autor do post decide, e só entre os comentários vivos do próprio post
// (qualquer um, inclusive resposta a outro comentário). Marcar outro troca a
// resposta aceita. Post de outra pessoa responde como inexistente, igual ao
// PATCH do post.
// ===========================================================================

const resolutionSchema = z.object({
  commentId: z.string().uuid("Comentário inválido"),
});

router.put("/posts/:postId/resolution", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const { commentId } = resolutionSchema.parse(req.body);

    const { rows } = await pool.query<{ author_id: string; comment_ok: boolean }>(
      `SELECT p.author_id,
              EXISTS (
                SELECT 1 FROM comments c
                WHERE c.comment_id = $2 AND c.post_id = p.post_id AND c.deleted_at IS NULL
              ) AS comment_ok
       FROM posts p
       WHERE p.post_id = $1 AND p.deleted_at IS NULL`,
      [postId, commentId],
    );
    const post = rows[0];
    if (!post || post.author_id !== req.userId) {
      return res.status(404).json({ error: "Post não encontrado ou não é seu" });
    }
    if (!post.comment_ok) {
      return res.status(400).json({ error: "Comentário não encontrado neste post" });
    }

    await pool.query("UPDATE posts SET resolved_comment_id = $2 WHERE post_id = $1", [
      postId,
      commentId,
    ]);
    res.json({ post: await loadPost(postId, req.userId) });
  } catch (err) {
    next(err);
  }
});

router.delete("/posts/:postId/resolution", requireAuth, async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const { rowCount } = await pool.query(
      `UPDATE posts SET resolved_comment_id = NULL
       WHERE post_id = $1 AND author_id = $2 AND deleted_at IS NULL`,
      [postId, req.userId],
    );
    if (!rowCount) {
      return res.status(404).json({ error: "Post não encontrado ou não é seu" });
    }
    res.json({ post: await loadPost(postId, req.userId) });
  } catch (err) {
    next(err);
  }
});

export default router;
