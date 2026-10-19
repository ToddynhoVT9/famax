import type { Request } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";

/**
 * Sessões de login.
 *
 * O JWT carrega o jti, e a linha em user_sessions com esse jti é a fonte da
 * verdade: assinatura válida não basta, a sessão precisa existir, não estar
 * revogada nem expirada, e o usuário não pode estar excluído. É isso que
 * permite logout, "sair de todos os dispositivos" e, mais adiante, invalidar
 * sessões na troca de senha.
 */

/** Qualquer coisa com .query — o pool ou um client dentro de transação. */
type Queryable = Pick<typeof pool, "query">;

export type SessionPayload = { sub: string; jti: string };

/**
 * Emite um token e grava a sessão correspondente. Única porta de entrada para
 * tokens novos (login e cadastro).
 *
 * Aceita um client para o cadastro gravar a sessão na mesma transação do
 * usuário: se o COMMIT falhar, não sobra sessão de uma conta que não existe.
 */
export async function createSession(
  userId: string,
  req: Request,
  db: Queryable = pool,
): Promise<string> {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
    jwtid: jti,
  });

  // A validade vem do próprio token (que já aplicou JWT_EXPIRES_IN), em vez
  // de reinterpretar o formato "7d"/"12h" aqui — as duas não podem divergir.
  const { exp } = jwt.decode(token) as { exp: number };

  await db.query(
    `INSERT INTO user_sessions
       (session_id, user_id, jti, ip_address, user_agent, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      randomUUID(),
      userId,
      jti,
      req.ip ?? null,
      req.get("user-agent")?.slice(0, 500) ?? null,
      new Date(exp * 1000),
    ],
  );

  return token;
}

/** Devolve o payload se a assinatura for válida e houver jti, ou null. */
export function verifyToken(token: string): SessionPayload | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as Partial<SessionPayload>;
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string") {
      return null;
    }
    return { sub: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}

// last_seen_at só é regravado depois deste intervalo. Um UPDATE por request
// transformaria cada leitura (inclusive o polling do chat, a cada 3s) numa
// escrita.
const LAST_SEEN_THROTTLE = "5 minutes";

/**
 * Procura a sessão ativa do token: existente, não revogada, não expirada, de
 * usuário não excluído. Devolve o session_id, ou null.
 *
 * Uma query só: o CTE de UPDATE atualiza o last_seen_at quando está velho, na
 * mesma ida ao banco. CTEs que modificam dados rodam mesmo sem serem lidos.
 */
export async function findActiveSession(
  payload: SessionPayload,
): Promise<string | null> {
  const { rows } = await pool.query<{ session_id: string }>(
    `WITH active AS (
       SELECT s.session_id, s.last_seen_at
       FROM user_sessions s
       INNER JOIN users u ON u.user_id = s.user_id
       WHERE s.jti = $1
         AND s.user_id = $2
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
         AND u.deleted_at IS NULL
     ), touch AS (
       UPDATE user_sessions
          SET last_seen_at = NOW()
        WHERE session_id IN (
          SELECT session_id FROM active
          WHERE last_seen_at IS NULL
             OR last_seen_at < NOW() - INTERVAL '${LAST_SEEN_THROTTLE}'
        )
     )
     SELECT session_id FROM active`,
    [payload.jti, payload.sub],
  );
  return rows[0]?.session_id ?? null;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

export async function revokeAllSessions(
  userId: string,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

/**
 * Encerra todas as sessões do usuário menos a atual. Usado na troca de senha:
 * quem trocou continua logado aqui, e qualquer sessão aberta com a senha
 * antiga (inclusive a de quem a descobriu) cai.
 */
export async function revokeOtherSessions(
  userId: string,
  keepSessionId: string,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL`,
    [userId, keepSessionId],
  );
}
