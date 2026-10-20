import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePostMembership } from "../middleware/membership.js";
import { rateLimit } from "../lib/rate-limit.js";
import { removeComment } from "../lib/moderation.js";
import { notify } from "../lib/notify.js";
import { addPoints, POINTS } from "../lib/points.js";
import { notifyMentions } from "../lib/mentions.js";

const router = Router();

const postIdParam = z.object({
  postId: z.string().uuid("ID de post inválido"),
});

const commentIdParam = z.object({
  commentId: z.string().uuid("ID de comentário inválido"),
});

const listQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const contentSchema = z
  .string()
  .trim()
  .min(1, "Comentário vazio")
  .max(2000, "Comentário deve ter no máximo 2000 caracteres");

const COMMENT_SELECT = `
  SELECT
    c.comment_id,
    c.post_id,
    c.parent_comment_id,
    c.content,
    c.created_at,
    c.edited_at,
    c.deleted_at,
    u.user_id       AS author_id,
    u.username      AS author_username,
    up.display_name AS author_display_name,
    up.avatar_url   AS author_avatar_url,
    (SELECT r.role FROM community_members r
     INNER JOIN posts rp ON rp.community_id = r.community_id
     WHERE rp.post_id = c.post_id AND r.user_id = c.author_id) AS author_role
  FROM comments c
  INNER JOIN users u          ON u.user_id  = c.author_id
  LEFT  JOIN user_profiles up ON up.user_id = c.author_id
`;

type CommentRow = {
  comment_id: string;
  post_id: string;
  parent_comment_id: string | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  author_id: string;
  author_username: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  author_role: string | null;
};

/**
 * Formato público de um comentário. Apagado vira "[comentário removido]" sem
 * autor nem texto: aparece só para a conversa embaixo dele não ficar órfã.
 */
function present(row: CommentRow, repliesCount = 0) {
  const deleted = row.deleted_at !== null;
  return {
    comment_id: row.comment_id,
    post_id: row.post_id,
    parent_comment_id: row.parent_comment_id,
    content: deleted ? null : row.content,
    created_at: row.created_at,
    edited_at: deleted ? null : row.edited_at,
    is_deleted: deleted,
    replies_count: repliesCount,
    author_id: deleted ? null : row.author_id,
    author_username: deleted ? null : row.author_username,
    author_display_name: deleted ? null : row.author_display_name,
    author_avatar_url: deleted ? null : row.author_avatar_url,
    author_role: deleted ? null : row.author_role,
  };
}

