import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  requireAdmin,
  requireCommunityRole,
  type CommunityRole,
} from "../middleware/community-role.js";
import { rateLimit } from "../lib/rate-limit.js";
import { banUser, removeComment, removePost } from "../lib/moderation.js";

/**
 * Denúncias. Post e comentário caem na fila da comunidade (dono e
 * moderadores); usuário, que não pertence a comunidade nenhuma, cai na fila
 * do admin do site.
 */
const router = Router();


// ===========================================================================
// POST /api/reports — denunciar post, comentário ou usuário
// ===========================================================================

const createReportSchema = z.object({
  targetType: z.enum(["post", "comment", "user"], {
    errorMap: () => ({ message: "Tipo de denúncia inválido" }),
  }),
  targetId: z.string().uuid("Alvo inválido"),
  reason: z
    .string()
    .trim()
    .min(3, "Conte o motivo da denúncia")
    .max(1000, "Motivo deve ter no máximo 1000 caracteres"),
});

/**
 * Comunidade e autor do alvo; null se o alvo não existe (ou já foi apagado).
 * Denúncia de usuário não tem comunidade e o "autor" é a própria pessoa.
 */
async function resolveTarget(
  targetType: "post" | "comment" | "user",
  targetId: string,
): Promise<{ communityId: string | null; authorId: string } | null> {
  if (targetType === "post") {
    const { rows } = await pool.query(
      `SELECT p.community_id, p.author_id
       FROM posts p
       INNER JOIN communities c ON c.community_id = p.community_id
       WHERE p.post_id = $1 AND p.deleted_at IS NULL AND c.deleted_at IS NULL`,
      [targetId],
    );
    return rows[0] ? { communityId: rows[0].community_id, authorId: rows[0].author_id } : null;
  }
  if (targetType === "comment") {
    const { rows } = await pool.query(
      `SELECT p.community_id, c.author_id
       FROM comments c
       INNER JOIN posts p ON p.post_id = c.post_id
       WHERE c.comment_id = $1 AND c.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [targetId],
    );
    return rows[0] ? { communityId: rows[0].community_id, authorId: rows[0].author_id } : null;
  }
  const { rows } = await pool.query(
    "SELECT user_id FROM users WHERE user_id = $1 AND deleted_at IS NULL",
    [targetId],
  );
  return rows[0] ? { communityId: null, authorId: rows[0].user_id } : null;
}

const TARGET_LABEL = { post: "Post", comment: "Comentário", user: "Usuário" } as const;

router.post(
  "/reports",
  requireAuth,
  rateLimit({ name: "create-report", limit: 10, windowMs: 60_000 }),
  async (req, res, next) => {
    try {
      const { targetType, targetId, reason } = createReportSchema.parse(req.body ?? {});

      const target = await resolveTarget(targetType, targetId);
      if (!target) {
        return res.status(404).json({ error: `${TARGET_LABEL[targetType]} não encontrado` });
      }
      if (target.authorId === req.userId) {
        return res.status(400).json({
          error: targetType === "user" ? "Você não pode denunciar a si mesmo" : "Você não pode denunciar o próprio conteúdo",
        });
      }

      const reportId = randomUUID();
      await pool.query(
        `INSERT INTO reports
           (report_id, reporter_id, target_type, target_id, reason, community_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [reportId, req.userId, targetType, targetId, reason, target.communityId],
      );

      res.status(201).json({ report: { reportId, status: "pending" } });
    } catch (err) {
      // uq_reports_open_per_reporter: já existe uma denúncia aberta dela.
      if ((err as { code?: string }).code === "23505") {
        return res
          .status(409)
          .json({ error: "Você já denunciou isto. A denúncia está em análise." });
      }
      next(err);
    }
  },
);

// ===========================================================================
// Filas (comunidade e admin)
// ===========================================================================

/**
 * Cada denúncia com o alvo resolvido: título/trecho do conteúdo, autor (e o
 * papel dele, para o front saber se pode agir) e se o alvo já foi apagado.
 * $1 é o filtro da fila (comunidade ou nada), montado por quem chama.
 */
