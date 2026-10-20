import type pg from "pg";
import { pool } from "../db.js";

/**
 * Bloqueios entre pessoas (tabela user_blocks, migration 026).
 *
 * isBlockedBetween é o ponto único que o chat consulta antes de abrir
 * conversa 1:1, mandar mensagem 1:1 e pôr alguém num grupo (deixado pronto no
 * prompt 11). Vale nos dois sentidos: quem bloqueou também não escreve para
 * o bloqueado — a conversa simplesmente deixa de existir para os dois.
 *
 * `db`: o pool ou o client da transação em andamento.
 */
export async function isBlockedBetween(
  userA: string,
  userB: string,
  db: Pick<pg.PoolClient, "query"> = pool,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [userA, userB],
  );
  return rows.length > 0;
}

/** Ids que `viewerId` bloqueou (para recolher o conteúdo deles na tela). */
export async function blockedByViewer(viewerId: string | undefined): Promise<Set<string>> {
  if (!viewerId) return new Set();
  const { rows } = await pool.query<{ blocked_id: string }>(
    "SELECT blocked_id FROM user_blocks WHERE blocker_id = $1",
    [viewerId],
  );
  return new Set(rows.map((r) => r.blocked_id));
}

export const BLOCKED_MESSAGE = "Não é possível conversar com esta pessoa";
