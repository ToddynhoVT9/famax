/**
 * Respostas da API em camelCase, convertidas num ponto só.
 *
 * O banco é snake_case (post_id, created_at) e as rotas devolvem as linhas
 * quase como vêm do SQL; os corpos que o front envia já eram camelCase
 * (communityId). Em vez de aliases em cada SELECT, toda resposta JSON passa
 * por aqui (middleware em server.ts, eventos SSE em lib/realtime.ts).
 *
 * Só as CHAVES mudam, nunca os valores: "post_comment" como tipo de
 * notificação continua igual. Mapas cujas chaves são dados (reaction_counts:
 * { like: 3 }) passam ilesos porque essas chaves não têm "_".
 */

const SNAKE = /_([a-z0-9])/g;

export function camelKey(key: string): string {
  // "_state" ou "__x" (interno) e chaves sem "_" ficam como estão.
  if (!key.includes("_") || key.startsWith("_")) return key;
  return key.replace(SNAKE, (_, ch: string) => ch.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function toCamel<T = unknown>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => toCamel(item)) as T;
  // Date, Buffer e afins seguem para o JSON.stringify como sempre.
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[camelKey(key)] = toCamel(inner);
  return out as T;
}
