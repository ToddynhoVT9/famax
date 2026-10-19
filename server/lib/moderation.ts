import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { outranks, type CommunityRole } from "../middleware/community-role.js";

/**
 * Remoção de conteúdo e banimento, compartilhados entre as rotas diretas
 * (DELETE do post/comentário, POST de ban) e a resolução de denúncias — as
 * duas precisam da mesma hierarquia e do mesmo registro de quem agiu.
 *
 * Cada função devolve { ok: true, ... } ou { ok: false, status, error } para a
 * rota responder; nenhuma escreve na Response.
 */

export type Failure = { ok: false; status: number; error: string };

/**
 * Admin do site age como dono em qualquer comunidade (resolução de denúncia
 * pela fila do admin). Fora disso vale o papel na comunidade.
 */
export type Actor = { userId: string; isAdmin?: boolean };

function effectiveRole(actor: Actor, role: CommunityRole | null): CommunityRole | null {
  return actor.isAdmin ? "owner" : role;
}

/** Denúncias abertas sobre o alvo viram resolvidas com a ação tomada. */
async function closeOpenReports(
  client: PoolClient,
  targetType: "post" | "comment" | "user",
  targetId: string,
  actorId: string,
  resolution: string,
): Promise<void> {
  await client.query(
    `UPDATE reports
     SET status = 'resolved', resolution = $4, resolved_by = $3, resolved_at = NOW()
     WHERE target_type = $1 AND target_id = $2 AND status IN ('pending', 'reviewing')`,
    [targetType, targetId, actorId, resolution],
  );
}

const DENIED_MODERATOR =
  "Moderadores não podem remover conteúdo do dono nem de outro moderador";

// ===========================================================================
// Posts
// ===========================================================================

export async function removePost(
  postId: string,
  actor: Actor,
): Promise<{ ok: true; byModerator: boolean } | Failure> {
  const { rows } = await pool.query<{
    author_id: string;
    actor_role: CommunityRole | null;
    author_role: CommunityRole | null;
  }>(
    `SELECT
       p.author_id,
       (SELECT role FROM community_members
        WHERE community_id = p.community_id AND user_id = $2) AS actor_role,
       (SELECT role FROM community_members
        WHERE community_id = p.community_id AND user_id = p.author_id) AS author_role
     FROM posts p
     INNER JOIN communities c ON c.community_id = p.community_id
     WHERE p.post_id = $1 AND p.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [postId, actor.userId],
  );
  const post = rows[0];
  if (!post) return { ok: false, status: 404, error: "Post não encontrado" };

  const isAuthor = post.author_id === actor.userId;
  const role = effectiveRole(actor, post.actor_role);
  if (!isAuthor && !outranks(role, post.author_role)) {
    // Membro comum recebe o mesmo 404 de antes: não confirma nada.
    return role === "owner" || role === "moderator"
      ? { ok: false, status: 403, error: DENIED_MODERATOR }
      : { ok: false, status: 404, error: "Post não encontrado ou não é seu" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE posts SET deleted_at = NOW(), deleted_by = $2
       WHERE post_id = $1 AND deleted_at IS NULL`,
      [postId, actor.userId],
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, error: "Post não encontrado" };
    }
    if (!isAuthor) {
      await closeOpenReports(client, "post", postId, actor.userId, "remove_content");
    }
    await client.query("COMMIT");
    return { ok: true, byModerator: !isAuthor };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ===========================================================================
// Comentários
// ===========================================================================

