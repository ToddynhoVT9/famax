/**
 * Copia server/sql/ para dist/sql/.
 *
 * O tsc só emite .ts, mas o embedded-db.ts resolve o baseline e as migrations
 * relativo ao próprio diretório — em dev isso é server/sql/, em produção
 * dist/sql/. Sem esta cópia o artefato de build não tem o schema.
 *
 * Em Node, não em `cp -r`: o build roda no Windows e o deploy no Linux.
 */
import { cp, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, "server", "sql");
const to = path.join(root, "dist", "sql");

await cp(from, to, { recursive: true });

const files = await readdir(to, { recursive: true });
console.log(`sql -> dist/sql (${files.length} itens)`);
