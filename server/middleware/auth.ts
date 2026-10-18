import type { Request, Response, NextFunction } from "express";
import { findActiveSession, verifyToken } from "../lib/session.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    /** Sessão do token atual — o que o logout revoga. */
    sessionId?: string;
  }
}

/**
 * Assinatura válida não basta: o token precisa ter sessão ativa (ver
 * lib/session.ts). É isso que faz logout e conta excluída valerem na hora,
 * em vez de só quando o token expira.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token ausente" });
  }

  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }

  let sessionId: string | null;
  try {
    sessionId = await findActiveSession(payload);
  } catch (err) {
    // Falha de banco não é credencial inválida — vai para o errorHandler.
    return next(err);
  }

  if (!sessionId) {
    // Mesma mensagem do token inválido: não diz se a sessão foi revogada,
    // expirou ou se a conta foi excluída.
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }

  req.userId = payload.sub;
  req.sessionId = sessionId;
  next();
}

/**
 * Popula req.userId quando há token válido, mas segue adiante sem ele.
 *
 * Usado nas rotas de leitura pública que mudam de forma quando há sessão —
 * o feed da comunidade precisa saber se o usuário já curtiu cada post
 * (liked_by_me), mas continua acessível para quem não está logado.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next();
  }

  // Token inválido, sessão encerrada ou conta excluída em rota opcional é
  // tratado como visitante, não como erro.
  const payload = verifyToken(authHeader.slice(7));
  if (!payload) return next();

  try {
    const sessionId = await findActiveSession(payload);
    if (sessionId) {
      req.userId = payload.sub;
      req.sessionId = sessionId;
    }
  } catch (err) {
    return next(err);
  }
  next();
}
