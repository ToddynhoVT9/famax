import type { Request, Response, NextFunction } from "express";
import { MulterError } from "multer";
import { z } from "zod";
import { config } from "../config.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Falha de validação com mensagem fixa (ex.: "ID de comunidade inválido"), no
 * lugar da primeira regra violada. Vem de parseWith; o errorHandler responde.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public zodError: z.ZodError,
  ) {
    super(message);
  }
}

/**
 * schema.parse com a mensagem de erro escolhida pela rota. Sem ela (parse
 * puro), o errorHandler responde com a primeira regra violada — que é o que
 * quase toda rota quer; esta é para as que mostram uma frase só.
 */
export function parseWith<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError(message, result.error);
  return result.data;
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
  images: "Cada imagem deve ter no máximo 2MB",
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

  // Validação (zod): antes cada rota repetia este if no próprio catch. O
  // formato é sempre { error, details } — `error` é a frase para o front
  // mostrar, `details` o detalhamento por campo.
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message, details: err.zodError.flatten() });
  }
  if (err instanceof z.ZodError) {
    return res
      .status(400)
      .json({ error: err.issues[0]?.message ?? "Dados inválidos", details: err.flatten() });
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
    if (err.code === "LIMIT_FILE_COUNT" || (err.code === "LIMIT_UNEXPECTED_FILE" && err.field === "images")) {
      return res.status(400).json({ error: "Arquivos demais de uma vez" });
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
