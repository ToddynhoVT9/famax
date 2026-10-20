import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { revokeOtherSessions } from "../lib/session.js";
import { describeDevice, maskIp } from "../lib/user-agent.js";
import { sendMailInBackground } from "../lib/mailer.js";
import { checkSecondFactor, isTwoFactorConfigured } from "../lib/two-factor.js";
import {
  REACTIVATION_DAYS,
  accountDeletedMail,
  buildExport,
  deleteAccount,
  ownedCommunities,
} from "../lib/account.js";

/**
 * Conta: sessões ativas, exportar meus dados e excluir a conta (prompt 12,
 * partes C e D). A lógica de exclusão, reativação e exportação fica em
 * lib/account.ts.
 */
const router = Router();

// ===========================================================================
// GET /api/me/sessions — dispositivos com sessão aberta
// ---------------------------------------------------------------------------
// Só sessões vivas (não revogadas, não expiradas). O dispositivo é derivado
// do User-Agent e o IP vai parcial; current marca a sessão deste token.
// ===========================================================================

router.get("/me/sessions", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query<{
      session_id: string;
      user_agent: string | null;
      ip_address: string | null;
      created_at: Date;
      last_seen_at: Date | null;
    }>(
      `SELECT session_id, user_agent, ip_address, created_at, last_seen_at
       FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY COALESCE(last_seen_at, created_at) DESC`,
      [req.userId],
    );
    res.json({
      data: rows.map((row) => ({
        sessionId: row.session_id,
        device: describeDevice(row.user_agent),
        ip: maskIp(row.ip_address),
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at ?? row.created_at,
        current: row.session_id === req.sessionId,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// DELETE /api/me/sessions/:sessionId — encerra uma sessão
// POST /api/me/sessions/revoke-others — "Sair de todos os outros"
// ---------------------------------------------------------------------------
// Encerrar a própria sessão atual é permitido (é um logout). Sessão de outra
// pessoa responde 404, como se não existisse.
// ===========================================================================

router.delete("/me/sessions/:sessionId", requireAuth, async (req, res, next) => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.sessionId);
    if (!parsed.success) return res.status(400).json({ error: "Sessão inválida" });

    const { rowCount } = await pool.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [parsed.data, req.userId],
    );
    if (!rowCount) return res.status(404).json({ error: "Sessão não encontrada" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/me/sessions/revoke-others", requireAuth, async (req, res, next) => {
  try {
    await revokeOtherSessions(req.userId!, req.sessionId!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/me/export — "Exportar meus dados" (LGPD)
// ---------------------------------------------------------------------------
// Download direto de um JSON (Content-Disposition: attachment). POST e não
// GET: a resposta é grande e sensível, e um GET seria fácil de disparar por
// um <img> de outro site (embora sem o token não fosse adiante).
// ===========================================================================

router.post(
  "/me/export",
  requireAuth,
  rateLimit({
    name: "export-data",
    limit: 3,
    windowMs: 60 * 60_000,
    message: "Você já exportou seus dados várias vezes. Tente mais tarde.",
  }),
  async (req, res, next) => {
    try {
      const data = await buildExport(req.userId!);
      const username = (data.account as { username?: string } | null)?.username ?? "conta";
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="famax-dados-${username}-${date}.json"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(JSON.stringify(data, null, 2));
    } catch (err) {
      next(err);
    }
  },
);

// ===========================================================================
// DELETE /api/me — excluir a conta { password, code? }
// ---------------------------------------------------------------------------
// Senha sempre; com 2FA ativa, também o código (do app ou de recuperação).
// Quem é dono de comunidade precisa transferi-la (ou excluí-la) antes: uma
// comunidade sem dono ficaria sem ninguém para moderar — 409 com a lista.
//
// A exclusão é reversível por REACTIVATION_DAYS dias (lib/account.ts): o
// login com a senha oferece reativar. Depois disso o job a torna definitiva.
// ===========================================================================

const deleteSchema = z.object({
  password: z.string().min(1, "Informe sua senha"),
  code: z.string().trim().max(20).optional(),
});

router.delete(
  "/me",
  requireAuth,
  rateLimit({ name: "delete-account", limit: 5, windowMs: 15 * 60_000 }),
  async (req, res, next) => {
    try {
      const { password, code } = deleteSchema.parse(req.body ?? {});

      // Antes da senha e do código: um código de recuperação não pode ser
      // gasto numa tentativa que ia ser recusada de qualquer jeito.
      const owned = await ownedCommunities(req.userId!);
      if (owned.length > 0) {
        return res.status(409).json({
          error:
            "Você é dono de comunidades. Transfira a posse (em Membros) ou exclua cada uma antes de excluir a conta.",
          communities: owned,
        });
      }
      const { rows } = await pool.query<{
        password_hash: string;
        two_factor_enabled: boolean;
        email: string;
        name: string;
      }>(
        `SELECT u.password_hash, u.two_factor_enabled, u.email, COALESCE(p.display_name, u.username) AS name
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
         WHERE u.user_id = $1`,
        [req.userId],
      );
      const user = rows[0];
      // 400 e não 401: 401 significa "sessão inválida" para o front.
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(400).json({ error: "Senha incorreta" });
      }
      if (user.two_factor_enabled) {
        if (!code) {
          return res.status(400).json({ error: "Informe o código do app ou um código de recuperação", code: "MFA_REQUIRED" });
        }
        if (!isTwoFactorConfigured() || !(await checkSecondFactor(pool, req.userId!, code)).ok) {
          return res.status(400).json({ error: "Código incorreto" });
        }
      }

      const client = await pool.connect();
      let until: Date;
      try {
        await client.query("BEGIN");
        until = await deleteAccount(client, req.userId!);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      sendMailInBackground(accountDeletedMail(user.email, user.name, until));
      res.json({ deleted: true, reactivateUntil: until, reactivationDays: REACTIVATION_DAYS });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues[0]?.message ?? "Dados inválidos" });
      }
      next(err);
    }
  },
);

export default router;
