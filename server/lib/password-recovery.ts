import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { escapeHtml, type Mail } from "./mailer.js";

/**
 * Recuperação de senha em três passos:
 *
 *   1. forgot-password  gera um código de 6 dígitos (15 min) e manda por e-mail
 *   2. verify-reset-code confere o código (5 tentativas) e devolve um resetToken
 *   3. reset-password   troca a senha com o resetToken (10 min)
 *
 * O código só serve para o passo 2. Separar o passo 3 num token evita reenviar
 * o código (e reabrir a contagem de tentativas) a cada tentativa de senha que
 * o cadastro recusaria.
 */

export const CODE_TTL_MINUTES = 15;
export const MAX_CODE_ATTEMPTS = 5;
const RESET_TOKEN_TTL = "10m";
const RESET_TOKEN_PURPOSE = "password-reset";

/** 6 dígitos, com zeros à esquerda; randomInt é criptograficamente seguro. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * HMAC do código, amarrado à recuperação. Com só um milhão de códigos
 * possíveis, um SHA-256 simples seria revertido por força bruta por quem lesse
 * a tabela; o HMAC depende do JWT_SECRET, que não está no banco. O recoveryId
 * no conteúdo impede reaproveitar um hash entre recuperações.
 */
export function hashCode(recoveryId: string, code: string): string {
  return createHmac("sha256", config.JWT_SECRET)
    .update(`password-recovery:${recoveryId}:${code}`)
    .digest("hex");
}

/** Comparação em tempo constante — o tempo não diz quantos dígitos bateram. */
export function codeMatches(recoveryId: string, code: string, storedHash: string): boolean {
  const expected = Buffer.from(hashCode(recoveryId, code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return expected.length === stored.length && timingSafeEqual(expected, stored);
}

// ---------------------------------------------------------------------------
// resetToken
// ---------------------------------------------------------------------------

/**
 * JWT curto que prova "esta pessoa acertou o código desta recuperação".
 *
 * Não tem jti, então o requireAuth o recusa como sessão; e o `purpose` impede
 * o contrário — um token de login usado como resetToken.
 */
export function signResetToken(userId: string, recoveryId: string): string {
  return jwt.sign({ purpose: RESET_TOKEN_PURPOSE, rid: recoveryId }, config.JWT_SECRET, {
    subject: userId,
    expiresIn: RESET_TOKEN_TTL,
  });
}

export function verifyResetToken(token: string): { userId: string; recoveryId: string } | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as {
      purpose?: string;
      rid?: string;
      sub?: string;
    };
    if (payload.purpose !== RESET_TOKEN_PURPOSE || !payload.rid || !payload.sub) return null;
    return { userId: payload.sub, recoveryId: payload.rid };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// E-mails
// ---------------------------------------------------------------------------

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

export function recoveryCodeMail(to: string, name: string, code: string): Mail {
  return {
    to,
    subject: `Seu código de recuperação do FAMAX: ${code}`,
    text: [
      `Olá, ${name}.`,
      "",
      `Seu código para redefinir a senha do FAMAX é: ${code}`,
      "",
      `Ele vale por ${CODE_TTL_MINUTES} minutos e só pode ser usado uma vez.`,
      "Se você não pediu isto, ignore este e-mail — sua senha continua a mesma.",
    ].join("\n"),
    html: layout(
      "Recuperação de senha",
      `<p>Olá, ${escapeHtml(name)}.</p>
       <p>Seu código para redefinir a senha do FAMAX é:</p>
       <p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:16px 0">${escapeHtml(code)}</p>
       <p>Ele vale por ${CODE_TTL_MINUTES} minutos e só pode ser usado uma vez.</p>
       <p>Se você não pediu isto, ignore este e-mail — sua senha continua a mesma.</p>`,
    ),
  };
}

export function passwordChangedMail(to: string, name: string): Mail {
  return {
    to,
    subject: "Sua senha do FAMAX foi alterada",
    text: [
      `Olá, ${name}.`,
      "",
      "A senha da sua conta no FAMAX acabou de ser alterada pela recuperação de senha.",
      "Por segurança, todas as sessões abertas foram encerradas.",
      "",
      "Se não foi você, peça uma nova recuperação de senha imediatamente.",
    ].join("\n"),
    html: layout(
      "Senha alterada",
      `<p>Olá, ${escapeHtml(name)}.</p>
       <p>A senha da sua conta no FAMAX acabou de ser alterada pela recuperação de senha.
          Por segurança, todas as sessões abertas foram encerradas.</p>
       <p><strong>Se não foi você</strong>, peça uma nova recuperação de senha imediatamente.</p>`,
    ),
  };
}
