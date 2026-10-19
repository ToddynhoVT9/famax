import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { rateLimit } from "../lib/rate-limit.js";
import { BCRYPT_ROUNDS, passwordSchema } from "../lib/password.js";
import {
  createSession,
  revokeAllSessions,
  revokeSession,
} from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
import { sendMailInBackground } from "../lib/mailer.js";
import {
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  codeMatches,
  generateCode,
  hashCode,
  passwordChangedMail,
  recoveryCodeMail,
  signResetToken,
  verifyResetToken,
} from "../lib/password-recovery.js";

const router = Router();

// ===========================================================================
// Rate limit
// ---------------------------------------------------------------------------
// Sem sessão nessas rotas, o limite padrão cai no IP. No login isso não basta:
// um ataque distribuído (muitos IPs, poucas tentativas cada) contra UMA conta
// passaria ileso, então há um segundo limite por identificador. Os dois
// contam só tentativas que falharam (skipSuccessful).
// ===========================================================================

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const tooManyLogins = "Muitas tentativas de login. Tente novamente mais tarde.";

const loginLimitByIp = rateLimit({
  name: "login-ip",
  limit: 10,
  windowMs: FIFTEEN_MINUTES,
  message: tooManyLogins,
  skipSuccessful: true,
});

const loginLimitByIdentifier = rateLimit({
  name: "login-identifier",
  limit: 5,
  windowMs: FIFTEEN_MINUTES,
  message: tooManyLogins,
  skipSuccessful: true,
  // Normalizado para "Alice" e "alice " não virarem contadores separados. O
  // corpo ainda não passou pelo zod aqui, então o tipo é conferido à mão.
  key: (req) => {
    const identifier: unknown = req.body?.identifier;
    return typeof identifier === "string" && identifier.trim()
      ? identifier.trim().toLowerCase()
      : null;
  },
});

const registerLimitByIp = rateLimit({
  name: "register-ip",
  limit: 5,
  windowMs: ONE_HOUR,
  message: "Muitos cadastros a partir desta rede. Tente novamente mais tarde.",
});

// ===========================================================================
// POST /api/auth/register
// ===========================================================================

const registerSchema = z.object({
  email: z.string().email("Email inválido"),
  username: z
    .string()
    .min(3, "Username deve ter no mínimo 3 caracteres")
    .max(50)
    .regex(/^[a-zA-Z0-9_]+$/, "Username só pode conter letras, números e _"),
  password: passwordSchema,
  displayName: z.string().min(1, "Nome de exibição obrigatório"),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: "Você precisa aceitar os termos" }),
  }),
  termsVersion: z.string().default("2026-03"),
  // Público por padrão (ver migration 006); privado é escolha no cadastro.
  isPrivate: z.boolean().default(false),
});

router.post("/register", registerLimitByIp, async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);

    const { rows: existing } = await pool.query(
      "SELECT user_id FROM users WHERE email = $1 OR username = $2 LIMIT 1",
      [data.email, data.username],
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email ou username já cadastrado" });
    }

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

    const userId = randomUUID();
    const profileId = randomUUID();
    const settingsId = randomUUID();
    const acceptanceId = randomUUID();

    let token: string;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO users
         (user_id, email, username, password_hash, terms_accepted)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [userId, data.email, data.username, passwordHash],
      );

      await client.query(
        `INSERT INTO user_profiles
         (profile_id, user_id, display_name)
         VALUES ($1, $2, $3)`,
        [profileId, userId, data.displayName],
      );

      await client.query(
        `INSERT INTO user_settings
         (settings_id, user_id, is_private)
         VALUES ($1, $2, $3)`,
        [settingsId, userId, data.isPrivate],
      );

      await client.query(
        `INSERT INTO terms_acceptance
         (acceptance_id, user_id, terms_version, ip_address)
         VALUES ($1, $2, $3, $4)`,
        [acceptanceId, userId, data.termsVersion, req.ip ?? null],
      );

      // Na mesma transação: o cadastro já devolve um token, e todo token
      // precisa de sessão para autenticar.
      token = await createSession(userId, req, client);

      await client.query("COMMIT");
    } catch (err) {
      // .catch() porque o ROLLBACK também falha quando é a própria conexão que
      // caiu — e aí o erro dele substituiria o original, escondendo a causa.
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return res.status(201).json({
      token,
      user: {
        userId,
        email: data.email,
        username: data.username,
        displayName: data.displayName,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Dados inválidos", details: err.flatten() });
    }
    next(err);
  }
});

// ===========================================================================
// POST /api/auth/login
// ===========================================================================

