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

export const config = {
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: (process.env.NODE_ENV ?? "development") as
    | "development"
    | "production",

  DATABASE_URL: required("DATABASE_URL"),

  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: (process.env.JWT_EXPIRES_IN ?? "7d") as `${number}d`,

  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  // Storage das capas de comunidade. Opcional: sem estas vars o upload é
  // desativado e a comunidade é criada sem capa (ver lib/storage.ts).
  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? "",
  SUPABASE_COVERS_BUCKET: process.env.SUPABASE_COVERS_BUCKET ?? "community-covers",
};
