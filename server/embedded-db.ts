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
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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
 * Sobe o banco embarcado. Precisa rodar antes de qualquer query — o pool do
 * pg é preguiçoso (só abre conexão na primeira query), então basta chamar
 * isto antes do pingDatabase().
 */
export async function startEmbeddedDatabase(): Promise<void> {
  if (db) return;

  await mkdir(config.PGLITE_DATA_DIR, { recursive: true });
  console.log(`Postgres embarcado (PGlite) em ${config.PGLITE_DATA_DIR}`);

  db = await PGlite.create({ dataDir: config.PGLITE_DATA_DIR });
  await applySchema(db);

  socketServer = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: config.PGLITE_PORT,
    // Precisa acompanhar o `max` do pool em db.ts: o default é 1, e aí a
    // segunda conexão que o pool abrisse ficaria pendurada.
    maxConnections: 10,
  });
  await socketServer.start();

  console.log(`✅ PGlite escutando em 127.0.0.1:${config.PGLITE_PORT}`);
}

/** Fecha o socket e o banco, liberando o diretório de dados. */
export async function stopEmbeddedDatabase(): Promise<void> {
  await socketServer?.stop();
  await db?.close();
  socketServer = null;
  db = null;
}
