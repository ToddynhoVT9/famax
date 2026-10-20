import type { Request } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { escapeHtml, type Mail } from "./mailer.js";

/**
 * Verificação de e-mail: um link com um token assinado (JWT, 24 h) para o
 * endereço a confirmar — o do cadastro ou o novo, numa troca de e-mail.
 *
 * O token carrega o endereço. Na confirmação ele precisa bater com o e-mail
 * atual da conta (ainda não verificado) ou com o pending_email; se a pessoa
 * pediu outra troca no meio-tempo, o link antigo deixa de valer sozinho.
 *
 * Sem jti, o requireAuth o recusa como sessão; o `purpose` impede usar um
 * token de outro tipo (login, recuperação de senha) aqui.
 */

const PURPOSE = "verify-email";
export const VERIFY_TOKEN_TTL_HOURS = 24;

export function signVerifyToken(userId: string, email: string): string {
  return jwt.sign({ purpose: PURPOSE, email: email.toLowerCase() }, config.JWT_SECRET, {
    subject: userId,
    expiresIn: `${VERIFY_TOKEN_TTL_HOURS}h`,
  });
}

export function verifyVerifyToken(token: string): { userId: string; email: string } | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as {
      purpose?: string;
      email?: string;
      sub?: string;
    };
    if (payload.purpose !== PURPOSE || !payload.email || !payload.sub) return null;
    return { userId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

/** Base dos links dos e-mails: APP_URL, ou o host da requisição (dev). */
export function appUrl(req: Request): string {
  return config.APP_URL || `${req.protocol}://${req.get("host")}`;
}

/**
 * O token vai no fragmento (#token=), não na query string: o fragmento não é
 * enviado ao servidor nem aparece em Referer e logs de acesso.
 */
export function verifyLink(req: Request, token: string): string {
  return `${appUrl(req)}/html/user-pages/verify-email.html#token=${encodeURIComponent(token)}`;
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="pt-BR"><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px;color:#222">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">
    <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
    ${bodyHtml}
    <p style="font-size:12px;color:#777;margin-top:24px">FAMAX — este é um e-mail automático, não responda.</p>
  </div>
</body></html>`;
}

/** isChange: confirmação de um e-mail NOVO (troca), e não do cadastro. */
export function verificationMail(to: string, name: string, link: string, isChange = false): Mail {
  const intro = isChange
    ? "Você pediu para trocar o e-mail da sua conta no FAMAX para este endereço."
    : "Bem-vindo ao FAMAX! Falta só confirmar que este e-mail é seu.";
  return {
    to,
    subject: isChange ? "Confirme seu novo e-mail no FAMAX" : "Confirme seu e-mail no FAMAX",
    text: [
      `Olá, ${name}.`,
      "",
      intro,
      "Abra o link abaixo para confirmar:",
      link,
      "",
      `O link vale por ${VERIFY_TOKEN_TTL_HOURS} horas.`,
      "Se não foi você, ignore este e-mail.",
    ].join("\n"),
    html: layout(
      isChange ? "Confirme seu novo e-mail" : "Confirme seu e-mail",
      `<p>Olá, ${escapeHtml(name)}.</p>
       <p>${escapeHtml(intro)}</p>
       <p style="margin:20px 0"><a href="${escapeHtml(link)}"
          style="background:#222;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Confirmar e-mail</a></p>
       <p>O link vale por ${VERIFY_TOKEN_TTL_HOURS} horas. Se não foi você, ignore este e-mail.</p>`,
    ),
  };
}

/** Aviso ao e-mail ANTIGO de que alguém pediu para trocar o endereço da conta. */
export function emailChangeRequestedMail(to: string, name: string, newEmail: string): Mail {
  return {
    to,
    subject: "Pedido de troca de e-mail no FAMAX",
    text: [
      `Olá, ${name}.`,
      "",
      `Pediram para trocar o e-mail da sua conta no FAMAX para ${newEmail}.`,
      "A troca só vale depois que o novo endereço for confirmado.",
      "",
      "Se não foi você, troque sua senha imediatamente.",
    ].join("\n"),
    html: layout(
      "Pedido de troca de e-mail",
      `<p>Olá, ${escapeHtml(name)}.</p>
       <p>Pediram para trocar o e-mail da sua conta no FAMAX para <strong>${escapeHtml(newEmail)}</strong>.
          A troca só vale depois que o novo endereço for confirmado.</p>
       <p><strong>Se não foi você</strong>, troque sua senha imediatamente.</p>`,
    ),
  };
}
