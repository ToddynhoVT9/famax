/**
 * Postgres embarcado (PGlite) para quando não há um banco externo.
 *
 * Sobe um Postgres em WASM dentro do próprio processo, persiste num diretório
 * em disco e o expõe num socket TCP local falando o protocolo wire. Assim o
 * resto do código continua usando `pg` normalmente, sem saber a diferença — é
 * o mesmo arranjo que o teste de integração já usa, só que persistente.
 *
 * Ativado por DB_MODE=embedded. Ver config.ts.
 */
import { readFile, readdir, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { config } from "./config.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.join(serverDir, "sql");
const baselinePath = path.join(sqlDir, "baseline", "DB.psql");

/**
 * `owner` abriu o PGlite e serve o socket; `client` depende do socket de outra
 * instância. A distinção importa porque só o dono tem banco de fato — um
 * cliente precisa provar que consegue consultar antes de a API ser liberada.
 */
export type DbRole = "owner" | "client";

let db: PGlite | null = null;
let socketServer: PGLiteSocketServer | null = null;

/**
 * Aplica o baseline e as migrations pendentes.
 *
 * Mesma lógica do scripts/migrate.mjs — registra em `schema_migrations` com
 * checksum e pula o que já rodou — mas falando direto com a instância PGlite,
 * sem passar pelo socket. Rodar a cada boot é seguro e barato.
 */
async function applySchema(instance: PGlite): Promise<void> {
  await instance.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const existing = await instance.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'users'`,
  );

  if (existing.rows.length === 0) {
    console.log("Banco vazio — aplicando baseline...");
    await instance.exec(await readFile(baselinePath, "utf8"));
    console.log("  ✓ baseline aplicado");
  }

  const applied = await instance.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const done = new Set(applied.rows.map((r) => r.filename));

  const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;

  for (const filename of files) {
    if (done.has(filename)) continue;

    const sql = await readFile(path.join(sqlDir, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);

    await instance.exec(sql);
    await instance.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
      [filename, checksum],
    );
    console.log(`  ✓ migration ${filename}`);
    count++;
  }

  if (count > 0) console.log(`${count} migration(s) aplicada(s).`);
}

/**
 * Resolve o diretório de dados para um caminho absoluto.
 *
 * Expande o `~` na mão: o shell faz isso, mas uma env var vinda de painel de
 * hospedagem chega literal, e o Node trataria "~/dados" como uma pasta
 * chamada "~" dentro do cwd — criada sem reclamar, e perdida no próximo
 * deploy junto com a pasta do app.
 */
function resolveDataDir(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

/**
 * Sobe o banco embarcado. Precisa rodar antes de qualquer query — o pool do
 * pg é preguiçoso (só abre conexão na primeira query), então basta chamar
 * isto antes do pingDatabase().
 */
export async function startEmbeddedDatabase(): Promise<DbRole> {
  if (db) return "owner";

  const dataDir = resolveDataDir(config.PGLITE_DATA_DIR);

  // Em hospedagem gerenciada a pasta do app é recriada a cada deploy, então o
  // que importa saber é onde o banco caiu de fato e se ele sobreviveu ao
  // deploy anterior. Um caminho relativo nunca é óbvio: depende do cwd que o
  // painel escolheu. Por isso o log mostra os dois.
  const existed = await stat(dataDir)
    .then((s) => s.isDirectory())
    .catch(() => false);

  console.log("Postgres embarcado (PGlite)");
  console.log(`  cwd        : ${process.cwd()}`);
  console.log(`  home       : ${os.homedir()}`);
  console.log(`  dataDir    : ${dataDir}`);
  console.log(
    `  persistiu  : ${existed ? "sim (diretório já existia)" : "não (primeiro boot aqui)"}`,
  );

  // SONDA ANTES DE ABRIR O BANCO.
  //
  // O PGlite NÃO tranca o dataDir: um segundo processo abre os mesmos arquivos
  // sem reclamar e passa a escrever em paralelo, corrompendo. E a hospedagem
  // roda mais de uma instância (restart sobreposto, no mínimo). Então quem
  // chega e encontra a porta servindo NÃO abre o PGlite: usa o banco da
  // instância que já é dona, via socket. Um dono, N clientes, um escritor só.
  if (await portIsServing()) {
    console.log(
      `  papel      : cliente (outra instância já serve 127.0.0.1:${config.PGLITE_PORT})`,
    );
    return "client";
  }

  await mkdir(dataDir, { recursive: true });
  // pg_trgm carregado para a busca ter o mesmo comportamento do Postgres de
  // produção (ver migration 011); sem ele a busca cairia para ILIKE.
  const instance = await PGlite.create({ dataDir, extensions: { pg_trgm } });

  // Corrida: duas instâncias podem sondar a porta livre ao mesmo tempo. Quem
  // perder o bind fecha o próprio PGlite na hora e vira cliente, para não
  // ficar com os arquivos abertos junto com o dono.
  const server = new PGLiteSocketServer({
    db: instance,
    host: "127.0.0.1",
    port: config.PGLITE_PORT,
    // Precisa acompanhar o `max` do pool em db.ts: o default é 1, e aí a
    // segunda conexão que o pool abrisse ficaria pendurada.
    maxConnections: 10,
  });

  try {
    await server.start();
  } catch (err) {
    await server.stop().catch(() => {});
    await instance.close().catch(() => {});

    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.log("  papel      : cliente (perdi a corrida pelo socket)");
      return "client";
    }
    throw err;
  }

  // Só agora assume a posse: o schema é aplicado por quem é dono, nunca por um
  // cliente, senão voltariam a existir dois escritores.
  db = instance;
  socketServer = server;
  await applySchema(instance);

  console.log(`✅ PGlite escutando em 127.0.0.1:${config.PGLITE_PORT} (dono)`);
  return "owner";
}

/**
 * Alguém já está servindo Postgres na porta do PGlite?
 *
 * Só um TCP connect: se alguém aceita, há um dono. ECONNREFUSED significa
 * porta livre. Qualquer outro erro (timeout, por exemplo) é tratado como
 * ocupada, porque assumir "livre" por engano é o caso perigoso — levaria a
 * dois PGlite no mesmo diretório.
 */
function portIsServing(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({
      host: "127.0.0.1",
      port: config.PGLITE_PORT,
    });
    const done = (answer: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(3000);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(true));
    socket.on("error", (err: NodeJS.ErrnoException) =>
      done(err.code !== "ECONNREFUSED"),
    );
  });
}

/**
 * Vigia a posse do banco, promovendo este processo a dono se preciso.
 *
 * Um cliente depende do socket do dono. Em deploy, o dono é justamente a
 * instância VELHA — quando ela desliga, o cliente fica sem banco e a app
 * responde erro em tudo. Aqui o cliente percebe que a porta ficou livre e
 * assume o banco, sem precisar de restart.
 *
 * Só promove quem é cliente: se já somos donos, não há nada a fazer.
 */
export function superviseEmbeddedDatabase(
  verify: () => Promise<void>,
  onReady: () => void,
  onError: (err: Error) => void,
): void {
  const baseIntervalMs = 5000;
  const maxIntervalMs = 60_000;
  let intervalMs = baseIntervalMs;
  let timer: NodeJS.Timeout;

  const schedule = () => {
    timer = setTimeout(tick, intervalMs);
    // Não segura o processo vivo só por causa do vigia.
    timer.unref();
  };

  const tick = async () => {
    if (db) return; // já somos o dono, nada a vigiar

    try {
      if (await portIsServing()) {
        // Há um dono de pé. Isso não basta para liberar a API: o pool precisa
        // CONSEGUIR falar com ele. Numa hospedagem que recusa conexão em
        // loopback, "existe um dono" e "dá para consultar" são coisas
        // diferentes — e declarar pronto sem checar foi o que fez a aplicação
        // devolver 500 em vez de 503.
        await verify();
        onReady();
        intervalMs = baseIntervalMs;
        return;
      }

      const role = await startEmbeddedDatabase();
      if (role === "client") {
        // Perdemos a corrida de novo. Não somos donos nem conseguimos
        // confirmar acesso — segue indisponível, com espera crescente para
        // não reabrir o dataDir a cada 5s (dois PGlite no mesmo diretório é
        // risco de corrupção, e o PGlite não trava o diretório).
        throw new Error(
          "Não virei dono do banco nem consigo usar o do dono atual.",
        );
      }

      await verify();
      onReady();
      intervalMs = baseIntervalMs;
    } catch (err) {
      onError(err as Error);
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    } finally {
      if (!db) schedule();
    }
  };

  schedule();
}

/** Fecha o socket e o banco, liberando o diretório de dados. */
export async function stopEmbeddedDatabase(): Promise<void> {
  await socketServer?.stop();
  await db?.close();
  socketServer = null;
  db = null;
}
