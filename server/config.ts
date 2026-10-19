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

/**
 * Valor do app.set("trust proxy") do Express. Sem ele, atrás do proxy reverso
 * da hospedagem, req.ip é sempre o IP do proxy — e o rate limit por IP do
 * login/cadastro passa a barrar todo mundo de uma vez.
 *
 * Não confia em nada por padrão: confiar no X-Forwarded-For sem haver proxy
 * deixa qualquer cliente escolher o próprio IP e escapar do limite.
 *
 *   TRUST_PROXY=1          número de proxies à frente (o caso comum)
 *   TRUST_PROXY=true       confia em todos (só se o proxy reescreve o header)
 *   TRUST_PROXY=loopback   nomes/IPs/sub-redes aceitos pelo Express
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

if (DB_MODE === "embedded" && process.env.NODE_ENV === "production") {
  // Aviso, não erro: a escolha é de quem opera. Mas o modo embarcado assume
  // UM processo — o PGlite não tranca o diretório de dados, então duas
  // instâncias no mesmo dataDir escrevem em paralelo e corrompem o banco. A
  // maioria das hospedagens gerenciadas roda mais de uma instância, pelo
  // menos durante o deploy.
  console.warn(
    "⚠️  DB_MODE=embedded com NODE_ENV=production.\n" +
      "   O PGlite assume um único processo: duas instâncias no mesmo\n" +
      "   PGLITE_DATA_DIR corrompem o banco, e hospedagem gerenciada\n" +
      "   costuma rodar mais de uma. Para produção use DB_MODE=external.",
  );
}

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

  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),

  // Aplica as migrations pendentes no boot do modo external (ver migrate.ts).
  // Ligado por padrão: deploy sem migration derruba as rotas que dependem dela.
  MIGRATE_ON_BOOT: process.env.MIGRATE_ON_BOOT !== "false",

  // Storage das capas de comunidade. Opcional: sem estas vars o upload é
  // desativado e a comunidade é criada sem capa (ver lib/storage.ts).
  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? "",
  SUPABASE_COVERS_BUCKET: process.env.SUPABASE_COVERS_BUCKET ?? "community-covers",
};
