import { Router, type Request } from "express";
import bcrypt from "bcrypt";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { BCRYPT_ROUNDS, passwordSchema } from "../lib/password.js";
import { revokeOtherSessions } from "../lib/session.js";
import { sendMailInBackground } from "../lib/mailer.js";
import {
  emailChangeRequestedMail,
  signVerifyToken,
  verificationMail,
  verifyLink,
} from "../lib/email-verification.js";
import {
  ADULT_AGE,
  MAX_SOCIAL_LINKS,
  MIN_AGE,
  SOCIAL_PLATFORMS,
  ageFrom,
  loadSocialLinks,
} from "../lib/profile.js";
import {
  deleteImageByUrl,
  isStorageEnabled,
  uploadImage,
  validateImage,
} from "../lib/storage.js";

const router = Router();

function zodError(res: import("express").Response, err: z.ZodError) {
  // A primeira mensagem vai em `error` para o front mostrar direto; o
  // detalhamento completo continua em `details`.
  const first = err.issues[0]?.message ?? "Dados inválidos";
  return res.status(400).json({ error: first, details: err.flatten() });
}

// ===========================================================================
// GET /api/me — usuário logado, com perfil e configurações
// ---------------------------------------------------------------------------
// Uma chamada por página (o front guarda em cache): é a base do header, das
// guardas de página e da tela de configurações. As rotas de edição abaixo
// devolvem este mesmo formato, para o front só trocar o objeto.
// ===========================================================================

async function loadMe(userId: string) {
  // birth_date vai como texto: o pg converte DATE em Date à meia-noite do
  // fuso do servidor, e o JSON (UTC) podia mostrar o dia anterior.
  const { rows } = await pool.query(
    `SELECT
       u.user_id,
       u.email,
       u.username,
       u.email_verified_at,
       u.pending_email,
       u.is_adult,
       u.two_factor_enabled,
       (SELECT COUNT(*)::int FROM two_factor_recovery_codes r
        WHERE r.user_id = u.user_id AND r.used_at IS NULL) AS recovery_codes_left,
       u.is_admin,
       u.created_at,
       up.display_name,
       up.avatar_url,
       up.banner_url,
       up.bio,
       up.nickname,
       up.birth_date::text AS birth_date,
       up.gender,
       us.is_private,
       us.notify_likes,
       us.notify_comments,
       us.notify_replies,
       us.notify_follows,
       us.notify_events
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.user_id
     LEFT JOIN user_settings us ON us.user_id = u.user_id
     WHERE u.user_id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    // Troca de e-mail aguardando a confirmação do endereço novo.
    pendingEmail: row.pending_email,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bannerUrl: row.banner_url,
    bio: row.bio,
    nickname: row.nickname,
    birthDate: row.birth_date,
    gender: row.gender,
    // Mesma regra da busca de usuários: sem linha de settings, privado.
    isPrivate: row.is_private ?? true,
    isAdult: row.is_adult,
    twoFactorEnabled: row.two_factor_enabled,
    recoveryCodesLeft: row.recovery_codes_left,
    // Admin do site: o header mostra o link da fila de denúncias de usuários.
    isAdmin: row.is_admin === true,
    // Preferências de notificação; sem linha de settings, tudo ligado.
    notifyLikes: row.notify_likes ?? true,
    notifyComments: row.notify_comments ?? true,
    notifyReplies: row.notify_replies ?? true,
    notifyFollows: row.notify_follows ?? true,
    notifyEvents: row.notify_events ?? true,
    createdAt: row.created_at,
    socialLinks: await loadSocialLinks(userId),
  };
}

/** Responde com o /me atualizado — formato único para todas as edições. */
async function sendMe(req: Request, res: import("express").Response) {
  const me = await loadMe(req.userId!);
  if (!me) {
    // O requireAuth já garante que o usuário existe; só chega aqui numa
    // corrida com a exclusão da conta.
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }
  return res.json({ user: me });
}

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    await sendMe(req, res);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// PATCH /api/me/profile — nome, apelido, bio, nascimento, gênero
// ---------------------------------------------------------------------------
// Atualização parcial: só os campos enviados mudam. String vazia em apelido
// e bio vira null (o campo foi apagado, não preenchido com "").
// ===========================================================================

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} deve ter no máximo ${max} caracteres`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data de nascimento inválida")
  // "2023-02-31" passa na regex; a volta pelo Date pega o dia que não existe.
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "Data de nascimento inválida")
  .refine((value) => ageFrom(value) >= 0 && new Date(value) < new Date(), "A data de nascimento precisa estar no passado")
  .refine((value) => ageFrom(value) >= MIN_AGE, `É preciso ter pelo menos ${MIN_AGE} anos`)
  .refine((value) => ageFrom(value) <= 120, "Data de nascimento inválida");

const profileSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, "Nome de exibição obrigatório")
      .max(100, "Nome de exibição deve ter no máximo 100 caracteres")
      .optional(),
    nickname: optionalText(50, "Apelido"),
    bio: optionalText(500, "Bio"),
    birthDate: birthDateSchema.nullable().optional(),
    gender: z
      .enum(["masculino", "feminino", "outro"], {
        errorMap: () => ({ message: "Gênero inválido" }),
      })
      .nullable()
      .optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "Nada para atualizar");

