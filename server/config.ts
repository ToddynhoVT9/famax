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

const REALTIME_BUS = (process.env.REALTIME_BUS ??
  (DB_MODE === "embedded" ? "memory" : "postgres")) as "postgres" | "memory";
if (REALTIME_BUS !== "postgres" && REALTIME_BUS !== "memory") {
  throw new Error(`REALTIME_BUS inválido: "${REALTIME_BUS}". Use "postgres" ou "memory".`);
}

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

/**
 * Provedor de e-mail (ver lib/mailer.ts). `console` só imprime no log: é o
 * padrão para dev e testes, e em produção significa que ninguém recebe o
 * código de recuperação — por isso o aviso.
 */
const MAIL_PROVIDER = (process.env.MAIL_PROVIDER ?? "console") as
  | "console"
  | "resend"
  | "smtp";

if (!["console", "resend", "smtp"].includes(MAIL_PROVIDER)) {
  throw new Error(
    `MAIL_PROVIDER inválido: "${MAIL_PROVIDER}". Use "console", "resend" ou "smtp".`,
  );
}
if (MAIL_PROVIDER === "resend" && !process.env.RESEND_API_KEY) {
  throw new Error("MAIL_PROVIDER=resend exige RESEND_API_KEY.");
}
if (MAIL_PROVIDER === "smtp" && !process.env.SMTP_URL) {
  throw new Error("MAIL_PROVIDER=smtp exige SMTP_URL.");
}
if (MAIL_PROVIDER !== "console" && !process.env.MAIL_FROM) {
  throw new Error(`MAIL_PROVIDER=${MAIL_PROVIDER} exige MAIL_FROM.`);
}
if (MAIL_PROVIDER === "console" && process.env.NODE_ENV === "production") {
  console.warn(
    "⚠️  MAIL_PROVIDER=console em produção: e-mails (como o código de\n" +
      "   recuperação de senha) só vão para o log, ninguém os recebe.",
  );
}

/**
 * Chave da 2FA (AES-256-GCM dos segredos TOTP): 32 bytes, em hex (64
 * caracteres) ou base64. Ausente: a 2FA fica indisponível. Presente mas
 * inválida: erro no boot — melhor do que descobrir na hora de ativar.
 */
function parseTwoFactorKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const value = raw.trim();
  const buffer = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (buffer.length !== 32) {
    throw new Error(
      "TWO_FACTOR_KEY deve ter 32 bytes (64 caracteres hex ou base64). " +
        "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return buffer;
}

const TWO_FACTOR_KEY = parseTwoFactorKey(process.env.TWO_FACTOR_KEY);
if (!TWO_FACTOR_KEY && process.env.NODE_ENV === "production") {
  console.warn("⚠️  TWO_FACTOR_KEY não definida: a verificação em duas etapas fica indisponível.");
}

if (process.env.NODE_ENV === "production" && !process.env.APP_URL) {
  console.warn(
    "⚠️  APP_URL não definida em produção: os links dos e-mails usarão o host\n" +
      "   da requisição. Defina APP_URL=https://seu-dominio.",
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

  // Endereço público do site, para os links dos e-mails (verificação de
  // e-mail). Em dev, sem a variável, o Vite (5173) — o proxy dele troca o
  // Host para a porta da API. Em produção, vazio usa o host da requisição,
  // mas o header Host vem do cliente, então configure (aviso no boot).
  APP_URL: (
    process.env.APP_URL ??
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173")
  ).replace(/\/+$/, ""),

  // Chave dos segredos da verificação em duas etapas (lib/two-factor.ts).
  TWO_FACTOR_KEY,

  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),

  // Aplica as migrations pendentes no boot do modo external (ver migrate.ts).
  // Ligado por padrão: deploy sem migration derruba as rotas que dependem dela.
  MIGRATE_ON_BOOT: process.env.MIGRATE_ON_BOOT !== "false",

  // Storage das capas de comunidade. Opcional: sem estas vars o upload é
  // desativado e a comunidade é criada sem capa (ver lib/storage.ts).
  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? "",
  SUPABASE_COVERS_BUCKET: process.env.SUPABASE_COVERS_BUCKET ?? "community-covers",
  MAIL_PROVIDER,
  MAIL_FROM: process.env.MAIL_FROM ?? "FAMAX <nao-responda@localhost>",
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  SMTP_URL: process.env.SMTP_URL ?? "",

  // Avatar e banner dos usuários (migration 008).
  SUPABASE_USER_MEDIA_BUCKET: process.env.SUPABASE_USER_MEDIA_BUCKET ?? "user-media",

  // Barramento do tempo real (lib/realtime.ts). "postgres" usa LISTEN/NOTIFY
  // e funciona com várias instâncias; "memory" entrega só no próprio
  // processo. O banco embarcado não comporta uma conexão de LISTEN parada
  // (o socket do PGlite atende uma conexão por vez), então lá o padrão é
  // memory.
  REALTIME_BUS,
  // O LISTEN precisa de conexão de sessão. Se a DATABASE_URL for o pooler do
  // Supabase em modo transação (porta 6543), aponte esta para a conexão
  // direta ou para o pooler em modo sessão (porta 5432).
  REALTIME_DATABASE_URL:
    process.env.REALTIME_DATABASE_URL ||
    (DB_MODE === "embedded"
      ? `postgresql://postgres:postgres@127.0.0.1:${PGLITE_PORT}/postgres`
      : process.env.DATABASE_URL ?? ""),
};
