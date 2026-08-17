import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token ausente" });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }
}

/**
 * Popula req.userId quando há token válido, mas segue adiante sem ele.
 *
 * Usado nas rotas de leitura pública que mudam de forma quando há sessão —
 * o feed da comunidade precisa saber se o usuário já curtiu cada post
 * (liked_by_me), mas continua acessível para quem não está logado.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next();
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), config.JWT_SECRET) as {
      sub: string;
    };
    req.userId = payload.sub;
  } catch {
    // Token inválido em rota opcional é tratado como visitante, não como erro.
  }
  next();
}
