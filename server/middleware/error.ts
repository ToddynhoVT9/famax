import type { Request, Response, NextFunction } from "express";
import { MulterError } from "multer";
import { config } from "../config.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Multer rejeita o upload dentro do próprio middleware, então o erro nunca
  // passa pelo try/catch da rota — chega aqui.
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "A capa deve ter no máximo 2MB" });
    }
    return res.status(400).json({ error: "Arquivo inválido" });
  }

  console.error("Erro não tratado:", err);

  res.status(500).json({
    error: "Erro interno do servidor",
    ...(config.NODE_ENV === "development" && {
      details: err instanceof Error ? err.message : String(err),
    }),
  });
}
