import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

/**
 * O Supabase exige SSL; um Postgres local (dev ou teste) recusa a negociação e
 * o pg aborta com "server does not support SSL". Por isso o SSL é ligado por
 * padrão e desligado explicitamente via DATABASE_SSL=false.
 */
const useSsl = process.env.DATABASE_SSL !== "false";

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

export async function pingDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log("✅ Postgres (Supabase) conectado");
  } finally {
    client.release();
  }
}