const loginSchema = z.object({
  identifier: z.string().min(1, "Email ou username obrigatório"),
  password: z.string().min(1, "Senha obrigatória"),
});

router.post("/login", loginLimitByIp, loginLimitByIdentifier, async (req, res, next) => {
  try {
    const { identifier, password } = loginSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT u.user_id, u.email, u.username, u.password_hash, p.display_name
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.user_id
       WHERE (u.email = $1 OR u.username = $1)
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [identifier],
    );

    const user = rows[0];

    const fakeHash = "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidi";
    const passwordOk = user
      ? await bcrypt.compare(password, user.password_hash)
      : (await bcrypt.compare(password, fakeHash), false);

    if (!user || !passwordOk) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    // O jti (gerado no createSession) é o que torna o token único — sem ele
    // dois logins no mesmo segundo geravam tokens idênticos.
    const token = await createSession(user.user_id, req);

    return res.json({
      token,
      user: {
        userId: user.user_id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Dados inválidos", details: err.flatten() });
    }
    next(err);
  }
});

// ===========================================================================
// POST /api/auth/logout — encerra a sessão deste token
// POST /api/auth/logout-all — encerra todas as sessões do usuário
// ---------------------------------------------------------------------------
// Atrás do requireAuth: um token já inválido recebe 401, e o front trata
// igual (limpa o token e segue). Revogar é idempotente.
// ===========================================================================

router.post("/logout", requireAuth, async (req, res, next) => {
  try {
    await revokeSession(req.sessionId!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/logout-all", requireAuth, async (req, res, next) => {
  try {
    await revokeAllSessions(req.userId!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Recuperação de senha
// ---------------------------------------------------------------------------
// Três passos (ver lib/password-recovery.ts). Nenhuma resposta diz se um
// e-mail tem conta: o forgot-password responde sempre igual, e código errado,
// expirado ou de e-mail inexistente dão o mesmo erro.
// ===========================================================================

const normalizedEmail = (req: { body?: { email?: unknown } }) => {
  const email = req.body?.email;
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
};

const forgotLimitByIp = rateLimit({
  name: "forgot-ip",
  limit: 10,
  windowMs: ONE_HOUR,
  message: "Muitos pedidos de recuperação. Tente novamente mais tarde.",
});

// Por e-mail: impede usar o FAMAX para encher a caixa de alguém de códigos.
// 3 em 15 min cobre o "não chegou, reenviar" da tela (que espera 60 s).
const forgotLimitByEmail = rateLimit({
  name: "forgot-email",
  limit: 3,
  windowMs: FIFTEEN_MINUTES,
  message: "Muitos pedidos para este e-mail. Aguarde alguns minutos.",
  key: normalizedEmail,
});

const verifyLimitByIp = rateLimit({
  name: "verify-code-ip",
  limit: 20,
  windowMs: FIFTEEN_MINUTES,
  message: "Muitas tentativas. Tente novamente mais tarde.",
});

const resetLimitByIp = rateLimit({
  name: "reset-password-ip",
  limit: 10,
  windowMs: FIFTEEN_MINUTES,
  message: "Muitas tentativas. Tente novamente mais tarde.",
});

const emailSchema = z.string().trim().email("Email inválido").max(255);

const FORGOT_MESSAGE =
  "Se houver uma conta com este e-mail, enviamos um código de recuperação.";

// Igual para código errado, expirado, já usado ou de e-mail sem conta.
const INVALID_CODE = `Código inválido ou expirado. Depois de ${MAX_CODE_ATTEMPTS} erros é preciso pedir um novo código.`;

const INVALID_RESET =
  "Recuperação inválida ou expirada. Peça um novo código e tente de novo.";

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password { email }
// ---------------------------------------------------------------------------

router.post(
  "/forgot-password",
  forgotLimitByIp,
  forgotLimitByEmail,
  async (req, res, next) => {
    try {
      const email = emailSchema.parse(req.body?.email);

      const { rows } = await pool.query<{ user_id: string; email: string; name: string }>(
        `SELECT u.user_id, u.email, COALESCE(p.display_name, u.username) AS name
         FROM users u
         LEFT JOIN user_profiles p ON p.user_id = u.user_id
         WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL
         LIMIT 1`,
        [email],
      );
      const user = rows[0];

      if (user) {
        const recoveryId = randomUUID();
        const code = generateCode();

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Um código por vez: pedir outro invalida os anteriores.
          await client.query(
            `UPDATE password_recovery SET is_used = TRUE
             WHERE user_id = $1 AND is_used = FALSE`,
            [user.user_id],
          );
          await client.query(
            `INSERT INTO password_recovery
               (recovery_id, user_id, email, code_hash, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))`,
            [recoveryId, user.user_id, user.email, hashCode(recoveryId, code), CODE_TTL_MINUTES],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }

        // Em segundo plano: esperar o provedor só quando a conta existe
        // deixaria o tempo de resposta revelar quais e-mails têm conta.
        sendMailInBackground(recoveryCodeMail(user.email, user.name, code));
      }

      res.json({ message: FORGOT_MESSAGE });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues[0]?.message ?? "Email inválido" });
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/auth/verify-reset-code { email, code }
// ---------------------------------------------------------------------------

const verifyCodeSchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, "O código tem 6 dígitos"),
});

router.post("/verify-reset-code", verifyLimitByIp, async (req, res, next) => {
  try {
    const { email, code } = verifyCodeSchema.parse(req.body);

    const { rows } = await pool.query<{ recovery_id: string; user_id: string }>(
      `SELECT r.recovery_id, r.user_id
       FROM password_recovery r
       INNER JOIN users u ON u.user_id = r.user_id
       WHERE lower(u.email) = lower($1)
         AND u.deleted_at IS NULL
         AND r.is_used = FALSE
         AND r.expires_at > NOW()
       ORDER BY r.created_at DESC
       LIMIT 1`,
      [email],
    );
    const recovery = rows[0];
    if (!recovery) {
      return res.status(400).json({ error: INVALID_CODE });
    }

    // A tentativa é contada ANTES de comparar, num UPDATE atômico com o teto
    // no WHERE. Comparar primeiro deixaria N requisições paralelas passarem
    // todas antes de a contagem subir — mais de 5 chutes por código.
    const { rows: counted } = await pool.query<{ attempts: number; code_hash: string }>(
      `UPDATE password_recovery
       SET attempts = attempts + 1
       WHERE recovery_id = $1 AND is_used = FALSE AND attempts < $2
       RETURNING attempts, code_hash`,
      [recovery.recovery_id, MAX_CODE_ATTEMPTS],
    );
    const attempt = counted[0];
    if (!attempt) {
      return res.status(400).json({ error: INVALID_CODE });
    }

    if (!codeMatches(recovery.recovery_id, code, attempt.code_hash)) {
      if (attempt.attempts >= MAX_CODE_ATTEMPTS) {
        await pool.query(
          "UPDATE password_recovery SET is_used = TRUE WHERE recovery_id = $1",
          [recovery.recovery_id],
        );
      }
      return res.status(400).json({ error: INVALID_CODE });
    }

    await pool.query(
      "UPDATE password_recovery SET verified_at = NOW() WHERE recovery_id = $1",
      [recovery.recovery_id],
    );

    res.json({ resetToken: signResetToken(recovery.user_id, recovery.recovery_id) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Dados inválidos" });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password { resetToken, newPassword }
// ---------------------------------------------------------------------------

const resetPasswordSchema = z.object({
  resetToken: z.string().min(1, INVALID_RESET),
  newPassword: passwordSchema,
});

router.post("/reset-password", resetLimitByIp, async (req, res, next) => {
  try {
    const { resetToken, newPassword } = resetPasswordSchema.parse(req.body);

    const token = verifyResetToken(resetToken);
    if (!token) {
      return res.status(400).json({ error: INVALID_RESET });
    }

    // bcrypt fora da transação: são ~250 ms que não precisam segurar conexão.
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    let user: { email: string; name: string } | undefined;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Consome a recuperação: só uma troca por código, e só se ninguém pediu
      // um código novo depois (o que a teria invalidado).
      const { rowCount } = await client.query(
        `UPDATE password_recovery
         SET is_used = TRUE, used_at = NOW()
         WHERE recovery_id = $1
           AND user_id = $2
           AND is_used = FALSE
           AND verified_at IS NOT NULL`,
        [token.recoveryId, token.userId],
      );

      const { rows } = rowCount
        ? await client.query<{ email: string; name: string }>(
            `UPDATE users u
             SET password_hash = $2
             WHERE u.user_id = $1 AND u.deleted_at IS NULL
             RETURNING u.email, COALESCE(
               (SELECT display_name FROM user_profiles WHERE user_id = u.user_id),
               u.username
             ) AS name`,
            [token.userId, passwordHash],
          )
        : { rows: [] };
      user = rows[0];

      if (!user) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: INVALID_RESET });
      }

      // Quem tinha a senha antiga (inclusive quem a roubou) perde o acesso.
      await revokeAllSessions(token.userId, client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    sendMailInBackground(passwordChangedMail(user.email, user.name));
    res.json({ message: "Senha alterada. Entre com a nova senha." });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Dados inválidos" });
    }
    next(err);
  }
});

export default router;
