import type pg from "pg";

/**
 * Ponto único de checagem de bloqueio entre duas pessoas.
 *
 * Bloqueios entram no prompt de conta e segurança (12). Até lá ninguém está
 * bloqueado, mas o chat já pergunta aqui antes de abrir conversa 1:1, enviar
 * mensagem 1:1 e pôr alguém num grupo — quando a tabela de bloqueios
 * existir, só esta função muda.
 *
 * `db`: o pool ou o client da transação em andamento.
 */
export async function isBlockedBetween(
  _userA: string,
  _userB: string,
  _db?: Pick<pg.PoolClient, "query">,
): Promise<boolean> {
  return false;
}

export const BLOCKED_MESSAGE = "Não é possível conversar com esta pessoa";
