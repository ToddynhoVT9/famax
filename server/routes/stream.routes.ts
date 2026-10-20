import { Router } from "express";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { addClient, writeEvent } from "../lib/realtime.js";

/**
 * Tempo real por Server-Sent Events. O hub e o barramento ficam em
 * lib/realtime.ts; aqui só a autenticação da conexão e o ciclo de vida dela.
 */
const router = Router();

const TICKET_TTL_SECONDS = 60;
const HEARTBEAT_MS = 25_000;
/**
 * Uma conexão vive no máximo isto e então pede para o front reconectar. A
 * reconexão passa de novo pelo ticket — e o ticket pela sessão —, então um
 * logout ou "sair de todos os dispositivos" corta o stream em até 30 min,
 * mesmo sem nenhum evento novo.
 */
const MAX_STREAM_MS = 30 * 60_000;

const hashTicket = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

// ===========================================================================
// POST /api/stream/ticket — ticket de uso único para abrir o stream
// ---------------------------------------------------------------------------
// O EventSource do navegador não envia o header Authorization; o ticket vai
// na query string do GET. Por isso ele vale pouco (60 s), serve uma vez só e
// fica ligado à sessão que o pediu. No banco vai só o hash.
// ===========================================================================

router.post(
  "/stream/ticket",
  requireAuth,
  rateLimit({ name: "stream-ticket", limit: 30, windowMs: 60_000 }),
  async (req, res, next) => {
    try {
      const ticket = randomBytes(32).toString("base64url");
      // Limpeza oportunista: tickets vencidos não servem para nada.
      await pool.query("DELETE FROM stream_tickets WHERE expires_at < NOW() - INTERVAL '1 hour'");
      await pool.query(
        `INSERT INTO stream_tickets (ticket_hash, user_id, session_id, expires_at)
         VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))`,
        [hashTicket(ticket), req.userId, req.sessionId, TICKET_TTL_SECONDS],
      );
      res.json({ ticket, expiresIn: TICKET_TTL_SECONDS });
    } catch (err) {
      next(err);
    }
  },
);

// ===========================================================================
// GET /api/stream?ticket= — o stream de eventos
// ---------------------------------------------------------------------------
// O ticket é apagado na primeira tentativa, valendo ou não: reutilizar é
// impossível por construção. Depois confere validade, sessão ativa e conta
// viva — as mesmas regras do requireAuth.
//
// Eventos: message:new, message:deleted, conversation:read,
// conversation:updated, notification:new e typing, todos com ids (o front
// busca o resto pela API). "ready" ao conectar, "reconnect" ao atingir
// MAX_STREAM_MS, e um comentário de heartbeat a cada 25 s — proxies costumam
// derrubar conexão HTTP ociosa por 60 s.
// ===========================================================================

const streamQuery = z.object({
  ticket: z.string().min(20).max(100),
});

router.get("/stream", async (req, res, next) => {
  try {
    const parsed = streamQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(401).json({ error: "Ticket ausente ou inválido" });
    }

    const { rows } = await pool.query<{ user_id: string; session_id: string; valid: boolean }>(
      `DELETE FROM stream_tickets WHERE ticket_hash = $1
       RETURNING user_id, session_id, expires_at > NOW() AS valid`,
      [hashTicket(parsed.data.ticket)],
    );
    const ticket = rows[0];
    if (!ticket?.valid) {
      return res.status(401).json({ error: "Ticket ausente ou inválido" });
    }

    const { rows: session } = await pool.query(
      `SELECT 1 FROM user_sessions s
       INNER JOIN users u ON u.user_id = s.user_id
       WHERE s.session_id = $1 AND s.user_id = $2
         AND s.revoked_at IS NULL AND s.expires_at > NOW() AND u.deleted_at IS NULL`,
      [ticket.session_id, ticket.user_id],
    );
    if (session.length === 0) {
      return res.status(401).json({ error: "Ticket ausente ou inválido" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx e afins não seguram os eventos num buffer.
      "X-Accel-Buffering": "no",
    });
    // retry: quanto o EventSource espera para reconectar sozinho. O front
    // fecha e pede outro ticket antes disso (o ticket é de uso único).
    res.write("retry: 5000\n\n");
    writeEvent(res, "ready", { userId: ticket.user_id });

    const remove = addClient(ticket.user_id, res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const lifetime = setTimeout(() => {
      writeEvent(res, "reconnect", {});
      res.end();
    }, MAX_STREAM_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      remove();
    });
  } catch (err) {
    next(err);
  }
});

export default router;
