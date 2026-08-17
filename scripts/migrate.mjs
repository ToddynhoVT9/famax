/**
 * Runner de migrations.
 *
 * Aplica os arquivos de server/sql/ em ordem alfabética contra DATABASE_URL,
 * registrando o que já rodou em `schema_migrations`. Rodar de novo é seguro:
 * arquivos já aplicados são pulados.
 *
 *   npm run migrate            aplica o que falta
 *   npm run migrate -- --status   só mostra o estado, não aplica
 *   npm run migrate -- --baseline aplica _/DB.psql antes (banco vazio)
 */
import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sqlDir = path.join(root, "server", "sql");

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const withBaseline = args.includes("--baseline");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL não definida. Crie o .env a partir do .env.example.",
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

await client.connect();
console.log("Conectado.\n");

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const { rows: applied } = await client.query(
  "SELECT filename, checksum FROM schema_migrations",
);
const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

// --- baseline opcional ------------------------------------------------------

if (withBaseline) {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='users'",
  );
  if (rows[0].n > 0) {
    console.log("Baseline pulado: a tabela `users` já existe.\n");
  } else {
    // Versionado em server/sql/baseline/ para o repositório ficar
    // auto-contido: `_/` é gitignored e não chega ao servidor de produção.
    const baselinePath = path.join(root, "server", "sql", "baseline", "DB.psql");
    const sql = await readFile(baselinePath, "utf8").catch(() => null);
    if (!sql) {
      console.error(`Baseline não encontrado em ${baselinePath}`);
      process.exit(1);
    }
    console.log("Aplicando baseline (server/sql/baseline/DB.psql)...");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("  ✓ baseline aplicado\n");
  }
}

// --- migrations -------------------------------------------------------------

const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();

let pending = 0;
for (const filename of files) {
  const sql = await readFile(path.join(sqlDir, filename), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
  const previous = appliedMap.get(filename);

  if (previous) {
    // Migration já aplicada que mudou depois é um erro de processo: o banco
    // não reflete mais o arquivo. Avisa em vez de reaplicar em silêncio.
    const note =
      previous === checksum ? "já aplicada" : "JÁ APLICADA, MAS O ARQUIVO MUDOU";
    console.log(`  · ${filename} — ${note}`);
    continue;
  }

  pending++;
  if (statusOnly) {
    console.log(`  → ${filename} — pendente`);
    continue;
  }

  process.stdout.write(`  → ${filename} ... `);
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
      [filename, checksum],
    );
    await client.query("COMMIT");
    console.log("✓");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.log("✗");
    console.error(`\nFalha em ${filename}:\n${err.message}\n`);
    await client.end();
    process.exit(1);
  }
}

console.log(
  pending === 0
    ? "\nNada pendente — banco atualizado."
    : statusOnly
      ? `\n${pending} migration(s) pendente(s).`
      : `\n${pending} migration(s) aplicada(s).`,
);

await client.end();
