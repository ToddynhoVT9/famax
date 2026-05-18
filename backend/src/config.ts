export const config = {
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: (process.env.NODE_ENV ?? "development") as "development" | "production",

  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://postgres.tsuescxrxpzmmcofckkn:whIVjXcdJvEbpBQNNtLwdZQsoLkIxkqc@aws-1-sa-east-1.pooler.supabase.com:5432/postgres",

  JWT_SECRET:
    process.env.JWT_SECRET ??
    "famax-mvp-secret-trocar-em-producao-pelo-menos-32-caracteres-ok",
  JWT_EXPIRES_IN: (process.env.JWT_EXPIRES_IN ?? "7d") as `${number}d`,

  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",
};
