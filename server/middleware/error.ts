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

// Códigos que o multer emite ao analisar os nomes/valores dos campos de texto
// do multipart — nada a ver com o arquivo em si.
const FIELD_ERROR_CODES = new Set([
  "LIMIT_PART_COUNT",
  "LIMIT_FIELD_KEY",
  "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT",
  "LIMIT_FIELD_NESTING",
  "LIMIT_FIELD_ARRAY_INDEX",
  "MISSING_FIELD_NAME",
  "INVALID_FIELD_NAME",
]);

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
    if (FIELD_ERROR_CODES.has(err.code)) {
      return res.status(400).json({ error: "Formulário inválido" });
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
