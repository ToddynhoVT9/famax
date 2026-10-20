import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Criação de notificações. Sempre chamado com o `client` da transação da
 * própria ação (comentar, curtir, remover...): se a ação sofre ROLLBACK, o
 * aviso vai junto, e nunca existe aviso de algo que não aconteceu.
 *
 * Regras comuns:
 *  - ninguém é notificado da própria ação;
 *  - conta excluída não recebe nada;
 *  - tipos com preferência (curtidas, comentários, respostas) respeitam o
 *    user_settings; sem linha de settings, vale o padrão (ligado).
 */

export type NotificationType =
  | "post_comment"
  | "comment_reply"
  | "post_like"
  | "content_removed"
  | "community_role"
  // Prompt de engajamento: já aceitos pelo CHECK da tabela.
  | "mention"
  | "follow"
  | "event";

/** Coluna de user_settings que desliga cada tipo; os ausentes não desligam. */
const PREFERENCE_COLUMN: Partial<Record<NotificationType, string>> = {
  post_like: "notify_likes",
  post_comment: "notify_comments",
  comment_reply: "notify_replies",
  mention: "notify_replies",
};

export interface NotifyInput {
  /** Destinatário. */
  userId: string;
  type: NotificationType;
  /** Quem fez a ação; null para avisos do sistema. */
  actorId: string | null;
  postId?: string | null;
  commentId?: string | null;
  communityId?: string | null;
  /** Detalhes que não cabem nas colunas (ex.: título do post removido). */
  data?: Record<string, unknown>;
}

/** Devolve true se o aviso foi gravado (false: autoaviso, preferência, conta). */
export async function notify(client: PoolClient, input: NotifyInput): Promise<boolean> {
  if (input.actorId && input.actorId === input.userId) return false;

  const column = PREFERENCE_COLUMN[input.type];
  // O nome da coluna vem da tabela fixa acima, nunca da requisição.
  const wants = column
    ? `COALESCE((SELECT us.${column} FROM user_settings us WHERE us.user_id = $2), TRUE)`
    : "TRUE";

  // Curtidas: uma linha por post. A curtida nova vira a "última" e volta a
  // contar como não lida.
  const conflict =
    input.type === "post_like"
      ? `ON CONFLICT (user_id, post_id) WHERE type = 'post_like' DO UPDATE
           SET actor_id = EXCLUDED.actor_id, read_at = NULL, created_at = NOW()`
      : "";

  const { rowCount } = await client.query(
    `INSERT INTO notifications
       (notification_id, user_id, type, actor_id, post_id, comment_id, community_id, data)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb
     WHERE ${wants}
       AND EXISTS (SELECT 1 FROM users WHERE user_id = $2 AND deleted_at IS NULL)
     ${conflict}`,
    [
      randomUUID(),
      input.userId,
      input.type,
      input.actorId,
      input.postId ?? null,
      input.commentId ?? null,
      input.communityId ?? null,
      JSON.stringify(input.data ?? {}),
    ],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Descurtida: chamar depois de apagar a reação, na mesma transação. Se quem
 * descurtiu era o "último a curtir" do aviso, o aviso passa para a curtida
 * anterior; se não sobrou curtida de mais ninguém, o aviso some — sem
 * notificação órfã de algo que não existe mais.
 */
export async function unnotifyLike(client: PoolClient, postId: string, likerId: string): Promise<void> {
  await client.query(
    `UPDATE notifications n
     SET actor_id = (
       SELECT r.user_id FROM post_reactions r
       WHERE r.post_id = n.post_id AND r.type = 'like' AND r.user_id <> n.user_id
       ORDER BY r.created_at DESC
       LIMIT 1
     )
     WHERE n.type = 'post_like' AND n.post_id = $1 AND n.actor_id = $2`,
    [postId, likerId],
  );
  await client.query(
    `DELETE FROM notifications n
     WHERE n.type = 'post_like' AND n.post_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM post_reactions r
         WHERE r.post_id = n.post_id AND r.type = 'like' AND r.user_id <> n.user_id
       )`,
    [postId],
  );
}