const PROFILE_COLUMNS = {
  displayName: "display_name",
  nickname: "nickname",
  bio: "bio",
  birthDate: "birth_date",
  gender: "gender",
} as const;

router.patch("/me/profile", requireAuth, async (req, res, next) => {
  try {
    const data = profileSchema.parse(req.body);

    const sets: string[] = [];
    const params: unknown[] = [req.userId];
    for (const [key, column] of Object.entries(PROFILE_COLUMNS)) {
      if (key in data) {
        params.push(data[key as keyof typeof data] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE user_profiles SET ${sets.join(", ")} WHERE user_id = $1`,
        params,
      );

      // Conteúdo adulto depende da idade: se a data nova (ou a falta dela)
      // deixa de comprovar 18 anos, a flag cai junto. Sem isto bastaria pôr
      // uma data falsa, ligar "Adulto" e depois corrigir a data.
      if ("birthDate" in data) {
        const birthDate = data.birthDate ?? null;
        if (!birthDate || ageFrom(birthDate) < ADULT_AGE) {
          await client.query("UPDATE users SET is_adult = FALSE WHERE user_id = $1", [
            req.userId,
          ]);
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await sendMe(req, res);
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

// ===========================================================================
// PATCH /api/me/settings — perfil privado e conteúdo adulto
// ===========================================================================

const settingsSchema = z
  .object({
    isPrivate: z.boolean().optional(),
    isAdult: z.boolean().optional(),
    notifyLikes: z.boolean().optional(),
    notifyComments: z.boolean().optional(),
    notifyReplies: z.boolean().optional(),
    notifyFollows: z.boolean().optional(),
    notifyEvents: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "Nada para atualizar");

router.patch("/me/settings", requireAuth, async (req, res, next) => {
  try {
    const data = settingsSchema.parse(req.body);

    if (data.isAdult === true) {
      const { rows } = await pool.query<{ birth_date: string | null }>(
        "SELECT birth_date::text AS birth_date FROM user_profiles WHERE user_id = $1",
        [req.userId],
      );
      const birthDate = rows[0]?.birth_date ?? null;
      if (!birthDate || ageFrom(birthDate) < ADULT_AGE) {
        return res.status(400).json({
          error: `Para ativar conteúdo adulto, informe em "Sobre" uma data de nascimento com ${ADULT_AGE} anos ou mais.`,
        });
      }
    }

    if (data.isAdult !== undefined) {
      await pool.query("UPDATE users SET is_adult = $2 WHERE user_id = $1", [
        req.userId,
        data.isAdult,
      ]);
    }

    // Colunas de user_settings: nomes fixos aqui, nunca vindos da requisição.
    const settingsColumns: Array<[string, boolean | undefined]> = [
      ["is_private", data.isPrivate],
      ["notify_likes", data.notifyLikes],
      ["notify_comments", data.notifyComments],
      ["notify_replies", data.notifyReplies],
      ["notify_follows", data.notifyFollows],
      ["notify_events", data.notifyEvents],
    ];
    const changed = settingsColumns.filter(([, value]) => value !== undefined);
    if (changed.length > 0) {
      // Upsert: todo cadastro cria a linha, mas uma conta antiga sem ela não
      // pode ficar presa sem conseguir mudar as configurações. Uma conta sem
      // linha nasce privada (o padrão antigo), como lê o loadMe.
      const columns = changed.map(([column]) => column);
      const values = changed.map(([, value]) => value);
      const hasPrivate = columns.includes("is_private");
      await pool.query(
        `INSERT INTO user_settings (settings_id, user_id, ${columns.join(", ")}${hasPrivate ? "" : ", is_private"})
         VALUES ($1, $2, ${values.map((_, i) => `$${i + 3}`).join(", ")}${hasPrivate ? "" : ", TRUE"})
         ON CONFLICT (user_id) DO UPDATE SET
           ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}`,
        [randomUUID(), req.userId, ...values],
      );
    }

    await sendMe(req, res);
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

// ===========================================================================
// POST /api/me/password — troca de senha
// ---------------------------------------------------------------------------
// Exige a senha atual (um token roubado não basta para tomar a conta) e
// derruba as outras sessões, mantendo esta. Senha atual errada é 400, não
// 401: 401 significa "sessão inválida" para o front, que deslogaria.
// ===========================================================================

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Informe a senha atual"),
  newPassword: passwordSchema,
});

router.post(
  "/me/password",
  requireAuth,
  // Por usuário. Só tentativas que falharam contam: é a adivinhação da senha
  // atual que precisa de freio.
  rateLimit({
    name: "change-password",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    message: "Muitas tentativas. Tente novamente mais tarde.",
    skipSuccessful: true,
  }),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = passwordChangeSchema.parse(req.body);

      const { rows } = await pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE user_id = $1",
        [req.userId],
      );
      const hash = rows[0]?.password_hash;
      if (!hash || !(await bcrypt.compare(currentPassword, hash))) {
        return res.status(400).json({ error: "Senha atual incorreta" });
      }

      if (await bcrypt.compare(newPassword, hash)) {
        return res
          .status(400)
          .json({ error: "A nova senha deve ser diferente da atual" });
      }

      const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE users SET password_hash = $2 WHERE user_id = $1", [
          req.userId,
          newHash,
        ]);
        await revokeOtherSessions(req.userId!, req.sessionId!, client);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      res.status(204).end();
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

// ===========================================================================
// PATCH /api/me/email — pede a troca de e-mail { newEmail, password }
// DELETE /api/me/email/pending — cancela a troca pendente
// ---------------------------------------------------------------------------
// Exige a senha (um token roubado não basta para desviar a conta). O novo
// endereço vai para pending_email e recebe o link de confirmação; o antigo
// recebe um aviso. Só ao confirmar o link o e-mail da conta muda — até lá
// login e recuperação seguem no endereço antigo.
// ===========================================================================

const emailChangeSchema = z.object({
  newEmail: z.string().trim().email("Email inválido").max(255),
  password: z.string().min(1, "Informe sua senha"),
});

router.patch(
  "/me/email",
  requireAuth,
  rateLimit({
    name: "change-email",
    limit: 5,
    windowMs: 60 * 60_000,
    message: "Muitos pedidos de troca de e-mail. Tente mais tarde.",
  }),
  async (req, res, next) => {
    try {
      const { newEmail, password } = emailChangeSchema.parse(req.body);
      const email = newEmail.toLowerCase();

      const { rows } = await pool.query<{ password_hash: string; email: string; name: string }>(
        `SELECT u.password_hash, u.email, COALESCE(p.display_name, u.username) AS name
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
         WHERE u.user_id = $1`,
        [req.userId],
      );
      const user = rows[0];
      // 400 e não 401: 401 significa "sessão inválida" para o front.
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(400).json({ error: "Senha incorreta" });
      }
      if (user.email.toLowerCase() === email) {
        return res.status(400).json({ error: "Este já é o seu e-mail" });
      }
      const { rows: taken } = await pool.query(
        "SELECT 1 FROM users WHERE lower(email) = $1 AND user_id <> $2",
        [email, req.userId],
      );
      if (taken.length > 0) {
        return res.status(409).json({ error: "Este e-mail já está em uso por outra conta." });
      }

      await pool.query("UPDATE users SET pending_email = $2 WHERE user_id = $1", [req.userId, email]);
      sendMailInBackground(
        verificationMail(email, user.name, verifyLink(req, signVerifyToken(req.userId!, email)), true),
      );
      sendMailInBackground(emailChangeRequestedMail(user.email, user.name, email));

      await sendMe(req, res);
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

router.delete("/me/email/pending", requireAuth, async (req, res, next) => {
  try {
    await pool.query("UPDATE users SET pending_email = NULL WHERE user_id = $1", [req.userId]);
    await sendMe(req, res);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST/DELETE /api/me/avatar e /api/me/banner
// ---------------------------------------------------------------------------
// A validação (tamanho, tipo real pelos magic bytes) roda sempre; só depois
// se verifica o Storage. Assim um arquivo que não é imagem recebe 400 com ou
// sem Storage, e uma imagem válida sem Storage recebe 503 explicado — em vez
// de "sucesso" sem foto, como a capa de comunidade (que é opcional) faz.
// ===========================================================================

const MEDIA = {
  avatar: { column: "avatar_url", maxBytes: 1024 * 1024, label: "A foto de perfil" },
  banner: { column: "banner_url", maxBytes: 2 * 1024 * 1024, label: "O banner" },
} as const;

for (const [field, media] of Object.entries(MEDIA)) {
  // Em memória, como a capa: validada e repassada ao Storage sem tocar o
  // disco. fieldArrayIndexLimit: 0 pelo mesmo motivo da capa (ver
  // communities.routes.ts) — nenhum campo indexado é legítimo aqui.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: media.maxBytes, files: 1, fieldArrayIndexLimit: 0 },
  });

  router.post(
    `/me/${field}`,
    requireAuth,
    rateLimit({ name: `upload-${field}`, limit: 10, windowMs: 60_000 }),
    upload.single(field),
    async (req, res, next) => {
      try {
        if (!req.file) {
          return res
            .status(400)
            .json({ error: `Envie a imagem no campo "${field}"` });
        }

        validateImage(req.file.buffer, media);

        if (!isStorageEnabled()) {
          return res
            .status(503)
            .json({ error: "Upload de imagens não está configurado no servidor" });
        }

        const url = await uploadImage(req.file.buffer, {
          ...media,
          bucket: config.SUPABASE_USER_MEDIA_BUCKET,
          folder: req.userId!,
        });

        // RETURNING do valor antigo: a imagem anterior é removida do Storage
        // só depois que o banco já aponta para a nova.
        const { rows } = await pool.query<{ old_url: string | null }>(
          `UPDATE user_profiles new
           SET ${media.column} = $2
           FROM user_profiles old
           WHERE new.user_id = $1 AND old.profile_id = new.profile_id
           RETURNING old.${media.column} AS old_url`,
          [req.userId, url],
        );
        await deleteImageByUrl(rows[0]?.old_url ?? null, config.SUPABASE_USER_MEDIA_BUCKET);

        await sendMe(req, res);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(`/me/${field}`, requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query<{ old_url: string | null }>(
        `UPDATE user_profiles new
         SET ${media.column} = NULL
         FROM user_profiles old
         WHERE new.user_id = $1 AND old.profile_id = new.profile_id
         RETURNING old.${media.column} AS old_url`,
        [req.userId],
      );
      await deleteImageByUrl(rows[0]?.old_url ?? null, config.SUPABASE_USER_MEDIA_BUCKET);

      await sendMe(req, res);
    } catch (err) {
      next(err);
    }
  });
}

// ===========================================================================
// PUT /api/me/social-links — substitui a lista inteira
// ---------------------------------------------------------------------------
// PUT e não PATCH: o editor do front manda a lista como está na tela, e
// "o que não veio foi removido" é a semântica mais simples de acertar.
// ===========================================================================

const socialLinksSchema = z.object({
  links: z
    .array(
      z.object({
        platform: z.enum(SOCIAL_PLATFORMS, {
          errorMap: () => ({ message: "Rede social inválida" }),
        }),
        url: z
          .string()
          .trim()
          .max(500, "Link muito longo")
          .url("Link inválido")
          // Só https: o link vira <a href> no perfil, e "javascript:" ou
          // "http:" ali seriam XSS ou downgrade.
          .refine((url) => url.startsWith("https://"), "O link deve começar com https://"),
      }),
    )
    .max(MAX_SOCIAL_LINKS, `No máximo ${MAX_SOCIAL_LINKS} redes sociais`)
    .refine(
      (links) => new Set(links.map((l) => l.url)).size === links.length,
      "Há links repetidos",
    ),
});

router.put("/me/social-links", requireAuth, async (req, res, next) => {
  try {
    const { links } = socialLinksSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM user_social_links WHERE user_id = $1", [req.userId]);
      for (const link of links) {
        await client.query(
          `INSERT INTO user_social_links (social_link_id, user_id, platform, url)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), req.userId, link.platform, link.url],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await sendMe(req, res);
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

export default router;
