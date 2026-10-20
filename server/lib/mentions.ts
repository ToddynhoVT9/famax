import type { PoolClient } from "pg";
import { notify } from "./notify.js";

/**
 * Menções @username em posts e comentários.
 *
 * O padrão segue a regra do cadastro (letras, números e _, de 3 a 50) e só
 * conta quando o @ não está colado em outra palavra — "email@site.com" não
 * menciona ninguém. Trechos de código (`...` e blocos ```...```) ficam de
 * fora, como no front (shared/markdown.ts), que só transforma em link o @ de
 * texto corrido.
 */

const MENTION = /(^|[^\w@])@([a-zA-Z0-9_]{3,50})(?![a-zA-Z0-9_])/g;

/** Limite por texto: uma lista de 50 @ não vira 50 notificações. */
export const MAX_MENTIONS = 10;

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** Usernames mencionados (minúsculos, sem repetição, na ordem em que aparecem). */
export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of stripCode(text).matchAll(MENTION)) {
    found.add(match[2].toLowerCase());
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found];
}

export interface MentionInput {
  /** Texto atual (o que foi publicado ou salvo). */
  content: string;
  /** Na edição, o texto anterior: quem já estava mencionado não é avisado de novo. */
  previousContent?: string | null;
  actorId: string;
  postId: string;
  commentId?: string | null;
  communityId: string;
  /** Quem já recebeu outro aviso pela mesma ação (resposta, comentário no post). */
  skip?: Iterable<string>;
}

/**
 * Avisa quem foi mencionado (tipo "mention"), dentro da transação da ação.
 * A preferência é a de respostas (ver PREFERENCE_COLUMN em notify.ts) e
 * ninguém é avisado de se mencionar. Devolve os ids avisados.
 */
export async function notifyMentions(client: PoolClient, input: MentionInput): Promise<string[]> {
  const before = new Set(input.previousContent ? extractMentions(input.previousContent) : []);
  const usernames = extractMentions(input.content).filter((name) => !before.has(name));
  if (usernames.length === 0) return [];

  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM users
     WHERE lower(username) = ANY($1::text[]) AND deleted_at IS NULL`,
    [usernames],
  );

  const skip = new Set(input.skip ?? []);
  const notified: string[] = [];
  for (const { user_id } of rows) {
    if (skip.has(user_id)) continue;
    const sent = await notify(client, {
      userId: user_id,
      type: "mention",
      actorId: input.actorId,
      postId: input.postId,
      commentId: input.commentId ?? null,
      communityId: input.communityId,
    });
    if (sent) notified.push(user_id);
  }
  return notified;
}
