import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePostMembership } from "../middleware/membership.js";
import { rateLimit } from "../lib/rate-limit.js";
import { notify, unnotifyLike } from "../lib/notify.js";
import { addPoints, POINTS } from "../lib/points.js";

const router = Router();

/** Tipos aceitos (mesma lista do reaction_type_enum, migration 018). */
export const REACTION_TYPES = ["like", "love", "haha", "wow", "sad"] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

const postIdParam = z.object({
  postId: z.string().uuid("ID de post inválido"),
});

// Corpo opcional: sem type, o botão principal (curtir / desfazer).
const reactionBody = z
  .object({
    type: z.enum(REACTION_TYPES, { errorMap: () => ({ message: "Reação inválida" }) }).optional(),
  })
  .default({});

// ===========================================================================
// POST /api/posts/:postId/reactions — reagir, trocar ou desfazer
// ===========================================================================
//
// Uma reação por pessoa por post (UNIQUE (post_id, user_id), migration 018):
//
//   sem reação        + qualquer pedido  → cria (type, ou like sem type)
//   reação X          + type X ou sem type → desfaz (o botão é um toggle)
//   reação X          + type Y            → troca para Y
//
// A troca não mexe em pontos nem na notificação: para o autor do post
// continua sendo "uma pessoa reagiu". O created_at original também fica,
// para que desfazer depois devolva os pontos na semana certa.
//
// A linha da reação é travada (FOR UPDATE) antes de decidir: duplo clique
// ou duas abas não produzem reação duplicada nem pontos dados duas vezes.
//
// O likes_count (total de reações) é recalculado com COUNT(*) em vez de ±1:
// custa um índice scan a mais, mas se autocorrige se algo dessincronizar.
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
      const { type: requested } = reactionBody.parse(req.body ?? {});

      await client.query("BEGIN");

      const { rows: postRows } = await client.query<{ author_id: string; community_id: string }>(
        "SELECT author_id, community_id FROM posts WHERE post_id = $1",
        [postId],
      );
      const post = postRows[0];
      // Reagir ao próprio post não rende pontos.
      const earnsPoints = post.author_id !== req.userId;

      const { rows: existingRows } = await client.query<{ type: ReactionType; created_at: Date }>(
        `SELECT type, created_at FROM post_reactions
         WHERE post_id = $1 AND user_id = $2
         FOR UPDATE`,
        [postId, req.userId],
      );
      const existing = existingRows[0];

      let reaction: ReactionType | null;
      if (existing && (!requested || requested === existing.type)) {
        // Desfazer: sem "Fulano curtiu" de uma reação que não existe, e os
        // pontos voltam na semana em que a reação foi dada.
        await client.query("DELETE FROM post_reactions WHERE post_id = $1 AND user_id = $2", [
          postId,
          req.userId,
        ]);
        await unnotifyLike(client, postId, req.userId!);
        if (earnsPoints) {
          await addPoints(client, {
            userId: post.author_id,
            communityId: post.community_id,
            points: -POINTS.reactionReceived,
            at: existing.created_at,
          });
        }
        reaction = null;
      } else if (existing) {
        await client.query(
          "UPDATE post_reactions SET type = $3 WHERE post_id = $1 AND user_id = $2",
          [postId, req.userId, requested],
        );
        reaction = requested!;
      } else {
        reaction = requested ?? "like";
        await client.query(
          `INSERT INTO post_reactions (reaction_id, post_id, user_id, type)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), postId, req.userId, reaction],
        );
        if (earnsPoints) {
          await addPoints(client, {
            userId: post.author_id,
            communityId: post.community_id,
            points: POINTS.reactionReceived,
          });
        }
        await notify(client, {
          userId: post.author_id,
          type: "post_like",
          actorId: req.userId!,
          postId,
          communityId: post.community_id,
        });
      }

      const { rows } = await client.query<{ likes_count: number; reaction_counts: Record<string, number> }>(
        `UPDATE posts
         SET likes_count = (SELECT COUNT(*) FROM post_reactions WHERE post_id = $1)
         WHERE post_id = $1
         RETURNING likes_count,
           (SELECT COALESCE(jsonb_object_agg(type, n), '{}'::jsonb)
            FROM (SELECT type, COUNT(*)::int AS n FROM post_reactions
                  WHERE post_id = $1 GROUP BY type) counts) AS reaction_counts`,
        [postId],
      );

      await client.query("COMMIT");

      res.json({
        liked: reaction !== null,
        reaction,
        likesCount: rows[0]?.likes_count ?? 0,
        reactionCounts: rows[0]?.reaction_counts ?? {},
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues[0]?.message ?? "Dados inválidos" });
      }
      // Corrida rara: duas abas criando a primeira reação ao mesmo tempo (o
      // FOR UPDATE não trava uma linha que ainda não existe).
      if ((err as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "Reação já registrada, tente de novo" });
      }
      next(err);
    } finally {
      client.release();
    }
  },
);

export default router;