const REPORT_SELECT = `
  SELECT
    r.report_id,
    r.target_type,
    r.target_id,
    r.reason,
    r.status,
    r.resolution,
    r.created_at,
    r.resolved_at,
    r.community_id,
    rep.user_id     AS reporter_id,
    rep.username    AS reporter_username,
    res.username    AS resolved_by_username,
    COALESCE(tp.post_id, tc.post_id)   AS post_id,
    COALESCE(tp.title, tcp.title)      AS post_title,
    COALESCE(tp.content, tc.content)   AS content,
    CASE r.target_type
      WHEN 'post'    THEN tp.deleted_at IS NOT NULL
      WHEN 'comment' THEN tc.deleted_at IS NOT NULL
      ELSE ta.deleted_at IS NOT NULL
    END AS target_deleted,
    ta.user_id      AS author_id,
    ta.username     AS author_username,
    tap.display_name AS author_display_name,
    (SELECT m.role FROM community_members m
     WHERE m.community_id = r.community_id AND m.user_id = ta.user_id) AS author_role
  FROM reports r
  INNER JOIN users rep ON rep.user_id = r.reporter_id
  LEFT  JOIN users res ON res.user_id = r.resolved_by
  LEFT  JOIN posts tp    ON r.target_type = 'post'    AND tp.post_id = r.target_id
  LEFT  JOIN comments tc ON r.target_type = 'comment' AND tc.comment_id = r.target_id
  LEFT  JOIN posts tcp   ON tcp.post_id = tc.post_id
  LEFT  JOIN users ta    ON ta.user_id = CASE r.target_type
                                           WHEN 'post'    THEN tp.author_id
                                           WHEN 'comment' THEN tc.author_id
                                           ELSE r.target_id
                                         END
  LEFT  JOIN user_profiles tap ON tap.user_id = ta.user_id
`;

