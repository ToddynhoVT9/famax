import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";

const router = Router();

// Todo o chat é privado.
router.use(requireAuth);

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
    const { rows } = await pool.query(
      `SELECT 1 FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2`,
      [parsed.data, req.userId],
    );

    if (rows.length === 0) {
      // 404 em vez de 403: um 403 confirmaria que a conversa existe.
      return res.status(404).json({ error: "Conversa não encontrada" });
    }

    next();
  } catch (err) {
    next(err);
  }
};

// ===========================================================================
// GET /api/conversations — lista de contatos do widget
// ===========================================================================

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.conversation_id,
         c.last_message_at,
         other.user_id        AS other_user_id,
         other.username       AS other_username,
         other_p.display_name AS other_display_name,
         other_p.avatar_url   AS other_avatar_url,
         lm.content           AS last_message_content,
         lm.sender_id         AS last_message_sender_id,
         (SELECT COUNT(*) FROM messages m2
          WHERE m2.conversation_id = c.conversation_id
            AND m2.created_at > me.last_read_at
            AND m2.sender_id <> $1
            AND m2.deleted_at IS NULL)::int AS unread_count
       FROM conversation_participants me
       INNER JOIN conversations c
             ON c.conversation_id = me.conversation_id
       INNER JOIN conversation_participants op
             ON op.conversation_id = c.conversation_id
            AND op.user_id <> $1
       INNER JOIN users other        ON other.user_id = op.user_id
       LEFT  JOIN user_profiles other_p ON other_p.user_id = other.user_id
       LEFT  JOIN LATERAL (
         SELECT content, sender_id
         FROM messages m
         WHERE m.conversation_id = c.conversation_id
           AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC
         LIMIT 1
       ) lm ON TRUE
       WHERE me.user_id = $1
       ORDER BY c.last_message_at DESC
       LIMIT 30`,
      [req.userId],
    );

    res.json({ data: rows });
  } catch (err) {
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
// GET /api/conversations/:conversationId/messages
// ===========================================================================
//
// `after`  → usado pelo polling: só o que chegou depois da última mensagem
//            conhecida. É o que mantém o custo do tick baixo.
// `before` → usado pelo scroll para trás (histórico).
// ===========================================================================

const messagesQuery = z.object({
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  "/:conversationId/messages",
  requireParticipant,
  async (req, res, next) => {
    try {
      const conversationId = req.params.conversationId;
      const { after, before, limit } = messagesQuery.parse(req.query);

      const params: unknown[] = [conversationId];
      let cursor = "";

      if (after) {
        params.push(after);
        cursor = `AND m.created_at > $${params.length}`;
      } else if (before) {
        params.push(before);
        cursor = `AND m.created_at < $${params.length}`;
      }

      params.push(limit);

      // Busca em DESC (usa o índice e pega as N mais recentes), depois
      // reordena em ASC para o cliente renderizar de cima para baixo.
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT
             m.message_id,
             m.conversation_id,
             m.sender_id,
             m.content,
             m.created_at,
             up.display_name AS sender_display_name
           FROM messages m
           LEFT JOIN user_profiles up ON up.user_id = m.sender_id
           WHERE m.conversation_id = $1
             AND m.deleted_at IS NULL
             ${cursor}
           ORDER BY m.created_at DESC
           LIMIT $${params.length}
         ) recent
         ORDER BY created_at ASC`,
        params,
      );

      res.json({ data: rows });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Parâmetros inválidos", details: err.flatten() });
      }
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
      const conversationId = req.params.conversationId;
      const { content } = sendMessageSchema.parse(req.body);
      const messageId = randomUUID();

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
      await client.query("COMMIT");

      const { rows } = await client.query(
        `SELECT
           m.message_id,
           m.conversation_id,
           m.sender_id,
           m.content,
           m.created_at,
           up.display_name AS sender_display_name
         FROM messages m
         LEFT JOIN user_profiles up ON up.user_id = m.sender_id
         WHERE m.message_id = $1`,
        [messageId],
      );

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
// POST /api/conversations/:conversationId/read — zera o badge de não lidas
// ===========================================================================

router.post(
  "/:conversationId/read",
  requireParticipant,
  async (req, res, next) => {
    try {
      await pool.query(
        `UPDATE conversation_participants
         SET last_read_at = NOW()
         WHERE conversation_id = $1 AND user_id = $2`,
        [req.params.conversationId, req.userId],
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