/** Cursor opaco: o created_at exato (texto, com microssegundos) + o id. */
function encodeCursor(createdAt: string, commentId: string): string {
  return Buffer.from(`${createdAt}|${commentId}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; commentId: string } | null {
  const [createdAt, commentId] = Buffer.from(cursor, "base64url").toString().split("|");
  const valid =
    createdAt &&
    !Number.isNaN(Date.parse(createdAt)) &&
    z.string().uuid().safeParse(commentId).success;
  return valid ? { createdAt, commentId } : null;
}

// ===========================================================================
// GET /api/posts/:postId/comments
// ---------------------------------------------------------------------------
// Lista PLANA com parent_comment_id e replies_count; a árvore é montada no
// front. Plana porque o front precisa de qualquer jeito achar um comentário
// por id (responder, editar, excluir) e a lista simples é mais fácil de
// paginar e de serializar do que um JSON aninhado.
//
// Paginação por cursor sobre os comentários RAIZ (mais antigos primeiro).
// Cada página traz as raízes e todas as respostas delas, em qualquer nível:
// uma conversa nunca chega pela metade. Cursor e não OFFSET porque novos
// comentários entrando entre uma página e outra deslocariam o OFFSET e
// repetiriam ou pulariam itens.
// ===========================================================================

router.get("/posts/:postId/comments", async (req, res, next) => {
  try {
    const { postId } = postIdParam.parse(req.params);
    const { cursor, limit } = listQuery.parse(req.query);

    const { rows: post } = await pool.query(
      "SELECT 1 FROM posts WHERE post_id = $1 AND deleted_at IS NULL",
      [postId],
    );
    if (post.length === 0) {
      return res.status(404).json({ error: "Post não encontrado" });
    }

    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) {
      return res.status(400).json({ error: "Cursor inválido" });
    }

    // Raiz apagada só entra se tiver resposta — senão não há conversa a
    // preservar. limit + 1 para saber se existe próxima página.
    const { rows: roots } = await pool.query<{ comment_id: string; created_at_text: string }>(
      `SELECT c.comment_id, c.created_at::text AS created_at_text
       FROM comments c
       WHERE c.post_id = $1
         AND c.parent_comment_id IS NULL
         AND (
           c.deleted_at IS NULL
           OR EXISTS (SELECT 1 FROM comments r WHERE r.parent_comment_id = c.comment_id)
         )
         AND ($2::timestamptz IS NULL OR (c.created_at, c.comment_id) > ($2::timestamptz, $3::uuid))
       ORDER BY c.created_at ASC, c.comment_id ASC
       LIMIT $4`,
      [postId, after?.createdAt ?? null, after?.commentId ?? null, limit + 1],
    );

    const hasMore = roots.length > limit;
    const pageRoots = roots.slice(0, limit);
    const last = pageRoots[pageRoots.length - 1];

    // As raízes da página e toda a descendência delas.
    const { rows } = pageRoots.length
      ? await pool.query<CommentRow>(
          `WITH RECURSIVE tree AS (
             SELECT comment_id FROM comments WHERE comment_id = ANY($1::uuid[])
             UNION ALL
             SELECT c.comment_id
             FROM comments c
             INNER JOIN tree t ON c.parent_comment_id = t.comment_id
           )
           ${COMMENT_SELECT}
           WHERE c.comment_id IN (SELECT comment_id FROM tree)
           ORDER BY c.created_at ASC, c.comment_id ASC`,
          [pageRoots.map((r) => r.comment_id)],
        )
      : { rows: [] as CommentRow[] };

    // Poda: um comentário apagado fica só se algum descendente ficar. Ordem
    // reversa de criação = filhos antes dos pais (resposta é sempre mais nova
    // que o comentário respondido), então uma passada resolve.
    const kept = new Set<string>();
    const keptChildren = new Map<string, number>();
    for (const row of [...rows].reverse()) {
      const children = keptChildren.get(row.comment_id) ?? 0;
      if (row.deleted_at === null || children > 0) {
        kept.add(row.comment_id);
        if (row.parent_comment_id) {
          keptChildren.set(
            row.parent_comment_id,
            (keptChildren.get(row.parent_comment_id) ?? 0) + 1,
          );
        }
      }
    }

    res.json({
      data: rows
        .filter((row) => kept.has(row.comment_id))
        .map((row) => present(row, keptChildren.get(row.comment_id) ?? 0)),
      nextCursor: hasMore && last ? encodeCursor(last.created_at_text, last.comment_id) : null,
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
  content: contentSchema,
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

      // Avisos na mesma transação. Quem foi respondido recebe "respondeu";
      // o autor do post recebe "comentou" — uma vez só, se for a mesma pessoa.
      const { rows: targets } = await client.query<{
        post_author: string;
        community_id: string;
        parent_author: string | null;
      }>(
        `SELECT p.author_id AS post_author, p.community_id,
                (SELECT c.author_id FROM comments c WHERE c.comment_id = $2) AS parent_author
         FROM posts p WHERE p.post_id = $1`,
        [postId, data.parentCommentId ?? null],
      );
      const target = targets[0];
      if (target) {
        const base = { actorId: req.userId!, postId, commentId, communityId: target.community_id };
        if (target.parent_author) {
          await notify(client, { ...base, userId: target.parent_author, type: "comment_reply" });
        }
        if (target.post_author !== target.parent_author) {
          await notify(client, { ...base, userId: target.post_author, type: "post_comment" });
        }
        // Menções: quem já foi avisado como respondido ou autor do post não
        // recebe um segundo aviso pela mesma ação.
        await notifyMentions(client, {
          content: data.content,
          actorId: req.userId!,
          postId,
          commentId,
          communityId: target.community_id,
          skip: [target.post_author, target.parent_author].filter((id): id is string => Boolean(id)),
        });
        // Comentar no próprio post não rende pontos.
        if (target.post_author !== req.userId) {
          await addPoints(client, {
            userId: target.post_author,
            communityId: target.community_id,
            points: POINTS.commentReceived,
          });
        }
      }

      await client.query("COMMIT");

      // Já devolve autor resolvido para o frontend renderizar sem novo fetch.
      const { rows } = await client.query<CommentRow>(
        `${COMMENT_SELECT} WHERE c.comment_id = $1`,
        [commentId],
      );

      res.status(201).json({ comment: present(rows[0]) });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: err.issues[0]?.message ?? "Dados inválidos", details: err.flatten() });
      }
      next(err);
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// PATCH /api/comments/:commentId — o autor edita o próprio comentário
// ===========================================================================

router.patch("/comments/:commentId", requireAuth, async (req, res, next) => {
  try {
    const { commentId } = commentIdParam.parse(req.params);
    const { content } = z.object({ content: contentSchema }).parse(req.body);

    // Autoria, comentário vivo e post vivo no próprio WHERE: qualquer um que
    // falhe responde igual (não confirma que o comentário existe). O texto
    // anterior volta no RETURNING para avisar só as menções novas.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: edited } = await client.query<{
        previous: string;
        post_id: string;
        community_id: string;
      }>(
        `UPDATE comments c
         SET content = $3, edited_at = NOW()
         FROM posts p, comments old
         WHERE c.comment_id = $1
           AND c.author_id = $2
           AND c.deleted_at IS NULL
           AND p.post_id = c.post_id
           AND p.deleted_at IS NULL
           AND old.comment_id = c.comment_id
         RETURNING old.content AS previous, c.post_id, p.community_id`,
        [commentId, req.userId, content],
      );
      if (edited.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Comentário não encontrado ou não é seu" });
      }
      await notifyMentions(client, {
        content,
        previousContent: edited[0].previous,
        actorId: req.userId!,
        postId: edited[0].post_id,
        commentId,
        communityId: edited[0].community_id,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query<CommentRow>(`${COMMENT_SELECT} WHERE c.comment_id = $1`, [
      commentId,
    ]);
    const { rows: replies } = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM comments WHERE parent_comment_id = $1 AND deleted_at IS NULL",
      [commentId],
    );
    res.json({ comment: present(rows[0], replies[0].n) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: err.issues[0]?.message ?? "Dados inválidos", details: err.flatten() });
    }
    next(err);
  }
});

// ===========================================================================
// DELETE /api/comments/:commentId — soft delete pelo autor ou pela moderação
// ---------------------------------------------------------------------------
// As respostas continuam; na listagem o comentário vira "[comentário
// removido]" enquanto houver resposta pendurada nele. Dono e moderadores da
// comunidade também removem (lib/moderation.ts).
// ===========================================================================

router.delete("/comments/:commentId", requireAuth, async (req, res, next) => {
  try {
    const { commentId } = commentIdParam.parse(req.params);

    const result = await removeComment(commentId, { userId: req.userId! });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(204).end();
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "ID de comentário inválido" });
    }
    next(err);
  }
});

export default router;
