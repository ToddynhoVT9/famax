export const config = {
  PORT: Number(process.env.PORT) || 3000,
  NODE_ENV: (process.env.NODE_ENV ?? "development") as "development" | "production",

  DB_HOST: process.env.DB_HOST ?? "viaduct.proxy.rlwy.net",
  DB_PORT: Number(process.env.DB_PORT) || 59380,
  DB_USER: process.env.DB_USER ?? "root",
  DB_PASSWORD: process.env.DB_PASSWORD ?? "whIVjXcdJvEbpBQNNtLwdZQsoLkIxkqc",
  DB_NAME: process.env.DB_NAME ?? "railway",

  JWT_SECRET: process.env.JWT_SECRET ?? "famax-mvp-secret-trocar-em-producao-pelo-menos-32-caracteres-ok",
  JWT_EXPIRES_IN: (process.env.JWT_EXPIRES_IN ?? "7d") as string,

  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",
};
