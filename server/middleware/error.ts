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

// O limite de tamanho é aplicado pelo multer, antes da rota — a mensagem sai
// daqui, pelo nome do campo do arquivo. Os valores batem com os `limits` de
// cada upload (communities.routes.ts, me.routes.ts).
const FILE_SIZE_MESSAGES: Record<string, string> = {
  cover: "A capa deve ter no máximo 2MB",
  avatar: "A foto de perfil deve ter no máximo 1MB",
  banner: "O banner deve ter no máximo 2MB",
};

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
      const message =
        FILE_SIZE_MESSAGES[err.field ?? ""] ?? "Arquivo muito grande";
      return res.status(413).json({ error: message });
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
