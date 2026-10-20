import { Router } from "express";
import type { RequestHandler, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { publish } from "../lib/realtime.js";
import { BLOCKED_MESSAGE, isBlockedBetween } from "../lib/blocks.js";

const router = Router();

// Todo o chat é privado.
router.use(requireAuth);

/** Conversa em grupo: de 2 a 20 pessoas contando quem cria. */
const MAX_GROUP_SIZE = 20;

type ChatContext = { conversationId: string; isGroup: boolean; role: "admin" | "member" };

declare module "express-serve-static-core" {
  interface Request {
    /** Preenchido por requireParticipant. */
    chat?: ChatContext;
  }
}

type Db = Pick<PoolClient, "query">;

function zodError(res: Response, err: z.ZodError) {
  return res
    .status(400)
    .json({ error: err.issues[0]?.message ?? "Dados inválidos", details: err.flatten() });
}

/**
 * Confirma que o usuário participa da conversa antes de qualquer leitura.
 *
 * Sem isto, um conversation_id adivinhado ou vazado expõe a conversa inteira de
 * terceiros — é a checagem mais importante deste arquivo.
 */
const requireParticipant: RequestHandler = async (req, res, next) => {
  const parsed = z
    .string()
    .uuid()
    .safeParse(req.params.conversationId);

  if (!parsed.success) {
    return res.status(400).json({ error: "ID de conversa inválido" });
  }

  try {
    const { rows } = await pool.query<{ is_group: boolean; role: "admin" | "member" }>(
      `SELECT c.is_group, p.role
       FROM conversation_participants p
       INNER JOIN conversations c ON c.conversation_id = p.conversation_id
       WHERE p.conversation_id = $1 AND p.user_id = $2`,
      [parsed.data, req.userId],
    );

    if (rows.length === 0) {
      // 404 em vez de 403: um 403 confirmaria que a conversa existe.
      return res.status(404).json({ error: "Conversa não encontrada" });
    }

    req.chat = { conversationId: parsed.data, isGroup: rows[0].is_group, role: rows[0].role };
    next();
  } catch (err) {
    next(err);
  }
};

/** Só em grupo, e só o admin (renomear, adicionar, remover outra pessoa). */
function groupGuard(res: Response, chat: ChatContext, needAdmin: boolean): boolean {
  if (!chat.isGroup) {
    res.status(400).json({ error: "Isto só vale para conversas em grupo" });
    return false;
  }
  if (needAdmin && chat.role !== "admin") {
    res.status(403).json({ error: "Só o admin do grupo pode fazer isso" });
    return false;
  }
  return true;
}

async function participantIds(db: Db, conversationId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

/** Nome de exibição (ou @username) de cada id — para mensagens de sistema. */
async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ user_id: string; name: string }>(
    `SELECT u.user_id, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username) AS name
     FROM users u LEFT JOIN user_profiles up ON up.user_id = u.user_id
     WHERE u.user_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.user_id, r.name]));
}

/**
 * Mensagem de sistema ("Ana adicionou Bia ao grupo"). O texto é montado aqui,
 * com os nomes do momento; o front só o mostra (por textContent).
 */
async function systemMessage(db: Db, conversationId: string, actorId: string, content: string): Promise<string> {
  const messageId = randomUUID();
  await db.query(
    `INSERT INTO messages (message_id, conversation_id, sender_id, content, kind)
     VALUES ($1, $2, $3, $4, 'system')`,
    [messageId, conversationId, actorId, content.slice(0, 2000)],
  );
  await db.query("UPDATE conversations SET last_message_at = NOW() WHERE conversation_id = $1", [
    conversationId,
  ]);
  return messageId;
}

/** Avisa os participantes (e quem saiu) que a conversa mudou + a mensagem de sistema. */
async function announce(
  db: Db,
  conversationId: string,
  users: string[],
  messageId: string | null,
  senderId: string,
): Promise<void> {
  await publish(db, users, "conversation:updated", { conversationId });
  if (messageId) await publish(db, users, "message:new", { conversationId, messageId, senderId });
}

const listFormat = (names: string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;

// ===========================================================================
// GET /api/conversations?cursor=&limit= — lista do widget
// ---------------------------------------------------------------------------
// Paginada por (last_message_at, id), mais recentes primeiro. Conversa 1:1
// traz a outra pessoa; grupo traz o título e quantas pessoas tem.
// unreadTotal é o total de não lidas em TODAS as conversas (o badge não pode
// depender de quantas páginas o widget já carregou).
// ===========================================================================

const listQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const valid = at && !Number.isNaN(Date.parse(at)) && z.string().uuid().safeParse(id).success;
  return valid ? { at, id } : null;
}

/** Não lidas: mensagens de texto de outras pessoas depois do last_read_at. */
const UNREAD_COUNT = `
  (SELECT COUNT(*) FROM messages m2
   WHERE m2.conversation_id = me.conversation_id
     AND m2.created_at > me.last_read_at
     AND m2.sender_id <> me.user_id
     AND m2.kind = 'text'
     AND m2.deleted_at IS NULL)::int`;

router.get("/", async (req, res, next) => {
  try {
    const { cursor, limit } = listQuery.parse(req.query);
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) return res.status(400).json({ error: "Cursor inválido" });

    const { rows } = await pool.query(
      `SELECT
         c.conversation_id,
         c.is_group,
         c.title,
         c.last_message_at,
         c.last_message_at::text AS cursor_at,
         me.role              AS my_role,
         other.user_id        AS other_user_id,
         other.username       AS other_username,
         other_p.display_name AS other_display_name,
         other_p.avatar_url   AS other_avatar_url,
         (SELECT COUNT(*) FROM conversation_participants px
          WHERE px.conversation_id = c.conversation_id)::int AS participants_count,
         lm.content           AS last_message_content,
         lm.sender_id         AS last_message_sender_id,
         lm.kind              AS last_message_kind,
         ${UNREAD_COUNT} AS unread_count
       FROM conversation_participants me
       INNER JOIN conversations c ON c.conversation_id = me.conversation_id
       LEFT JOIN LATERAL (
         SELECT op.user_id FROM conversation_participants op
         WHERE op.conversation_id = c.conversation_id AND op.user_id <> $1 AND NOT c.is_group
         LIMIT 1
       ) o ON TRUE
       LEFT JOIN users other            ON other.user_id = o.user_id
       LEFT JOIN user_profiles other_p  ON other_p.user_id = other.user_id
       LEFT JOIN LATERAL (
         SELECT content, sender_id, kind
         FROM messages m
         WHERE m.conversation_id = c.conversation_id
           AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC
         LIMIT 1
       ) lm ON TRUE
       WHERE me.user_id = $1
         AND (c.is_group OR other.user_id IS NOT NULL)
         AND ($2::timestamptz IS NULL OR (c.last_message_at, c.conversation_id) < ($2::timestamptz, $3::uuid))
       ORDER BY c.last_message_at DESC, c.conversation_id DESC
       LIMIT $4`,
      [req.userId, after?.at ?? null, after?.id ?? null, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    const { rows: total } = await pool.query<{ n: number }>(
      `SELECT COALESCE(SUM(${UNREAD_COUNT}), 0)::int AS n
       FROM conversation_participants me WHERE me.user_id = $1`,
      [req.userId],
    );

    res.json({
      data: page.map(({ cursor_at: _c, ...row }) => row),
      nextCursor: hasMore && last ? encodeCursor(last.cursor_at, last.conversation_id) : null,
      unreadTotal: total[0].n,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

// ===========================================================================
// POST /api/conversations — abre (ou reusa) uma conversa 1:1
// ===========================================================================

const openConversationSchema = z.object({
  userId: z.string().uuid("Usuário inválido"),
});

router.post("/", async (req, res, next) => {
  try {
    const { userId: otherUserId } = openConversationSchema.parse(req.body);
    const meId = req.userId!;

    if (otherUserId === meId) {
      return res
        .status(400)
        .json({ error: "Não é possível conversar consigo mesmo" });
    }

    const { rows: userRows } = await pool.query(
      "SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL",
      [otherUserId],
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }
    if (await isBlockedBetween(meId, otherUserId)) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }

    // O par é sempre gravado ordenado, então (A,B) e (B,A) colidem na mesma
    // UNIQUE e nunca geram duas conversas para as mesmas duas pessoas.
    const findExisting = async () => {
      const { rows } = await pool.query(
        `SELECT conversation_id FROM direct_conversation_keys
         WHERE user_a_id = LEAST($1::uuid, $2::uuid)
           AND user_b_id = GREATEST($1::uuid, $2::uuid)`,
        [meId, otherUserId],
      );
      return rows[0]?.conversation_id as string | undefined;
    };

    const existing = await findExisting();
    if (existing) {
      return res.json({ conversationId: existing, created: false });
    }

    const conversationId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO conversations (conversation_id, is_group, created_by)
         VALUES ($1, FALSE, $2)`,
        [conversationId, meId],
      );

      await client.query(
        `INSERT INTO conversation_participants
           (participant_id, conversation_id, user_id)
         VALUES ($1, $2, $3), ($4, $2, $5)`,
        [randomUUID(), conversationId, meId, randomUUID(), otherUserId],
      );

      const { rowCount } = await client.query(
        `INSERT INTO direct_conversation_keys
           (conversation_id, user_a_id, user_b_id)
         VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
         ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
        [conversationId, meId, otherUserId],
      );

      // Outro request criou a mesma conversa entre o SELECT e o INSERT.
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        const winner = await findExisting();
        return res.json({ conversationId: winner, created: false });
      }

      await client.query("COMMIT");
      res.status(201).json({ conversationId, created: true });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
// POST /api/conversations/groups — cria um grupo (quem cria vira admin)
// ===========================================================================

const groupTitle = z
  .string()
  .trim()
  .min(1, "Dê um nome ao grupo")
  .max(80, "Nome do grupo deve ter no máximo 80 caracteres");

const userIdList = z
  .array(z.string().uuid("Usuário inválido"))
  .min(1, "Escolha ao menos uma pessoa")
  .max(MAX_GROUP_SIZE - 1, `Um grupo tem no máximo ${MAX_GROUP_SIZE} pessoas`);

const createGroupSchema = z.object({ title: groupTitle, userIds: userIdList });

/** Confere que os ids existem e não há bloqueio; devolve a mensagem de erro, se houver. */
async function checkInvitees(db: Db, meId: string, ids: string[]): Promise<{ status: number; error: string } | null> {
  const { rows } = await db.query<{ user_id: string }>(
    "SELECT user_id FROM users WHERE user_id = ANY($1::uuid[]) AND deleted_at IS NULL",
    [ids],
  );
  if (rows.length !== ids.length) return { status: 404, error: "Alguém da lista não foi encontrado" };
  for (const id of ids) {
    if (await isBlockedBetween(meId, id, db)) return { status: 403, error: BLOCKED_MESSAGE };
  }
  return null;
}

router.post(
  "/groups",
  rateLimit({ name: "create-group", limit: 10, windowMs: 60_000 }),
  async (req, res, next) => {
    try {
      const data = createGroupSchema.parse(req.body);
      const meId = req.userId!;
      const invitees = [...new Set(data.userIds)].filter((id) => id !== meId);
      if (invitees.length === 0) {
        return res.status(400).json({ error: "Escolha ao menos uma pessoa" });
      }

      const client = await pool.connect();
      try {
        const problem = await checkInvitees(client, meId, invitees);
        if (problem) return res.status(problem.status).json({ error: problem.error });

        const conversationId = randomUUID();
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO conversations (conversation_id, is_group, title, created_by)
           VALUES ($1, TRUE, $2, $3)`,
          [conversationId, data.title, meId],
        );
        await client.query(
          `INSERT INTO conversation_participants (participant_id, conversation_id, user_id, role)
           SELECT gen_random_uuid(), $1, u.id, CASE WHEN u.id = $2 THEN 'admin' ELSE 'member' END
           FROM unnest($3::uuid[]) AS u(id)`,
          [conversationId, meId, [meId, ...invitees]],
        );
        const names = await namesOf(client, [meId]);
        const messageId = await systemMessage(
          client,
          conversationId,
          meId,
          `${names.get(meId)} criou o grupo “${data.title}”`,
        );
        await announce(client, conversationId, [meId, ...invitees], messageId, meId);
        await client.query("COMMIT");
        res.status(201).json({ conversationId });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

// ===========================================================================
// GET /api/conversations/:conversationId — cabeçalho e participantes
// ---------------------------------------------------------------------------
// last_read_at de cada participante alimenta o "Visto" do widget.
// ===========================================================================

router.get("/:conversationId", requireParticipant, async (req, res, next) => {
  try {
    const { conversationId } = req.chat!;
    const { rows: conversation } = await pool.query(
      `SELECT conversation_id, is_group, title, created_by, created_at
       FROM conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    const { rows: participants } = await pool.query(
      `SELECT p.user_id, u.username, up.display_name, up.avatar_url, p.role,
              p.last_read_at, p.joined_at
       FROM conversation_participants p
       INNER JOIN users u          ON u.user_id = p.user_id
       LEFT  JOIN user_profiles up ON up.user_id = p.user_id
       WHERE p.conversation_id = $1
       ORDER BY p.joined_at ASC, p.user_id ASC`,
      [conversationId],
    );
    res.json({
      conversation: { ...conversation[0], my_role: req.chat!.role },
      participants,
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// PATCH /api/conversations/:conversationId — renomear o grupo (admin)
// ===========================================================================

router.patch("/:conversationId", requireParticipant, async (req, res, next) => {
  try {
    const chat = req.chat!;
    if (!groupGuard(res, chat, true)) return;
    const { title } = z.object({ title: groupTitle }).strict().parse(req.body);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE conversations SET title = $2 WHERE conversation_id = $1", [
        chat.conversationId,
        title,
      ]);
      const names = await namesOf(client, [req.userId!]);
      const messageId = await systemMessage(
        client,
        chat.conversationId,
        req.userId!,
        `${names.get(req.userId!)} renomeou o grupo para “${title}”`,
      );
      await announce(client, chat.conversationId, await participantIds(client, chat.conversationId), messageId, req.userId!);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ title });
  } catch (err) {
    if (err instanceof z.ZodError) return zodError(res, err);
    next(err);
  }
});

// ===========================================================================
// POST /api/conversations/:conversationId/participants — adicionar (admin)
// DELETE /api/conversations/:conversationId/participants/:userId — remover / sair
// ---------------------------------------------------------------------------
// Sair é remover a si mesmo (qualquer participante). Remover outra pessoa é
// do admin. Se o admin sai, o membro mais antigo assume; se ninguém sobra, a
// conversa é apagada.
// ===========================================================================

router.post(
  "/:conversationId/participants",
  rateLimit({ name: "group-participants", limit: 30, windowMs: 60_000 }),
  requireParticipant,
  async (req, res, next) => {
    try {
      const chat = req.chat!;
      if (!groupGuard(res, chat, true)) return;
      const { userIds } = z.object({ userIds: userIdList }).parse(req.body);
      const meId = req.userId!;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Trava a conversa: duas adições ao mesmo tempo não passam juntas do limite.
        await client.query("SELECT 1 FROM conversations WHERE conversation_id = $1 FOR UPDATE", [
          chat.conversationId,
        ]);
        const current = await participantIds(client, chat.conversationId);
        const fresh = [...new Set(userIds)].filter((id) => !current.includes(id));
        if (fresh.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Essas pessoas já estão no grupo" });
        }
        if (current.length + fresh.length > MAX_GROUP_SIZE) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Um grupo tem no máximo ${MAX_GROUP_SIZE} pessoas` });
        }
        const problem = await checkInvitees(client, meId, fresh);
        if (problem) {
          await client.query("ROLLBACK");
          return res.status(problem.status).json({ error: problem.error });
        }

        await client.query(
          `INSERT INTO conversation_participants (participant_id, conversation_id, user_id)
           SELECT gen_random_uuid(), $1, u.id FROM unnest($2::uuid[]) AS u(id)`,
          [chat.conversationId, fresh],
        );
        const names = await namesOf(client, [meId, ...fresh]);
        const messageId = await systemMessage(
          client,
          chat.conversationId,
          meId,
          `${names.get(meId)} adicionou ${listFormat(fresh.map((id) => names.get(id) ?? "alguém"))} ao grupo`,
        );
        await announce(client, chat.conversationId, [...current, ...fresh], messageId, meId);
        await client.query("COMMIT");
        res.status(201).json({ added: fresh });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

router.delete("/:conversationId/participants/:userId", requireParticipant, async (req, res, next) => {
  try {
    const chat = req.chat!;
    const target = z.string().uuid().safeParse(req.params.userId);
    if (!target.success) return res.status(400).json({ error: "Usuário inválido" });
    const targetId = target.data;
    const meId = req.userId!;
    const leaving = targetId === meId;
    if (!groupGuard(res, chat, !leaving)) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: removed } = await client.query<{ role: string }>(
        `DELETE FROM conversation_participants
         WHERE conversation_id = $1 AND user_id = $2
         RETURNING role`,
        [chat.conversationId, targetId],
      );
      if (removed.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Essa pessoa não está no grupo" });
      }

      const remaining = await participantIds(client, chat.conversationId);
      if (remaining.length === 0) {
        await client.query("DELETE FROM conversations WHERE conversation_id = $1", [chat.conversationId]);
        await publish(client, [targetId], "conversation:updated", { conversationId: chat.conversationId });
        await client.query("COMMIT");
        return res.status(204).end();
      }

      // O grupo nunca fica sem admin: o mais antigo assume.
      if (removed[0].role === "admin") {
        await client.query(
          `UPDATE conversation_participants SET role = 'admin'
           WHERE participant_id = (
             SELECT participant_id FROM conversation_participants
             WHERE conversation_id = $1
             ORDER BY joined_at ASC, participant_id ASC
             LIMIT 1
           )`,
          [chat.conversationId],
        );
      }

      const names = await namesOf(client, [meId, targetId]);
      const messageId = await systemMessage(
        client,
        chat.conversationId,
        meId,
        leaving
          ? `${names.get(meId)} saiu do grupo`
          : `${names.get(meId)} removeu ${names.get(targetId)} do grupo`,
      );
      await announce(client, chat.conversationId, [...remaining, targetId], messageId, meId);
      await client.query("COMMIT");
      res.status(204).end();
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

// ===========================================================================
// GET /api/conversations/:conversationId/messages
// ===========================================================================
//
// `after`    → usado pelo polling de reserva: só o que chegou depois da
//              última mensagem conhecida. É o que mantém o custo do tick baixo.
// `before`   → histórico (timestamp).
// `beforeId` → histórico a partir de uma mensagem: exato mesmo com duas
//              mensagens no mesmo milissegundo (o JSON corta os
//              microssegundos do created_at). É o que o widget usa.
//
// Mensagem apagada vem com is_deleted e sem conteúdo ("mensagem apagada").
// ===========================================================================

const MESSAGE_SELECT = `
  SELECT
    m.message_id,
    m.conversation_id,
    m.sender_id,
    m.kind,
    CASE WHEN m.deleted_at IS NULL THEN m.content END AS content,
    m.deleted_at IS NOT NULL AS is_deleted,
    m.created_at,
    u.username      AS sender_username,
    up.display_name AS sender_display_name,
    up.avatar_url   AS sender_avatar_url
  FROM messages m
  LEFT JOIN users u          ON u.user_id = m.sender_id
  LEFT JOIN user_profiles up ON up.user_id = m.sender_id
`;

const messagesQuery = z.object({
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  beforeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  "/:conversationId/messages",
  requireParticipant,
  async (req, res, next) => {
    try {
      const conversationId = req.chat!.conversationId;
      const { after, before, beforeId, limit } = messagesQuery.parse(req.query);

      const params: unknown[] = [conversationId];
      let cursor = "";

      if (after) {
        params.push(after);
        cursor = `AND m.created_at > $${params.length}`;
      } else if (beforeId) {
        params.push(beforeId);
        cursor = `AND (m.created_at, m.message_id) < (
          SELECT b.created_at, b.message_id FROM messages b
          WHERE b.message_id = $${params.length} AND b.conversation_id = $1)`;
      } else if (before) {
        params.push(before);
        cursor = `AND m.created_at < $${params.length}`;
      }

      params.push(limit + 1);

      // Busca em DESC (usa o índice e pega as N mais recentes), depois
      // reordena em ASC para o cliente renderizar de cima para baixo. Uma a
      // mais que o limite diz se ainda há histórico.
      const { rows } = await pool.query(
        `SELECT * FROM (
           ${MESSAGE_SELECT}
           WHERE m.conversation_id = $1
             ${cursor}
           ORDER BY m.created_at DESC, m.message_id DESC
           LIMIT $${params.length}
         ) recent
         ORDER BY created_at ASC, message_id ASC`,
        params,
      );

      const hasMore = rows.length > limit;
      res.json({ data: hasMore ? rows.slice(1) : rows, hasMore });
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(res, err);
      next(err);
    }
  },
);

// ===========================================================================
// POST /api/conversations/:conversationId/messages
// ===========================================================================

const sendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Mensagem vazia")
    .max(2000, "Mensagem deve ter no máximo 2000 caracteres"),
});

router.post(
  "/:conversationId/messages",
  rateLimit({
    name: "send-message",
    limit: 20,
    windowMs: 10_000,
    message: "Você está enviando mensagens rápido demais.",
  }),
  requireParticipant,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { conversationId, isGroup } = req.chat!;
      const { content } = sendMessageSchema.parse(req.body);
      const messageId = randomUUID();

      const participants = await participantIds(client, conversationId);
      if (!isGroup) {
        const other = participants.find((id) => id !== req.userId);
        if (other && (await isBlockedBetween(req.userId!, other, client))) {
          return res.status(403).json({ error: BLOCKED_MESSAGE });
        }
      }

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO messages (message_id, conversation_id, sender_id, content)
         VALUES ($1, $2, $3, $4)`,
        [messageId, conversationId, req.userId, content],
      );
      // Mantém a conversa no topo da lista de contatos.
      await client.query(
        `UPDATE conversations SET last_message_at = NOW()
         WHERE conversation_id = $1`,
        [conversationId],
      );
      // Todos os participantes, inclusive quem enviou (as outras abas dele).
      await publish(client, participants, "message:new", {
        conversationId,
        messageId,
        senderId: req.userId,
      });
      await client.query("COMMIT");

      const { rows } = await client.query(`${MESSAGE_SELECT} WHERE m.message_id = $1`, [messageId]);

      res.status(201).json({ message: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Dados inválidos", details: err.flatten() });
      }
      next(err);
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// DELETE /api/conversations/:conversationId/messages/:messageId
// ---------------------------------------------------------------------------
// Só quem escreveu, e só mensagem de texto. Soft delete: na conversa fica
// "mensagem apagada". Mensagem de outra pessoa responde 404, como se não
// existisse.
// ===========================================================================

router.delete("/:conversationId/messages/:messageId", requireParticipant, async (req, res, next) => {
  try {
    const conversationId = req.chat!.conversationId;
    const messageId = z.string().uuid().safeParse(req.params.messageId);
    if (!messageId.success) return res.status(400).json({ error: "ID de mensagem inválido" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE messages SET deleted_at = NOW()
         WHERE message_id = $1 AND conversation_id = $2 AND sender_id = $3
           AND kind = 'text' AND deleted_at IS NULL`,
        [messageId.data, conversationId, req.userId],
      );
      if (!rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Mensagem não encontrada ou não é sua" });
      }
      await publish(client, await participantIds(client, conversationId), "message:deleted", {
        conversationId,
        messageId: messageId.data,
      });
      await client.query("COMMIT");
      res.status(204).end();
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

// ===========================================================================
// POST /api/conversations/:conversationId/read — zera o badge de não lidas
// ---------------------------------------------------------------------------
// Avisa os outros participantes (o "Visto" deles) e as outras abas de quem
// leu (o badge).
// ===========================================================================

router.post(
  "/:conversationId/read",
  requireParticipant,
  async (req, res, next) => {
    try {
      const conversationId = req.chat!.conversationId;
      const { rows } = await pool.query<{ last_read_at: Date }>(
        `UPDATE conversation_participants
         SET last_read_at = NOW()
         WHERE conversation_id = $1 AND user_id = $2
         RETURNING last_read_at`,
        [conversationId, req.userId],
      );
      await publish(pool, await participantIds(pool, conversationId), "conversation:read", {
        conversationId,
        userId: req.userId,
        lastReadAt: rows[0]?.last_read_at,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ===========================================================================
// POST /api/conversations/:conversationId/typing — "digitando..."
// ---------------------------------------------------------------------------
// Evento efêmero: nada vai para o banco. O front chama no máximo a cada 3 s
// enquanto a pessoa digita; aqui um throttle por pessoa e conversa (2 s)
// segura clientes apressados. O evento leva o nome para o front não precisar
// buscar.
// ===========================================================================

const TYPING_THROTTLE_MS = 2_000;
const lastTyping = new Map<string, number>();

router.post(
  "/:conversationId/typing",
  rateLimit({ name: "typing", limit: 60, windowMs: 60_000 }),
  requireParticipant,
  async (req, res, next) => {
    try {
      const conversationId = req.chat!.conversationId;
      const key = `${req.userId}:${conversationId}`;
      const now = Date.now();
      if (now - (lastTyping.get(key) ?? 0) < TYPING_THROTTLE_MS) return res.status(204).end();
      lastTyping.set(key, now);
      if (lastTyping.size > 5_000) {
        for (const [k, at] of lastTyping) if (now - at > 60_000) lastTyping.delete(k);
      }

      const others = (await participantIds(pool, conversationId)).filter(
        (id) => id !== req.userId,
      );
      const names = await namesOf(pool, [req.userId!]);
      await publish(pool, others, "typing", {
        conversationId,
        userId: req.userId,
        name: names.get(req.userId!) ?? "Alguém",
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
