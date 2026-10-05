/**
 * Configuração do servidor.
 *
 * DATABASE_URL e JWT_SECRET não têm default: um segredo hardcoded aqui é um
 * segredo commitado. Em desenvolvimento use um .env (já ignorado pelo git);
 * em produção, as env vars do painel de hospedagem.
 */
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variável de ambiente ${name} não definida. ` +
        `Configure-a no .env (dev) ou no painel de hospedagem (produção).`,
    );
  }
  return value;
}

/**
 * `embedded` sobe um Postgres em WASM dentro do processo (ver embedded-db.ts);
 * `external` exige DATABASE_URL apontando para um Postgres de verdade.
 *
 * É explícito de propósito: cair no embarcado só porque DATABASE_URL faltou
 * transformaria um erro de configuração num banco vazio subindo em silêncio.
 */
const DB_MODE = (process.env.DB_MODE ?? "external") as "external" | "embedded";

if (DB_MODE !== "external" && DB_MODE !== "embedded") {
  throw new Error(`DB_MODE inválido: "${DB_MODE}". Use "external" ou "embedded".`);
}

const PGLITE_PORT = Number(process.env.PGLITE_PORT ?? 55500);

export const config = {
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: (process.env.NODE_ENV ?? "development") as
    | "development"
    | "production",

  DB_MODE,
  PGLITE_PORT,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR ?? "./data/pglite",

  // No modo embarcado o banco é o socket local que o embedded-db.ts abre, então
  // a URL é derivada em vez de exigida.
  DATABASE_URL:
    DB_MODE === "embedded"
      ? `postgresql://postgres:postgres@127.0.0.1:${PGLITE_PORT}/postgres`
      : required("DATABASE_URL"),

  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: (process.env.JWT_EXPIRES_IN ?? "7d") as `${number}d`,

  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  // Storage das capas de comunidade. Opcional: sem estas vars o upload é
  // desativado e a comunidade é criada sem capa (ver lib/storage.ts).
  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? "",
  SUPABASE_COVERS_BUCKET: process.env.SUPABASE_COVERS_BUCKET ?? "community-covers",
};
