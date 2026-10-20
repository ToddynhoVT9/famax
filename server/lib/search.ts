import { pool } from "../db.js";

/**
 * Busca de comunidades, usuários e posts.
 *
 *  - Comunidades e usuários: por nome. Com pg_trgm, a similaridade por
 *    trigramas tolera erro de digitação ("comunidde") e ordena por relevância;
 *    sem a extensão (ver migration 011), cai para ILIKE. Em ambos, quem
 *    começa com o termo vem primeiro.
 *  - Posts: full-text em português (coluna gerada posts.search_vector), com
 *    cada palavra como prefixo — a busca acha "café" enquanto se digita "caf".
 *
 * As consultas são montadas com um contador de parâmetros ($1, $2...) porque
 * o SQL muda conforme a extensão existe, e o Postgres recusa parâmetro
 * enviado e não usado — por isso também os do WHERE vêm primeiro (a contagem
 * usa só eles).
 */

export type SearchType = "communities" | "users" | "posts";

export interface SearchSection {
  data: unknown[];
  total: number;
  page: number;
  totalPages: number;
}

let trgmAvailable: boolean | null = null;

/** A extensão é criada (ou não) pela migration, antes de a API subir. */
async function hasTrgm(): Promise<boolean> {
  if (trgmAvailable === null) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    trgmAvailable = rows.length > 0;
  }
  return trgmAvailable;
}

// Similaridade mínima para um nome entrar no resultado sem conter o termo.
const MIN_WORD_SIMILARITY = 0.4;

/** % e _ do usuário viram literais no LIKE — "50%" não pode casar com tudo. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * Roda a página e a contagem. Os primeiros `whereParams` parâmetros são os do
 * FROM/WHERE; os seguintes só aparecem no ORDER BY e ficam fora da contagem.
 */
