/**
 * Aplica as migrations pendentes no boot (modo external).
 *
 * Sem isto, o deploy publicava código que dependia de colunas novas antes de
 * alguém lembrar de rodar `npm run migrate` — foi o que derrubou o login com a
 * 007_sessions ("column jti does not exist"). Agora o código e o schema sobem
 * juntos, e a API só é liberada depois das migrations.
 *
 * Mesma contabilidade do scripts/migrate.mjs (tabela `schema_migrations` com
 * checksum), então os dois convivem: o que um aplicou o outro pula.
 *
 * Diferenças em relação ao script:
 *  - NÃO aplica o baseline. Num banco externo sem tabelas, criar o schema do
 *    zero em silêncio esconderia uma DATABASE_URL errada. Isso continua sendo
 *    `npm run migrate -- --baseline`, à mão.
 *  - Cada migration roda numa transação: se falhar no meio, nada fica pela
 *    metade e ela não é registrada. (Consequência: migration com
 *    `CREATE INDEX CONCURRENTLY` não roda por aqui — use o script.)
 *  - Advisory lock: no deploy a instância nova sobe enquanto a velha ainda
 *    está de pé, e duas aplicando a mesma migration ao mesmo tempo colidiriam.
 *    A segunda espera a primeira terminar e encontra tudo aplicado.
 *
 * Desligável com MIGRATE_ON_BOOT=false.
 */
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

// Em dev isto é server/sql/; no build, dist/sql/ (ver scripts/copy-sql.mjs).
const sqlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql");

// Número arbitrário, só precisa ser o mesmo em todas as instâncias.
const MIGRATION_LOCK_KEY = 7_204_311;

export async function applyPendingMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    const { rows: hasUsers } = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    if (hasUsers.length === 0) {
      throw new Error(
        "Banco sem o schema base (tabela users não existe). Confira a " +
          "DATABASE_URL ou rode `npm run migrate -- --baseline`.",
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: applied } = await client.query<{
      filename: string;
      checksum: string;
    }>("SELECT filename, checksum FROM schema_migrations");
    const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

    const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();
    let count = 0;

    for (const filename of files) {
      const sql = await readFile(path.join(sqlDir, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);

      const previous = appliedMap.get(filename);
      if (previous !== undefined) {
        // Não reaplica: só avisa, como o script. Editar migration já aplicada
        // não tem efeito no banco — a mudança tem que virar migration nova.
        if (previous !== checksum) {
          console.warn(`⚠️  ${filename} já aplicada, mas o arquivo mudou depois.`);
        }
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(
          `Migration ${filename} falhou: ${(err as Error).message}`,
          { cause: err },
        );
      }

      console.log(`  ✓ migration ${filename}`);
      count++;
    }

    console.log(
      count > 0
        ? `${count} migration(s) aplicada(s) no boot.`
        : "Migrations em dia.",
    );
  } finally {
    // O lock é de sessão: soltar antes de devolver a conexão ao pool, senão
    // ele ficaria preso numa conexão ociosa e travaria o próximo boot.
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => {});
    client.release();
  }
}
