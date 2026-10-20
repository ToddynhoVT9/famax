import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { publish } from "./realtime.js";

/**
 * Criação de notificações. Sempre chamado com o `client` da transação da
 * própria ação (comentar, curtir, remover...): se a ação sofre ROLLBACK, o
 * aviso vai junto, e nunca existe aviso de algo que não aconteceu.
 *
 * Regras comuns:
 *  - ninguém é notificado da própria ação;
 *  - conta excluída não recebe nada;
 *  - tipos com preferência (curtidas, comentários, respostas) respeitam o
 *    user_settings; sem linha de settings, vale o padrão (ligado);
 *  - quem bloqueou alguém não recebe avisos das ações dessa pessoa.
 *
 * Cada aviso gravado também vira um evento notification:new no tempo real
 * (lib/realtime.ts), entregue só no COMMIT da mesma transação: o sininho
 * atualiza na hora, sem esperar o polling.
 */

export type NotificationType =
  | "post_comment"
  | "comment_reply"
  | "post_like"
  | "content_removed"
  | "community_role"
  | "mention"
  | "follow"
  | "event";

/** Coluna de user_settings que desliga cada tipo; os ausentes não desligam. */
const PREFERENCE_COLUMN: Partial<Record<NotificationType, string>> = {
  post_like: "notify_likes",
  post_comment: "notify_comments",
  comment_reply: "notify_replies",
  mention: "notify_replies",
  follow: "notify_follows",
  event: "notify_events",
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
  // contar como não lida. Seguidor: uma linha por par de pessoas.
  const conflict =
    input.type === "post_like"
      ? `ON CONFLICT (user_id, post_id) WHERE type = 'post_like' DO UPDATE
           SET actor_id = EXCLUDED.actor_id, read_at = NULL, created_at = NOW()`
      : input.type === "follow"
        ? `ON CONFLICT (user_id, actor_id) WHERE type = 'follow' DO UPDATE
             SET read_at = NULL, created_at = NOW()`
        : "";

  const { rows } = await client.query<{ notification_id: string }>(
    `INSERT INTO notifications
       (notification_id, user_id, type, actor_id, post_id, comment_id, community_id, data)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb
     WHERE ${wants}
       AND EXISTS (SELECT 1 FROM users WHERE user_id = $2 AND deleted_at IS NULL)
       -- Bloqueou quem agiu: nenhum aviso dessa pessoa.
       AND NOT EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $2 AND blocked_id = $4)
     ${conflict}
     RETURNING notification_id`,
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
  if (rows.length === 0) return false;
  await publish(client, [input.userId], "notification:new", {
    notificationId: rows[0].notification_id,
    type: input.type,
  });
  return true;
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
       WHERE r.post_id = n.post_id AND r.user_id <> n.user_id
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
         WHERE r.post_id = n.post_id AND r.user_id <> n.user_id
       )`,
    [postId],
  );
}

/**
 * "Novo evento": um aviso para cada membro da comunidade, menos quem criou,
 * num INSERT só (uma comunidade grande não vira N idas ao banco). Mesmas
 * regras do notify(): conta excluída fica de fora e a preferência
 * notify_events é respeitada. Devolve quantos avisos foram gravados.
 */
export async function notifyEventToMembers(
  client: PoolClient,
  input: { communityId: string; eventId: string; actorId: string; title: string },
): Promise<number> {
  const { rows } = await client.query<{ user_id: string }>(
    `INSERT INTO notifications
       (notification_id, user_id, type, actor_id, community_id, event_id, data)
     SELECT gen_random_uuid(), m.user_id, 'event', $2, $1, $3, $4::jsonb
     FROM community_members m
     INNER JOIN users u          ON u.user_id = m.user_id AND u.deleted_at IS NULL
     LEFT  JOIN user_settings us ON us.user_id = m.user_id
     WHERE m.community_id = $1
       AND m.user_id <> $2
       AND COALESCE(us.notify_events, TRUE)
       AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = m.user_id AND b.blocked_id = $2)
     RETURNING user_id`,
    [input.communityId, input.actorId, input.eventId, JSON.stringify({ title: input.title })],
  );
  // Em lotes dentro do publish: comunidade grande não estoura os 8000 bytes
  // do NOTIFY.
  await publish(
    client,
    rows.map((r) => r.user_id),
    "notification:new",
    { type: "event" },
  );
  return rows.length;
}