async function runSection(
  select: string,
  fromWhere: string,
  orderBy: string,
  params: Params,
  whereParams: number,
  page: number,
  limit: number,
): Promise<SearchSection> {
  const { rows: countRows } = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total ${fromWhere}`,
    params.values.slice(0, whereParams),
  );
  const total = countRows[0].total;

  const pageParams = new Params();
  pageParams.values.push(...params.values);
  const limitRef = pageParams.add(limit);
  const offsetRef = pageParams.add((page - 1) * limit);

  const { rows } = await pool.query(
    `SELECT ${select} ${fromWhere} ORDER BY ${orderBy} LIMIT ${limitRef} OFFSET ${offsetRef}`,
    pageParams.values,
  );

  return { data: rows, total, page, totalPages: Math.ceil(total / limit) };
}

/** adult: comunidades +18 só aparecem para quem tem conteúdo adulto liberado. */
export async function searchCommunities(
  q: string,
  page: number,
  limit: number,
  adult = false,
): Promise<SearchSection> {
  const trgm = await hasTrgm();
  const params = new Params();
  const contains = params.add(`%${escapeLike(q)}%`);
  const term = trgm ? params.add(q) : null;
  const whereParams = params.values.length;
  const prefix = params.add(`${escapeLike(q)}%`);

  const fromWhere = `
    FROM communities c
    LEFT JOIN categories cat ON cat.category_id = c.category_id
    WHERE c.deleted_at IS NULL
      ${adult ? "" : "AND NOT c.is_nsfw"}
      AND (c.name ILIKE ${contains}
           ${term ? `OR word_similarity(${term}, c.name) >= ${MIN_WORD_SIMILARITY}` : ""})`;

  // Sem trigramas não há nota de similaridade: só "começa com" e tamanho.
  const score = term
    ? `GREATEST(similarity(c.name, ${term}), word_similarity(${term}, c.name)) DESC,`
    : "";

  return runSection(
    `c.community_id, c.name, c.description, c.cover_image_url, c.is_nsfw,
     cat.name AS category_name,
     (SELECT COUNT(*) FROM community_members cm
      WHERE cm.community_id = c.community_id)::int AS members_count`,
    fromWhere,
    `(c.name ILIKE ${prefix}) DESC, ${score} members_count DESC, c.community_id`,
    params,
    whereParams,
    page,
    limit,
  );
}

/**
 * Mesma regra de privacidade da busca do chat (prompt 01): perfil privado só
 * aparece para quem já conversa com a pessoa — e para ela mesma. Visitante
 * só encontra perfis públicos.
 */
export async function searchUsers(
  q: string,
  viewerId: string | undefined,
  page: number,
  limit: number,
): Promise<SearchSection> {
  const trgm = await hasTrgm();
  const params = new Params();
  const contains = params.add(`%${escapeLike(q)}%`);
  const viewer = params.add(viewerId ?? null);
  const term = trgm ? params.add(q) : null;
  const whereParams = params.values.length;
  const prefix = params.add(`${escapeLike(q)}%`);

  const fuzzy = term
    ? `OR word_similarity(${term}, u.username) >= ${MIN_WORD_SIMILARITY}
       OR word_similarity(${term}, coalesce(up.display_name, '')) >= ${MIN_WORD_SIMILARITY}`
    : "";

  const fromWhere = `
    FROM users u
    LEFT JOIN user_profiles up ON up.user_id = u.user_id
    LEFT JOIN user_settings us ON us.user_id = u.user_id
    WHERE u.deleted_at IS NULL
      AND (u.username ILIKE ${contains} OR up.display_name ILIKE ${contains} ${fuzzy})
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks b WHERE b.blocker_id = ${viewer}::uuid AND b.blocked_id = u.user_id
      )
      AND (
        COALESCE(us.is_private, TRUE) = FALSE
        OR u.user_id = ${viewer}::uuid
        OR EXISTS (
          SELECT 1
          FROM conversation_participants me
          INNER JOIN conversation_participants them
                  ON them.conversation_id = me.conversation_id
          WHERE me.user_id = ${viewer}::uuid
            AND them.user_id = u.user_id
        )
      )`;

  const score = term
    ? `GREATEST(word_similarity(${term}, u.username),
                word_similarity(${term}, coalesce(up.display_name, ''))) DESC,`
    : "";

  return runSection(
    `u.user_id, u.username, up.display_name, up.avatar_url`,
    fromWhere,
    `(u.username ILIKE ${prefix} OR up.display_name ILIKE ${prefix}) DESC,
     ${score} u.username`,
    params,
    whereParams,
    page,
    limit,
  );
}

/**
 * Termos para o to_tsquery: só letras e dígitos (nada de operadores do
 * usuário chegando à sintaxe de tsquery), cada um como prefixo, todos
 * obrigatórios. Devolve null se não sobrar termo.
 */
export function toPrefixQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  return words.length ? words.map((word) => `${word}:*`).join(" & ") : null;
}

/** adult: quem busca vê conteúdo +18 (users.is_adult). Sem isso, fica de fora. */
export async function searchPosts(
  q: string,
  page: number,
  limit: number,
  adult = false,
): Promise<SearchSection> {
  const tsquery = toPrefixQuery(q);
  if (!tsquery) return { data: [], total: 0, page, totalPages: 0 };

  const params = new Params();
  const query = params.add(tsquery);

  const fromWhere = `
    FROM posts p
    INNER JOIN communities c    ON c.community_id = p.community_id
    INNER JOIN users u          ON u.user_id = p.author_id
    LEFT  JOIN user_profiles up ON up.user_id = p.author_id
    WHERE p.deleted_at IS NULL
      AND c.deleted_at IS NULL
      ${adult ? "" : "AND NOT p.is_nsfw AND NOT c.is_nsfw"}
      AND p.search_vector @@ to_tsquery('portuguese', ${query})`;

  return runSection(
    `p.post_id, p.title, left(p.content, 240) AS snippet, p.created_at,
     p.likes_count, p.comments_count,
     c.community_id, c.name AS community_name,
     u.user_id AS author_id, u.username AS author_username,
     up.display_name AS author_display_name`,
    fromWhere,
    `ts_rank(p.search_vector, to_tsquery('portuguese', ${query})) DESC,
     p.created_at DESC, p.post_id DESC`,
    params,
    params.values.length,
    page,
    limit,
  );
}
