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

export default router;
