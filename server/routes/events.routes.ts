import { Router, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { ACTIVE_BAN, requireCommunityRole, type CommunityRole } from "../middleware/community-role.js";
import { rateLimit } from "../lib/rate-limit.js";
import { notifyEventToMembers } from "../lib/notify.js";

/**
 * Eventos da comunidade: o dono e os moderadores criam, editam e cancelam;
 * membros marcam "Vou". Leitura pública, como o resto da comunidade.
 */
const router = Router();

const communityIdParam = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

const eventIdParam = z.object({
  eventId: z.string().uuid("ID de evento inválido"),
});

function zodError(res: Response, err: z.ZodError) {
  return res
    .status(400)
    .json({ error: err.issues[0]?.message ?? "Dados inválidos", details: err.flatten() });
}

/**
 * Formato único de evento. $1 é quem vê (ou null): attending diz se a
 * pessoa marcou "Vou".
 */
const EVENT_SELECT = `
  SELECT
    e.event_id,
    e.community_id,
    e.title,
    e.description,
    e.starts_at,
    e.ends_at,
    e.location,
    e.created_at,
    e.updated_at,
    u.user_id       AS creator_id,
    u.username      AS creator_username,
    up.display_name AS creator_display_name,
    (SELECT COUNT(*)::int FROM event_attendees a
     INNER JOIN users au ON au.user_id = a.user_id AND au.deleted_at IS NULL
     WHERE a.event_id = e.event_id) AS attendees_count,
    EXISTS (
      SELECT 1 FROM event_attendees a WHERE a.event_id = e.event_id AND a.user_id = $1
    ) AS attending,
    COALESCE(e.ends_at, e.starts_at) < NOW() AS is_past
  FROM community_events e
  INNER JOIN communities c    ON c.community_id = e.community_id AND c.deleted_at IS NULL
  LEFT  JOIN users u          ON u.user_id = e.created_by AND u.deleted_at IS NULL
  LEFT  JOIN user_profiles up ON up.user_id = u.user_id
`;

async function loadEvent(eventId: string, viewerId: string | undefined) {
  const { rows } = await pool.query(
    `${EVENT_SELECT} WHERE e.event_id = $2 AND e.deleted_at IS NULL`,
    [viewerId ?? null, eventId],
  );
  return rows[0] ?? null;
}

// ===========================================================================
// GET /api/communities/:communityId/events?scope=upcoming|past
// ---------------------------------------------------------------------------
// upcoming: o que ainda não terminou, do mais próximo ao mais distante (o
// widget "Próximos eventos" usa limit=3). past: o que já terminou, do mais
// recente ao mais antigo. Paginado por página, como o feed.
// ===========================================================================

const listQuery = z.object({
  scope: z.enum(["upcoming", "past"]).default("upcoming"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

router.get("/communities/:communityId/events", optionalAuth, async (req, res, next) => {
  try {
    const { communityId } = communityIdParam.parse(req.params);
    const { scope, page, limit } = listQuery.parse(req.query);

    const { rows: community } = await pool.query(
      "SELECT 1 FROM communities WHERE community_id = $1 AND deleted_at IS NULL",
      [communityId],
    );
    if (community.length === 0) {
      return res.status(404).json({ error: "Comunidade não encontrada" });
    }

    // Condição e ordem saem desta tabela fixa, nunca da requisição.
    const [condition, order] =
      scope === "upcoming"
        ? ["COALESCE(e.ends_at, e.starts_at) >= NOW()", "e.starts_at ASC, e.event_id ASC"]
        : ["COALESCE(e.ends_at, e.starts_at) < NOW()", "e.starts_at DESC, e.event_id DESC"];

    const { rows } = await pool.query(
      `${EVENT_SELECT}
       WHERE e.community_id = $2 AND e.deleted_at IS NULL AND ${condition}
       ORDER BY ${order}
       LIMIT $3 OFFSET $4`,
      [req.userId ?? null, communityId, limit, (page - 1) * limit],
    );
    const { rows: countRows } = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM community_events e
       WHERE e.community_id = $1 AND e.deleted_at IS NULL AND ${condition}`,
      [communityId],
    );
    const total = countRows[0].total;

    res.json({
      data: rows,
      scope,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

// ===========================================================================
// GET /api/events/:eventId
// ===========================================================================

router.get("/events/:eventId", optionalAuth, async (req, res, next) => {
  try {
    const { eventId } = eventIdParam.parse(req.params);
    const event = await loadEvent(eventId, req.userId);
    if (!event) return res.status(404).json({ error: "Evento não encontrado" });
    res.json({ event });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

// ===========================================================================
// POST /api/communities/:communityId/events — dono e moderadores criam
// ---------------------------------------------------------------------------
// O evento e os avisos para os membros (respeitando notify_events) entram na
// mesma transação.
// ===========================================================================

const datetime = (label: string) =>
  z.string().datetime({ offset: true, message: `${label} inválido` }).transform((value) => new Date(value));

const eventFields = {
  title: z
    .string()
    .trim()
    .min(3, "Título deve ter no mínimo 3 caracteres")
    .max(150, "Título deve ter no máximo 150 caracteres"),
  description: z.string().trim().max(5000, "Descrição muito longa").nullish(),
  startsAt: datetime("Início"),
  endsAt: datetime("Fim").nullish(),
  location: z.string().trim().max(300, "Local muito longo").nullish(),
};

const createEventSchema = z
  .object(eventFields)
  .refine((data) => !data.endsAt || data.endsAt >= data.startsAt, {
    message: "O fim não pode ser antes do início",
    path: ["endsAt"],
  })
  .refine((data) => data.startsAt.getTime() > Date.now() - 60_000, {
    message: "O início precisa ser no futuro",
    path: ["startsAt"],
  });

router.post(
  "/communities/:communityId/events",
  requireAuth,
  rateLimit({ name: "create-event", limit: 10, windowMs: 60_000 }),
  requireCommunityRole(["owner", "moderator"], (req) => {
    const parsed = z.string().uuid().safeParse(req.params.communityId);
    return parsed.success ? parsed.data : undefined;
  }),
  async (req, res, next) => {
    try {
      const communityId = req.communityRole!.communityId;
      const data = createEventSchema.parse(req.body);
      const eventId = randomUUID();

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO community_events
             (event_id, community_id, created_by, title, description, starts_at, ends_at, location)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            eventId,
            communityId,
            req.userId,
            data.title,
            data.description || null,
            data.startsAt,
            data.endsAt ?? null,
            data.location || null,
          ],
        );
        await notifyEventToMembers(client, {
          communityId,
          eventId,
          actorId: req.userId!,
          title: data.title,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      res.status(201).json({ event: await loadEvent(eventId, req.userId) });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

// ===========================================================================
// PATCH /api/events/:eventId — editar
// DELETE /api/events/:eventId — cancelar (soft delete)
// ---------------------------------------------------------------------------
// Dono e moderadores da comunidade do evento. Editar não avisa de novo
// ninguém; cancelar faz o aviso sumir (filtro VISIBLE das notificações).
// ===========================================================================

async function eventStaff(eventId: string, userId: string) {
  const { rows } = await pool.query<{
    starts_at: Date;
    ends_at: Date | null;
    role: CommunityRole | null;
  }>(
    `SELECT e.starts_at, e.ends_at,
            (SELECT m.role FROM community_members m
             WHERE m.community_id = e.community_id AND m.user_id = $2) AS role
     FROM community_events e
     INNER JOIN communities c ON c.community_id = e.community_id AND c.deleted_at IS NULL
     WHERE e.event_id = $1 AND e.deleted_at IS NULL`,
    [eventId, userId],
  );
  return rows[0] ?? null;
}

const editEventSchema = z
  .object({
    title: eventFields.title.optional(),
    description: eventFields.description,
    startsAt: eventFields.startsAt.optional(),
    endsAt: eventFields.endsAt,
    location: eventFields.location,
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "Nada para atualizar");

router.patch("/events/:eventId", requireAuth, async (req, res, next) => {
  try {
    const { eventId } = eventIdParam.parse(req.params);
    const data = editEventSchema.parse(req.body);

    const current = await eventStaff(eventId, req.userId!);
    if (!current) return res.status(404).json({ error: "Evento não encontrado" });
    if (current.role !== "owner" && current.role !== "moderator") {
      return res.status(403).json({ error: "Só o dono e os moderadores podem editar eventos" });
    }

    // Confere o período com o que fica valendo depois da edição.
    const startsAt = data.startsAt ?? current.starts_at;
    const endsAt = data.endsAt !== undefined ? data.endsAt : current.ends_at;
    if (endsAt && endsAt < startsAt) {
      return res.status(400).json({ error: "O fim não pode ser antes do início" });
    }

    // Colunas desta lista fixa; valores sempre por parâmetro.
    const columns: Array<[string, unknown]> = [
      ["title", data.title],
      ["description", data.description === undefined ? undefined : data.description || null],
      ["starts_at", data.startsAt],
      ["ends_at", data.endsAt === undefined ? undefined : data.endsAt ?? null],
      ["location", data.location === undefined ? undefined : data.location || null],
    ];
    const sets = ["updated_at = NOW()"];
    const params: unknown[] = [eventId];
    for (const [column, value] of columns) {
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    await pool.query(`UPDATE community_events SET ${sets.join(", ")} WHERE event_id = $1`, params);

    res.json({ event: await loadEvent(eventId, req.userId) });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

router.delete("/events/:eventId", requireAuth, async (req, res, next) => {
  try {
    const { eventId } = eventIdParam.parse(req.params);
    const current = await eventStaff(eventId, req.userId!);
    if (!current) return res.status(404).json({ error: "Evento não encontrado" });
    if (current.role !== "owner" && current.role !== "moderator") {
      return res.status(403).json({ error: "Só o dono e os moderadores podem cancelar eventos" });
    }
    await pool.query("UPDATE community_events SET deleted_at = NOW() WHERE event_id = $1", [eventId]);
    res.status(204).end();
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

// ===========================================================================
// POST /api/events/:eventId/attend — "Vou"
// DELETE /api/events/:eventId/attend — desmarcar
// ---------------------------------------------------------------------------
// Só membros (e não banidos) marcam presença; evento que já terminou não
// aceita mais. Desmarcar é sempre permitido. Idempotentes.
// ===========================================================================

async function attendeesCount(eventId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM event_attendees a
     INNER JOIN users u ON u.user_id = a.user_id AND u.deleted_at IS NULL
     WHERE a.event_id = $1`,
    [eventId],
  );
  return rows[0].n;
}

router.post(
  "/events/:eventId/attend",
  requireAuth,
  rateLimit({ name: "attend-event", limit: 30, windowMs: 60_000 }),
  async (req, res, next) => {
    try {
      const { eventId } = eventIdParam.parse(req.params);
      const { rows } = await pool.query<{ is_past: boolean; is_member: boolean; is_banned: boolean }>(
        `SELECT
           COALESCE(e.ends_at, e.starts_at) < NOW() AS is_past,
           EXISTS (SELECT 1 FROM community_members m
                   WHERE m.community_id = e.community_id AND m.user_id = $2) AS is_member,
           EXISTS (SELECT 1 FROM community_bans b
                   WHERE b.community_id = e.community_id AND b.user_id = $2 AND ${ACTIVE_BAN("b")}) AS is_banned
         FROM community_events e
         INNER JOIN communities c ON c.community_id = e.community_id AND c.deleted_at IS NULL
         WHERE e.event_id = $1 AND e.deleted_at IS NULL`,
        [eventId, req.userId],
      );
      const event = rows[0];
      if (!event) return res.status(404).json({ error: "Evento não encontrado" });
      if (event.is_banned) return res.status(403).json({ error: "Você está banido desta comunidade" });
      if (!event.is_member) {
        return res.status(403).json({ error: "Você precisa participar da comunidade" });
      }
      if (event.is_past) return res.status(400).json({ error: "Este evento já terminou" });

      await pool.query(
        `INSERT INTO event_attendees (event_id, user_id) VALUES ($1, $2)
         ON CONFLICT (event_id, user_id) DO NOTHING`,
        [eventId, req.userId],
      );
      res.json({ attending: true, attendeesCount: await attendeesCount(eventId) });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

router.delete("/events/:eventId/attend", requireAuth, async (req, res, next) => {
  try {
    const { eventId } = eventIdParam.parse(req.params);
    await pool.query("DELETE FROM event_attendees WHERE event_id = $1 AND user_id = $2", [
      eventId,
      req.userId,
    ]);
    res.json({ attending: false, attendeesCount: await attendeesCount(eventId) });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

export default router;
