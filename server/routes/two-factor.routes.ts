import { Router, type Response } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { sendMailInBackground } from "../lib/mailer.js";
import {
  checkSecondFactor,
  decryptSecret,
  encryptSecret,
  isTwoFactorConfigured,
  newSecret,
  provisioning,
  replaceRecoveryCodes,
  totpStep,
  twoFactorChangedMail,
} from "../lib/two-factor.js";

/**
 * Configuração da verificação em duas etapas (o login em dois passos fica
 * em auth.routes.ts). Fluxo:
 *
 *   1. POST /me/2fa/setup   gera um segredo PENDENTE e devolve QR + texto
 *   2. POST /me/2fa/enable  { code } prova que o app gera códigos certos:
 *                           a 2FA liga e os 10 códigos de recuperação
 *                           aparecem — uma vez só
 *   3. POST /me/2fa/disable { password, code } desliga
 *      POST /me/2fa/recovery-codes { password, code } gera códigos novos
 *
 * Desligar e regerar exigem senha E segundo fator: uma sessão roubada sozinha
 * não desarma a proteção.
 */
const router = Router();

const TWO_FACTOR_UNAVAILABLE = "Verificação em duas etapas não está configurada no servidor";

function unavailable(res: Response) {
  return res.status(503).json({ error: TWO_FACTOR_UNAVAILABLE });
}


const twoFactorLimit = rateLimit({
  name: "two-factor-settings",
  limit: 10,
  windowMs: 15 * 60_000,
  message: "Muitas tentativas. Aguarde alguns minutos.",
});

async function accountOf(userId: string) {
  const { rows } = await pool.query<{
    username: string;
    email: string;
    name: string;
    password_hash: string;
    two_factor_enabled: boolean;
    two_factor_pending_secret: string | null;
  }>(
    `SELECT u.username, u.email, COALESCE(p.display_name, u.username) AS name, u.password_hash,
            u.two_factor_enabled, u.two_factor_pending_secret
     FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
     WHERE u.user_id = $1`,
    [userId],
  );
  return rows[0];
}

// ===========================================================================
// POST /api/me/2fa/setup
// ===========================================================================

router.post("/me/2fa/setup", requireAuth, twoFactorLimit, async (req, res, next) => {
  try {
    if (!isTwoFactorConfigured()) return unavailable(res);
    const account = await accountOf(req.userId!);
    if (account.two_factor_enabled) {
      return res.status(409).json({ error: "A verificação em duas etapas já está ativa" });
    }

    const secret = newSecret();
    await pool.query("UPDATE users SET two_factor_pending_secret = $2 WHERE user_id = $1", [
      req.userId,
      encryptSecret(secret),
    ]);
    const { uri, qrCode } = await provisioning(secret, account.username);
    // O segredo em texto vai junto para quem não consegue escanear o QR.
    res.json({ secret, otpauthUri: uri, qrCode });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/me/2fa/enable { code }
// ===========================================================================

router.post("/me/2fa/enable", requireAuth, twoFactorLimit, async (req, res, next) => {
  try {
    if (!isTwoFactorConfigured()) return unavailable(res);
    const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, "O código tem 6 dígitos") }).parse(req.body);

    const account = await accountOf(req.userId!);
    if (account.two_factor_enabled) {
      return res.status(409).json({ error: "A verificação em duas etapas já está ativa" });
    }
    if (!account.two_factor_pending_secret) {
      return res.status(400).json({ error: "Comece a ativação de novo (o QR expirou)" });
    }

    const step = totpStep(decryptSecret(account.two_factor_pending_secret), code);
    if (step === null) {
      return res.status(400).json({ error: "Código incorreto. Confira o horário do celular e tente o código atual." });
    }

    const client = await pool.connect();
    let recoveryCodes: string[];
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE users
         SET two_factor_secret = two_factor_pending_secret,
             two_factor_pending_secret = NULL,
             two_factor_enabled = TRUE,
             two_factor_last_step = $2
         WHERE user_id = $1`,
        [req.userId, step],
      );
      recoveryCodes = await replaceRecoveryCodes(client, req.userId!);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    sendMailInBackground(twoFactorChangedMail(account.email, account.name, true));
    res.json({ enabled: true, recoveryCodes });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/me/2fa/disable { password, code }
// POST /api/me/2fa/recovery-codes { password, code }
// ===========================================================================

const confirmSchema = z.object({
  password: z.string().min(1, "Informe sua senha"),
  code: z.string().trim().min(6, "Informe o código do app ou um código de recuperação").max(20),
});

/** Senha + segundo fator; responde o erro e devolve false se falhar. */
async function confirmIdentity(res: Response, userId: string, password: string, code: string) {
  const account = await accountOf(userId);
  if (!account.two_factor_enabled) {
    res.status(400).json({ error: "A verificação em duas etapas não está ativa" });
    return null;
  }
  // 400 e não 401: 401 significa "sessão inválida" para o front.
  if (!(await bcrypt.compare(password, account.password_hash))) {
    res.status(400).json({ error: "Senha incorreta" });
    return null;
  }
  const check = await checkSecondFactor(pool, userId, code);
  if (!check.ok) {
    res.status(400).json({ error: "Código incorreto" });
    return null;
  }
  return account;
}

router.post("/me/2fa/disable", requireAuth, twoFactorLimit, async (req, res, next) => {
  try {
    if (!isTwoFactorConfigured()) return unavailable(res);
    const { password, code } = confirmSchema.parse(req.body);
    const account = await confirmIdentity(res, req.userId!, password, code);
    if (!account) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE users
         SET two_factor_enabled = FALSE, two_factor_secret = NULL,
             two_factor_pending_secret = NULL, two_factor_last_step = NULL
         WHERE user_id = $1`,
        [req.userId],
      );
      await client.query("DELETE FROM two_factor_recovery_codes WHERE user_id = $1", [req.userId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    sendMailInBackground(twoFactorChangedMail(account.email, account.name, false));
    res.json({ enabled: false });
  } catch (err) {
    next(err);
  }
});

router.post("/me/2fa/recovery-codes", requireAuth, twoFactorLimit, async (req, res, next) => {
  try {
    if (!isTwoFactorConfigured()) return unavailable(res);
    const { password, code } = confirmSchema.parse(req.body);
    if (!(await confirmIdentity(res, req.userId!, password, code))) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const recoveryCodes = await replaceRecoveryCodes(client, req.userId!);
      await client.query("COMMIT");
      res.json({ recoveryCodes });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

export default router;