const queueQuery = z.object({
  // "open" = pendentes + em análise, o padrão da fila.
  status: z.enum(["open", "pending", "reviewing", "resolved", "dismissed", "all"]).default("open"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const STATUS_FILTER: Record<z.infer<typeof queueQuery>["status"], string> = {
  open: "r.status IN ('pending', 'reviewing')",
  pending: "r.status = 'pending'",
  reviewing: "r.status = 'reviewing'",
  resolved: "r.status = 'resolved'",
  dismissed: "r.status = 'dismissed'",
  all: "TRUE",
};

/** Lista paginada; `scope` é o WHERE da fila usando $1. */
async function listReports(scope: string, scopeParam: unknown, query: unknown) {
  const { status, page, limit } = queueQuery.parse(query);
  const where = `${scope} AND ${STATUS_FILTER[status]}`;

  const { rows: countRows } = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM reports r WHERE ${where}`,
    [scopeParam],
  );
  const total = countRows[0].total;

  const { rows } = await pool.query(
    `${REPORT_SELECT}
     WHERE ${where}
     ORDER BY r.created_at DESC, r.report_id DESC
     LIMIT $2 OFFSET $3`,
    [scopeParam, limit, (page - 1) * limit],
  );
  return { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// GET /api/communities/:communityId/reports?status=&page=
router.get(
  "/communities/:communityId/reports",
  requireAuth,
  requireCommunityRole(["owner", "moderator"], (req) => {
    const parsed = z.string().uuid().safeParse(req.params.communityId);
    return parsed.success ? parsed.data : undefined;
  }),
  async (req, res, next) => {
    try {
      res.json(await listReports("r.community_id = $1", req.communityRole!.communityId, req.query));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/reports?status=&page= — denúncias de usuário (sem comunidade)
router.get("/admin/reports", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    // $1 só existe para a numeração bater com a da fila da comunidade.
    res.json(
      await listReports("r.target_type = 'user' AND $1::uuid IS NULL", null, req.query),
    );
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// PATCH /api/reports/:reportId — resolver
// ---------------------------------------------------------------------------
// { status: reviewing | resolved | dismissed, action?: none | remove_content
// | ban_author }. Ação só com status resolved. Fechar (resolved/dismissed)
// fecha junto as outras denúncias abertas do mesmo alvo — a decisão é sobre
// o conteúdo, não sobre quem denunciou.
// ===========================================================================

const resolveSchema = z
  .object({
    status: z.enum(["reviewing", "resolved", "dismissed"], {
      errorMap: () => ({ message: "Status inválido" }),
    }),
    action: z.enum(["none", "remove_content", "ban_author"]).default("none"),
    banDays: z.coerce.number().int().min(1).max(3650).nullish(),
    banReason: z.string().trim().max(500).nullish(),
  })
  .refine((data) => data.action === "none" || data.status === "resolved", {
    message: "Remover ou banir só ao resolver a denúncia",
  });

router.patch(
  "/reports/:reportId",
  requireAuth,
  rateLimit({ name: "resolve-report", limit: 60, windowMs: 60_000 }),
  async (req, res, next) => {
    try {
      const reportId = z.string().uuid("ID de denúncia inválido").parse(req.params.reportId);
      const data = resolveSchema.parse(req.body ?? {});

      const { rows } = await pool.query(`${REPORT_SELECT} WHERE r.report_id = $1`, [reportId]);
      const report = rows[0];
      if (!report) return res.status(404).json({ error: "Denúncia não encontrada" });

      // Quem pode: moderação da comunidade do alvo, ou o admin do site.
      const { rows: who } = await pool.query<{ is_admin: boolean; role: CommunityRole | null }>(
        `SELECT
           u.is_admin,
           (SELECT m.role FROM community_members m
            WHERE m.community_id = $2 AND m.user_id = u.user_id) AS role
         FROM users u WHERE u.user_id = $1`,
        [req.userId, report.community_id],
      );
      const isAdmin = who[0]?.is_admin === true;
      const role = who[0]?.role ?? null;
      const canModerate = isAdmin || (report.community_id && (role === "owner" || role === "moderator"));
      if (!canModerate) {
        return res.status(403).json({ error: "Você não pode resolver esta denúncia" });
      }

      if (report.status === "resolved" || report.status === "dismissed") {
        return res.status(409).json({ error: "Esta denúncia já foi encerrada" });
      }
      if (data.action !== "none" && report.target_type === "user") {
        return res
          .status(400)
          .json({ error: "Denúncia de usuário não tem remoção nem banimento de comunidade" });
      }

      const actor = { userId: req.userId!, isAdmin };

      if (data.action === "remove_content" && !report.target_deleted) {
        const result =
          report.target_type === "post"
            ? await removePost(report.target_id, actor)
            : await removeComment(report.target_id, actor);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
      }

      if (data.action === "ban_author") {
        const result = await banUser(report.community_id, report.author_id, actor, {
          reason: data.banReason || `Denúncia: ${report.reason}`,
          durationDays: data.banDays ?? null,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
      }

      // "Em análise" marca só esta; encerrar fecha as abertas do mesmo alvo.
      const closing = data.status !== "reviewing";
      await pool.query(
        `UPDATE reports
         SET status = $2,
             resolution = $3,
             resolved_by = CASE WHEN $4 THEN $5::uuid ELSE resolved_by END,
             resolved_at = CASE WHEN $4 THEN NOW() ELSE resolved_at END
         WHERE report_id = $1
            OR ($4 AND target_type = $6 AND target_id = $7
                AND status IN ('pending', 'reviewing'))`,
        [
          reportId,
          data.status,
          closing ? (data.status === "dismissed" ? "dismiss" : data.action) : null,
          closing,
          req.userId,
          report.target_type,
          report.target_id,
        ],
      );

      const { rows: updated } = await pool.query(`${REPORT_SELECT} WHERE r.report_id = $1`, [
        reportId,
      ]);
      res.json({ report: updated[0] });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
