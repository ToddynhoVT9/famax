import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Pontos do ranking "Maiores criadores", num lugar só.
 *
 * Cada ação grava um delta em leaderboard_points na semana (segunda a
 * domingo, horário de Brasília — ver famax_week_start na migration 014) por
 * UPSERT. "Todos os tempos" é a soma das semanas.
 *
 * Desfazer devolve os pontos NA SEMANA EM QUE FORAM GANHOS: descurtir hoje
 * uma curtida da semana passada tira os 2 pontos da semana passada, e não
 * deixa a semana atual negativa por algo que aconteceu antes dela.
 *
 * Sempre chamado com o `client` da transação da ação: se ela sofre ROLLBACK,
 * os pontos vão junto.
 */

export const POINTS = {
  /** Post publicado (para o autor). */
  postPublished: 5,
  /** Reação recebida no post, de outra pessoa. */
  reactionReceived: 2,
  /** Comentário recebido no post, de outra pessoa. */
  commentReceived: 1,
  /** Post ou comentário removido pela moderação (para o autor). */
  removedByModeration: -10,
} as const;

/**
 * Soma `points` (pode ser negativo) ao usuário na comunidade, na semana de
 * `at` — ou na semana atual, sem `at`.
 */
export async function addPoints(
  client: PoolClient,
  input: { userId: string; communityId: string; points: number; at?: Date | string | null },
): Promise<void> {
  if (input.points === 0) return;
  await client.query(
    `INSERT INTO leaderboard_points
       (leaderboard_id, user_id, community_id, points, period_start, period_end)
     SELECT $1, $2, $3, $4, w.start, w.start + 6
     FROM (SELECT famax_week_start(COALESCE($5::timestamptz, NOW())) AS start) w
     ON CONFLICT (user_id, community_id, period_start)
       DO UPDATE SET points = leaderboard_points.points + EXCLUDED.points`,
    [randomUUID(), input.userId, input.communityId, input.points, input.at ?? null],
  );
}

/**
 * Exclusão de um post (pelo autor ou pela moderação): devolve tudo o que ele
 * rendeu ao autor — a publicação, as reações e os comentários de outras
 * pessoas ainda no ar —, cada parte na semana em que entrou.
 *
 * Comentários já apagados ficam de fora: os pontos deles já foram devolvidos
 * quando foram apagados. Pela mesma razão, apagar um comentário DEPOIS do
 * post não devolve nada (ver removeComment).
 */
export async function revertPostPoints(client: PoolClient, postId: string): Promise<void> {
  await client.query(
    `INSERT INTO leaderboard_points
       (leaderboard_id, user_id, community_id, points, period_start, period_end)
     SELECT gen_random_uuid(), p.author_id, p.community_id, -SUM(e.points)::int,
            e.period_start, e.period_start + 6
     FROM posts p
     CROSS JOIN LATERAL (
       SELECT $2::int AS points, famax_week_start(p.created_at) AS period_start
       UNION ALL
       SELECT $3::int, famax_week_start(r.created_at)
       FROM post_reactions r
       WHERE r.post_id = p.post_id AND r.user_id <> p.author_id
       UNION ALL
       SELECT $4::int, famax_week_start(c.created_at)
       FROM comments c
       WHERE c.post_id = p.post_id AND c.deleted_at IS NULL AND c.author_id <> p.author_id
     ) e
     WHERE p.post_id = $1
     GROUP BY p.author_id, p.community_id, e.period_start
     ON CONFLICT (user_id, community_id, period_start)
       DO UPDATE SET points = leaderboard_points.points + EXCLUDED.points`,
    [postId, POINTS.postPublished, POINTS.reactionReceived, POINTS.commentReceived],
  );
}
