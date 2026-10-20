import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import jwt from "jsonwebtoken";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { config } from "../config.js";
import { escapeHtml, type Mail } from "./mailer.js";

/**
 * Verificação em duas etapas por TOTP (RFC 6238: 6 dígitos, 30 s, SHA-1 —
 * o que Google Authenticator, Authy, 1Password e afins esperam).
 *
 *  - O segredo fica cifrado no banco com AES-256-GCM e a chave
 *    TWO_FACTOR_KEY (32 bytes, do ambiente). Sem a chave, quem lê o banco não
 *    gera códigos. Sem a chave configurada, a 2FA fica indisponível (503).
 *  - Cada código vale uma vez: o passo de 30 s aceito fica em
 *    two_factor_last_step, e um passo igual ou anterior é recusado.
 *  - Aceita um passo de folga para cada lado (relógio do celular adiantado
 *    ou atrasado em até 30 s).
 *  - Códigos de recuperação: 10, de uso único, guardados como HMAC.
 */

const ISSUER = "FAMAX";
const PERIOD = 30;
export const RECOVERY_CODES = 10;

export function isTwoFactorConfigured(): boolean {
  return config.TWO_FACTOR_KEY !== null;
}

function key(): Buffer {
  if (!config.TWO_FACTOR_KEY) throw new Error("TWO_FACTOR_KEY não configurada");
  return config.TWO_FACTOR_KEY;
}

// ---------------------------------------------------------------------------
// Cifra do segredo: "v1:<iv>:<tag>:<texto cifrado>" em base64url
// ---------------------------------------------------------------------------

export function encryptSecret(base32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(base32, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Segredo 2FA em formato desconhecido");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

export function newSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totp(base32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(base32),
  });
}

/** URI otpauth:// e o QR dela (data URL PNG) para o app escanear. */
export async function provisioning(base32: string, label: string): Promise<{ uri: string; qrCode: string }> {
  const uri = totp(base32, label).toString();
  const qrCode = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return { uri, qrCode };
}

/**
 * Passo de 30 s do código, se ele for válido (com um passo de folga), ou
 * null. Quem chama ainda precisa recusar passos já usados.
 */
export function totpStep(base32: string, code: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(base32, "check").validate({ token: code, window: 1 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / PERIOD) + delta;
}

// ---------------------------------------------------------------------------
// Códigos de recuperação
// ---------------------------------------------------------------------------

// Sem 0/o, 1/l/i: os códigos são digitados à mão, lidos de um papel.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function normalizeRecovery(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashRecovery(code: string): string {
  return createHmac("sha256", key()).update(`recovery:${normalizeRecovery(code)}`).digest("hex");
}

/** Gera os códigos, troca os antigos e devolve os novos (mostrados uma vez). */
export async function replaceRecoveryCodes(client: Pick<PoolClient, "query">, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const chars = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
  await client.query("DELETE FROM two_factor_recovery_codes WHERE user_id = $1", [userId]);
  for (const code of codes) {
    await client.query(
      "INSERT INTO two_factor_recovery_codes (code_id, user_id, code_hash) VALUES ($1, $2, $3)",
      [randomUUID(), userId, hashRecovery(code)],
    );
  }
  return codes;
}

/**
 * Confere o segundo fator: código TOTP de 6 dígitos ou código de
 * recuperação. Consome o que foi usado (o passo TOTP, ou o código de
 * recuperação) num UPDATE condicional — duas requisições com o mesmo código
 * ao mesmo tempo não passam juntas.
 */
export async function checkSecondFactor(
  db: Pick<PoolClient, "query">,
  userId: string,
  code: string,
): Promise<{ ok: false } | { ok: true; usedRecoveryCode: boolean }> {
  const trimmed = code.trim().replace(/\s+/g, "");

  if (/^\d{6}$/.test(trimmed)) {
    const { rows } = await db.query<{ two_factor_secret: string | null }>(
      "SELECT two_factor_secret FROM users WHERE user_id = $1",
      [userId],
    );
    const stored = rows[0]?.two_factor_secret;
    if (!stored) return { ok: false };
    const step = totpStep(decryptSecret(stored), trimmed);
    if (step === null) return { ok: false };
    const { rowCount } = await db.query(
      `UPDATE users SET two_factor_last_step = $2
       WHERE user_id = $1 AND (two_factor_last_step IS NULL OR two_factor_last_step < $2)`,
      [userId, step],
    );
    return rowCount ? { ok: true, usedRecoveryCode: false } : { ok: false };
  }

  if (normalizeRecovery(trimmed).length !== 10) return { ok: false };
  const { rowCount } = await db.query(
    `UPDATE two_factor_recovery_codes SET used_at = NOW()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hashRecovery(trimmed)],
  );
  return rowCount ? { ok: true, usedRecoveryCode: true } : { ok: false };
}

// ---------------------------------------------------------------------------
// mfaToken: "senha certa, falta o segundo fator" (login em dois passos)
// ---------------------------------------------------------------------------

const MFA_PURPOSE = "mfa-login";
export const MFA_TOKEN_TTL_SECONDS = 5 * 60;

/** Sem jti: o requireAuth nunca o aceita como sessão. */
export function signMfaToken(userId: string): string {
  return jwt.sign({ purpose: MFA_PURPOSE }, config.JWT_SECRET, {
    subject: userId,
    expiresIn: MFA_TOKEN_TTL_SECONDS,
  });
}

export function verifyMfaToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as { purpose?: string; sub?: string };
    return payload.purpose === MFA_PURPOSE && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Sujeito do mfaToken sem validar — só para a chave do rate limit. */
export function mfaTokenSubject(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const decoded = jwt.decode(token) as { sub?: string } | null;
  return typeof decoded?.sub === "string" ? decoded.sub : null;
}

// ---------------------------------------------------------------------------
// E-mails
// ---------------------------------------------------------------------------

export function twoFactorChangedMail(to: string, name: string, enabled: boolean): Mail {
  const what = enabled ? "ativada" : "desativada";
  return {
    to,
    subject: `Verificação em duas etapas ${what} no FAMAX`,
    text: [
      `Olá, ${name}.`,
      "",
      `A verificação em duas etapas da sua conta no FAMAX foi ${what}.`,
      "Se não foi você, troque sua senha imediatamente.",
    ].join("\n"),
    html: `<p>Olá, ${escapeHtml(name)}.</p>
       <p>A verificação em duas etapas da sua conta no FAMAX foi <strong>${what}</strong>.</p>
       <p>Se não foi você, troque sua senha imediatamente.</p>`,
  };
}
