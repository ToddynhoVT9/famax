import type pg from "pg";
import { pool } from "../db.js";

/**
 * Conteúdo adulto (+18), migration 027.
 *
 * Um post é +18 se ele mesmo for (posts.is_nsfw) ou se a comunidade dele for
 * (communities.is_nsfw). Quem vê precisa de users.is_adult — que só liga com
 * 18 anos pelo nascimento (prompt 04). Visitante nunca é adulto. O autor
 * sempre vê o próprio post.
 */

export const NSFW_FORBIDDEN = "Conteúdo para maiores de 18. Ative “Conteúdo adulto” nas configurações para ver.";

export async function isAdult(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const { rows } = await pool.query<{ is_adult: boolean }>(
    "SELECT is_adult FROM users WHERE user_id = $1 AND deleted_at IS NULL",
    [userId],
  );
  return rows[0]?.is_adult === true;
}

/**
 * Condição SQL "este post está escondido de quem vê". `viewer` é o
 * parâmetro do usuário ($1...), `post` e `community` os aliases.
 */
export function nsfwHiddenSql(viewer: string, post = "p", community = "cm"): string {
  return `((${post}.is_nsfw OR ${community}.is_nsfw)
    AND ${post}.author_id IS DISTINCT FROM ${viewer}::uuid
    AND NOT COALESCE((SELECT vu.is_adult FROM users vu WHERE vu.user_id = ${viewer}::uuid), FALSE))`;
}

/**
 * O post é +18 e quem vê não pode ver? (comentários). `db`: o client que a
 * rota já segura, se houver — não abre uma segunda conexão à toa.
 */
export async function postHiddenFor(
  postId: string,
  viewerId: string | undefined,
  db: Pick<pg.PoolClient, "query"> = pool,
): Promise<boolean> {
  const { rows } = await db.query<{ hidden: boolean }>(
    `SELECT ${nsfwHiddenSql("$2")} AS hidden
     FROM posts p INNER JOIN communities cm ON cm.community_id = p.community_id
     WHERE p.post_id = $1`,
    [postId, viewerId ?? null],
  );
  return rows[0]?.hidden === true;
}
