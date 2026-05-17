import type { Request, Response, NextFunction } from "express";
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

  console.error("Erro não tratado:", err);

  res.status(500).json({
    error: "Erro interno do servidor",
    ...(config.NODE_ENV === "development" && {
      details: err instanceof Error ? err.message : String(err),
    }),
  });
}