export async function removeComment(
  commentId: string,
  actor: Actor,
): Promise<{ ok: true; byModerator: boolean } | Failure> {
  const { rows } = await pool.query<{
    author_id: string;
    actor_role: CommunityRole | null;
    author_role: CommunityRole | null;
  }>(
    `SELECT
       c.author_id,
       (SELECT role FROM community_members
        WHERE community_id = p.community_id AND user_id = $2) AS actor_role,
       (SELECT role FROM community_members
        WHERE community_id = p.community_id AND user_id = c.author_id) AS author_role
     FROM comments c
     INNER JOIN posts p ON p.post_id = c.post_id
     WHERE c.comment_id = $1 AND c.deleted_at IS NULL`,
    [commentId, actor.userId],
  );
  const comment = rows[0];
  if (!comment) {
    return { ok: false, status: 404, error: "Comentário não encontrado ou não é seu" };
  }

  const isAuthor = comment.author_id === actor.userId;
  const role = effectiveRole(actor, comment.actor_role);
  if (!isAuthor && !outranks(role, comment.author_role)) {
    return role === "owner" || role === "moderator"
      ? { ok: false, status: 403, error: DENIED_MODERATOR }
      : { ok: false, status: 404, error: "Comentário não encontrado ou não é seu" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // O UPDATE condicional protege da corrida com outra exclusão: se nenhuma
    // linha volta, nada é decrementado.
    const { rows: updated } = await client.query<{ post_id: string }>(
      `UPDATE comments
       SET deleted_at = NOW(), deleted_by = $2
       WHERE comment_id = $1 AND deleted_at IS NULL
       RETURNING post_id`,
      [commentId, actor.userId],
    );
    if (updated.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, error: "Comentário não encontrado ou não é seu" };
    }

    await client.query(
      `UPDATE posts
       SET comments_count = GREATEST(0, comments_count - 1)
       WHERE post_id = $1`,
      [updated[0].post_id],
    );
    if (!isAuthor) {
      await closeOpenReports(client, "comment", commentId, actor.userId, "remove_content");
    }
    await client.query("COMMIT");
    return { ok: true, byModerator: !isAuthor };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ===========================================================================
// Banimento
// ===========================================================================

export interface BanInput {
  reason?: string | null;
  /** Dias até o ban vencer; null/undefined = permanente. */
  durationDays?: number | null;
}

/**
 * Bane da comunidade: grava (ou atualiza) o ban e tira a pessoa dos membros.
 * O conteúdo já publicado fica; remover é uma ação separada.
 */
export async function banUser(
  communityId: string,
  targetId: string,
  actor: Actor,
  input: BanInput,
): Promise<{ ok: true; ban: Record<string, unknown> } | Failure> {
  if (targetId === actor.userId) {
    return { ok: false, status: 400, error: "Você não pode banir a si mesmo" };
  }

  const { rows } = await pool.query<{
    actor_role: CommunityRole | null;
    target_role: CommunityRole | null;
    target_exists: boolean;
  }>(
    `SELECT
       (SELECT role FROM community_members
        WHERE community_id = c.community_id AND user_id = $2) AS actor_role,
       (SELECT role FROM community_members
        WHERE community_id = c.community_id AND user_id = $3) AS target_role,
       EXISTS (SELECT 1 FROM users WHERE user_id = $3 AND deleted_at IS NULL) AS target_exists
     FROM communities c
     WHERE c.community_id = $1 AND c.deleted_at IS NULL`,
    [communityId, actor.userId, targetId],
  );
  const context = rows[0];
  if (!context) return { ok: false, status: 404, error: "Comunidade não encontrada" };
  if (!context.target_exists) return { ok: false, status: 404, error: "Usuário não encontrado" };

  const role = effectiveRole(actor, context.actor_role);
  if (role !== "owner" && role !== "moderator") {
    return { ok: false, status: 403, error: "Só o dono e os moderadores podem banir" };
  }
  if (!outranks(role, context.target_role)) {
    return {
      ok: false,
      status: 403,
      error:
        context.target_role === "owner"
          ? "O dono da comunidade não pode ser banido"
          : "Moderadores não podem banir outro moderador",
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: ban } = await client.query(
      `INSERT INTO community_bans
         (ban_id, community_id, user_id, banned_by, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $6::int) END)
       ON CONFLICT (community_id, user_id) DO UPDATE
         SET banned_by = EXCLUDED.banned_by,
             reason = EXCLUDED.reason,
             expires_at = EXCLUDED.expires_at,
             created_at = NOW()
       RETURNING community_id, user_id, banned_by, reason, expires_at, created_at`,
      [
        randomUUID(),
        communityId,
        targetId,
        actor.userId,
        input.reason?.trim() || null,
        input.durationDays ?? null,
      ],
    );
    await client.query(
      `DELETE FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND role <> 'owner'`,
      [communityId, targetId],
    );
    await client.query("COMMIT");
    return { ok: true, ban: ban[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
