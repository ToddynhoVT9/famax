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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { config } from "./config.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.join(serverDir, "sql");
const baselinePath = path.join(sqlDir, "baseline", "DB.psql");

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
export async function startEmbeddedDatabase(): Promise<void> {
  if (db) return;

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

  await mkdir(dataDir, { recursive: true });
  db = await PGlite.create({ dataDir });
  await applySchema(db);

  await bindSocketWithRetry();
}

/**
 * Abre o socket, esperando a porta liberar se preciso.
 *
 * A hospedagem faz restart sobreposto: sobe a instância nova enquanto a velha
 * ainda está de pé. A nova encontra a porta ocupada e, sem retry, morria com
 * EADDRINUSE e ficava viva servindo 503 para sempre. Esperar é o certo — a
 * velha solta a porta em segundos, quando termina de desligar.
 */
async function bindSocketWithRetry(): Promise<void> {
  const attempts = 30;
  const delayMs = 1000;

  for (let i = 1; i <= attempts; i++) {
    const server = new PGLiteSocketServer({
      db: db!,
      host: "127.0.0.1",
      port: config.PGLITE_PORT,
      // Precisa acompanhar o `max` do pool em db.ts: o default é 1, e aí a
      // segunda conexão que o pool abrisse ficaria pendurada.
      maxConnections: 10,
    });

    try {
      await server.start();
      socketServer = server;
      console.log(`✅ PGlite escutando em 127.0.0.1:${config.PGLITE_PORT}`);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") throw err;

      // Descarta a instância que falhou: o start() recusa ser chamado duas
      // vezes no mesmo objeto ("Socket server already started").
      await server.stop().catch(() => {});

      if (i === attempts) {
        throw new Error(
          `Porta ${config.PGLITE_PORT} seguiu ocupada após ${attempts}s. ` +
            `Outra instância do app ainda está de pé, ou PGLITE_PORT conflita ` +
            `com outro processo da máquina.`,
        );
      }

      if (i === 1) {
        console.log(
          `Porta ${config.PGLITE_PORT} ocupada (instância anterior ainda ` +
            `desligando) — aguardando liberar...`,
        );
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Fecha o socket e o banco, liberando o diretório de dados. */
export async function stopEmbeddedDatabase(): Promise<void> {
  await socketServer?.stop();
  await db?.close();
  socketServer = null;
  db = null;
}
