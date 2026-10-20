import type { RequestHandler } from "express";
import { pool } from "../db.js";

/**
 * Exige e-mail verificado. Usar depois de requireAuth.
 *
 * O que fica travado sem verificação (decisão do prompt 12):
 *  - criar comunidade;
 *  - mandar mensagem no chat e criar grupo.
 * São as ações que mais servem a contas descartáveis (spam em massa, golpe por
 * mensagem direta). Navegar, publicar, comentar, curtir e seguir continuam
 * liberados — dentro de comunidades já existe moderação, e travar tudo
 * afastaria quem só ainda não abriu o e-mail.
 *
 * Responde 403 com code EMAIL_NOT_VERIFIED, para o front oferecer o reenvio.
 */
export const requireVerifiedEmail: RequestHandler = async (req, res, next) => {
  try {
    const { rows } = await pool.query<{ verified: boolean }>(
      "SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE user_id = $1",
      [req.userId],
    );
    if (!rows[0]?.verified) {
      return res.status(403).json({
        error: "Confirme seu e-mail para fazer isso. Enviamos um link quando você se cadastrou.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};
