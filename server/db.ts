import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

/**
 * O Supabase exige SSL; um Postgres local (dev ou teste) recusa a negociação e
 * o pg aborta com "server does not support SSL". Por isso o SSL é ligado por
 * padrão e desligado explicitamente via DATABASE_SSL=false.
 *
 * O socket do PGlite não fala TLS, então o modo embarcado desliga sozinho —
 * exigir DATABASE_SSL=false junto de DB_MODE=embedded seria uma pegadinha.
 */
const useSsl =
  config.DB_MODE === "embedded" ? false : process.env.DATABASE_SSL !== "false";

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

/**
 * Sem este handler o processo MORRE.
 *
 * Quando uma conexão ociosa do pool cai — o pooler do Supabase expira
 * conexões paradas, a rede oscila, o banco reinicia —, o pg.Pool emite
 * 'error'. Um EventEmitter sem listener de 'error' faz o Node lançar
 * "Unhandled 'error' event" e derrubar a aplicação inteira, bem longe de
 * qualquer try/catch de rota.
 *
 * O pool descarta a conexão quebrada e abre outra na próxima query, então só
 * registrar já é o tratamento correto.
 */
pool.on("error", (err) => {
  console.error("Conexão ociosa do pool caiu (descartada):", err.message);
});

/**
 * Vigia o banco externo com uma query periódica. Resolve dois problemas de
 * uma vez.
 *
 * 1. ESTADO HONESTO. Sem isto, `dbState.ready` nunca voltava para false no
 *    modo externo: o banco caía e a aplicação seguia liberando as rotas, que
 *    respondiam 500 em vez de 503. O /api/health chegava a dizer "ready" com
 *    o banco morto.
 *
 * 2. PAUSA POR INATIVIDADE. O plano free do Supabase pausa o projeto após
 *    cerca de uma semana sem atividade DE BANCO, e voltar exige ação manual no
 *    dashboard — foi assim que o banco anterior deste projeto se perdeu. Bater
 *    no /api/health não ajudaria: ele lê estado em memória e não encosta no
 *    Postgres. Esta query encosta.
 *
 * O intervalo é configurável porque o custo depende do provedor. No Supabase
 * free não há cota de compute, então 60s é irrelevante. Num provedor que cobra
 * por tempo de compute ligado (Neon, por exemplo), uma sonda a cada 60s mantém
 * o banco acordado 24/7 e queima a cota do mês — lá o valor certo é na casa
 * dos minutos, aceitando detecção mais lenta.
 */
export function startDatabaseMonitor(
  onHealthy: () => void,
  onUnhealthy: (err: Error) => void,
): void {
  if (config.DB_MODE !== "external") return;

  const seconds = Number(process.env.DB_PROBE_SECONDS ?? 60);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.warn(
      `DB_PROBE_SECONDS inválido ("${process.env.DB_PROBE_SECONDS}") — vigia desligado.`,
    );
    return;
  }

  // Só registra transições: uma linha a cada 60s poluiria o log até esconder
  // o que importa.
  let healthy = true;

  const timer = setInterval(() => {
    pool
      .query("SELECT 1")
      .then(() => {
        if (!healthy) {
          healthy = true;
          console.log("✅ Banco voltou a responder.");
        }
        onHealthy();
      })
      .catch((err: Error) => {
        if (healthy) {
          healthy = false;
          console.error("❌ Banco parou de responder:", err.message);
        }
        onUnhealthy(err);
      });
  }, seconds * 1000);

  // Não segura o processo vivo só por causa do vigia.
  timer.unref();
  console.log(`Vigia do banco: uma query a cada ${seconds}s.`);
}

export async function pingDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log(
      config.DB_MODE === "embedded"
        ? "✅ Postgres embarcado conectado"
        : "✅ Postgres externo conectado",
    );
  } finally {
    client.release();
  }
}
