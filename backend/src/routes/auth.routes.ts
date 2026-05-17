import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";

const router = Router();

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
  password: z
    .string()
    .min(8, "Senha deve ter no mínimo 8 caracteres")
    .refine(
      (pwd) => (pwd.match(/\d/g) ?? []).length >= 3,
      "Senha precisa de pelo menos 3 números",
    )
    .refine(
      (pwd) => /[^A-Za-z0-9]/.test(pwd),
      "Senha precisa de pelo menos 1 caractere especial",
    ),
  displayName: z.string().min(1, "Nome de exibição obrigatório"),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: "Você precisa aceitar os termos" }),
  }),
  termsVersion: z.string().default("2026-03"),
});

router.post("/register", async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);

    const [existing] = await pool.execute<any[]>(
      "SELECT user_id FROM users WHERE email = ? OR username = ? LIMIT 1",
      [data.email, data.username],
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email ou username já cadastrado" });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const userId = randomUUID();
    const profileId = randomUUID();
    const settingsId = randomUUID();
    const acceptanceId = randomUUID();

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.execute(
        `INSERT INTO users
         (user_id, email, username, password_hash, terms_accepted)
         VALUES (?, ?, ?, ?, TRUE)`,
        [userId, data.email, data.username, passwordHash],
      );

      await connection.execute(
        `INSERT INTO user_profiles
         (profile_id, user_id, display_name)
         VALUES (?, ?, ?)`,
        [profileId, userId, data.displayName],
      );

      await connection.execute(
        `INSERT INTO user_settings
         (settings_id, user_id, is_private)
         VALUES (?, ?, TRUE)`,
        [settingsId, userId],
      );

      await connection.execute(
        `INSERT INTO terms_acceptance
         (acceptance_id, user_id, terms_version, ip_address)
         VALUES (?, ?, ?, ?)`,
        [acceptanceId, userId, data.termsVersion, req.ip ?? null],
      );

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const token = jwt.sign({ sub: userId }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN,
    });

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

router.post("/login", async (req, res, next) => {
  try {
    const { identifier, password } = loginSchema.parse(req.body);

    const [rows] = await pool.execute<any[]>(
      `SELECT u.user_id, u.email, u.username, u.password_hash, p.display_name
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.user_id
       WHERE (u.email = ? OR u.username = ?)
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [identifier, identifier],
    );

    const user = rows[0];

    const fakeHash = "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidi";
    const passwordOk = user
      ? await bcrypt.compare(password, user.password_hash)
      : (await bcrypt.compare(password, fakeHash), false);

    if (!user || !passwordOk) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const token = jwt.sign({ sub: user.user_id }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN,
    });

    await pool.execute(
      `INSERT INTO user_sessions (session_id, user_id, token, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [
        randomUUID(),
        user.user_id,
        token,
        req.ip ?? null,
        req.get("user-agent") ?? null,
      ],
    );

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

export default router;
