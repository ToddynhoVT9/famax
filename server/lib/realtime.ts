import type { Response } from "express";
import pg from "pg";
import { config } from "../config.js";
import { pool } from "../db.js";
import { toCamel } from "./case.js";

/**
 * Tempo real: o hub que entrega eventos por usuário às conexões SSE abertas
 * neste processo (GET /api/stream, stream.routes.ts) e o barramento entre
 * processos.
 *
 * Barramento (REALTIME_BUS, config.ts)
 *  - "postgres": publicar é um pg_notify no canal famax_realtime; cada
 *    instância mantém UMA conexão dedicada com LISTEN e entrega às suas
 *    próprias conexões SSE. Assim um evento gerado na instância A chega a
 *    quem está conectado na instância B.
 *  - "memory": entrega direta, só neste processo. É o modo do banco
 *    embarcado (o socket do PGlite atende uma conexão por vez — um LISTEN
 *    parado nela travaria todas as queries) e dos testes. Também é para onde
 *    o modo postgres cai se a conexão do LISTEN não abrir no boot.
 *
 * Limite do NOTIFY: o payload tem no máximo 8000 bytes. Por isso os eventos
 * levam só ids (conversa, mensagem, notificação) e o front busca o resto pela
 * API, com as regras de acesso de sempre; e a lista de destinatários é
 * quebrada em lotes (MAX_USERS_PER_NOTIFY) — um evento de comunidade grande
 * vira vários NOTIFY pequenos.
 *
 * Transação: publish() recebe o client da transação da ação. No modo
 * postgres o pg_notify roda NELE, e o Postgres só entrega o NOTIFY no COMMIT
 * (e descarta no ROLLBACK) — ninguém recebe aviso de algo que não aconteceu.
 * No modo memory o mesmo efeito vem de afterCommit(), que segura o evento até
 * o COMMIT daquele client.
 *
 * Supabase: o LISTEN precisa de conexão de SESSÃO. O pooler em modo
 * transação (porta 6543) troca a conexão a cada transação e o LISTEN se
 * perde; use a conexão direta ou o pooler em modo sessão (porta 5432), por
 * REALTIME_DATABASE_URL se a DATABASE_URL apontar para o modo transação. O
 * pg_notify em si funciona em qualquer modo.
 */

export type RealtimeEventType =
  | "message:new"
  | "message:deleted"
  | "conversation:read"
  | "conversation:updated"
  | "notification:new"
  | "typing";

interface Envelope {
  /** Destinatários (user_id). */
  u: string[];
  e: RealtimeEventType;
  d: Record<string, unknown>;
}

const CHANNEL = "famax_realtime";
/** 150 UUIDs ≈ 5.6 KB: sobra espaço para o resto do payload nos 8000 bytes. */
const MAX_USERS_PER_NOTIFY = 150;
const MAX_PAYLOAD_BYTES = 7900;

type Queryable = Pick<pg.PoolClient, "query">;

// ===========================================================================
// Conexões SSE deste processo
// ===========================================================================

const clients = new Map<string, Set<Response>>();

/** Registra uma conexão SSE; devolve a função que a remove. */
export function addClient(userId: string, res: Response): () => void {
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(res);
  return () => {
    const current = clients.get(userId);
    current?.delete(res);
    if (current && current.size === 0) clients.delete(userId);
  };
}

/** Quantas conexões SSE abertas neste processo (diagnóstico e testes). */
export function connectionCount(): number {
  let total = 0;
  for (const set of clients.values()) total += set.size;
  return total;
}

export function writeEvent(res: Response, type: string, data: unknown): void {
  // Mesmo formato das respostas da API (camelCase, ver lib/case.ts).
  res.write(`event: ${type}\ndata: ${JSON.stringify(toCamel(data))}\n\n`);
}

function deliverLocal(envelope: Envelope): void {
  for (const userId of envelope.u) {
    const set = clients.get(userId);
    if (!set) continue;
    for (const res of set) {
      try {
        writeEvent(res, envelope.e, envelope.d);
      } catch {
        // Conexão morrendo: o 'close' do request faz a limpeza.
      }
    }
  }
}

/** Fecha todas as conexões (o front reconecta). Usado quando o LISTEN cai. */
function closeAllClients(): void {
  for (const set of clients.values()) {
    for (const res of set) res.end();
  }
}

// ===========================================================================
// Modo memory: segurar o evento até o COMMIT
// ===========================================================================

const pendingByClient = new WeakMap<object, Array<() => void>>();

/**
 * Roda `fn` depois do COMMIT do client (e descarta no ROLLBACK). Envolve o
 * query() daquele client só até a transação terminar e devolve o original —
 * o client volta ao pool como chegou.
 */
function afterCommit(client: Queryable, fn: () => void): void {
  const existing = pendingByClient.get(client);
  if (existing) {
    existing.push(fn);
    return;
  }
  const queue = [fn];
  pendingByClient.set(client, queue);

  const target = client as { query: (...args: unknown[]) => Promise<unknown> };
  const original = target.query;
  target.query = async (...args: unknown[]) => {
    const result = await original.apply(client, args);
    const text = typeof args[0] === "string" ? args[0].trim().toUpperCase() : "";
    if (text === "COMMIT" || text === "ROLLBACK") {
      target.query = original;
      pendingByClient.delete(client);
      if (text === "COMMIT") for (const run of queue) run();
    }
    return result;
  };
}

// ===========================================================================
// Publicar
// ===========================================================================

let mode: "postgres" | "memory" = config.REALTIME_BUS;

export function realtimeMode(): "postgres" | "memory" {
  return mode;
}

/**
 * Publica um evento para os usuários. `db`: o client da transação da ação
 * (entrega só no COMMIT) ou o pool, para eventos fora de transação.
 */
export async function publish(
  db: Queryable,
  users: Iterable<string>,
  type: RealtimeEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const unique = [...new Set(users)];
  if (unique.length === 0) return;

  if (mode === "memory") {
    const envelope: Envelope = { u: unique, e: type, d: data };
    if (db === pool) deliverLocal(envelope);
    else afterCommit(db, () => deliverLocal(envelope));
    return;
  }

  for (let i = 0; i < unique.length; i += MAX_USERS_PER_NOTIFY) {
    const payload = JSON.stringify({ u: unique.slice(i, i + MAX_USERS_PER_NOTIFY), e: type, d: data });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      // Só acontece com `data` grande demais — erro de programação: eventos
      // levam ids, não conteúdo.
      console.error(`realtime: evento ${type} passa de ${MAX_PAYLOAD_BYTES} bytes, descartado`);
      return;
    }
    await db.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
  }
}

// ===========================================================================
// Modo postgres: a conexão do LISTEN
// ===========================================================================

let listener: pg.Client | null = null;
let stopping = false;
let reconnectDelay = 1_000;

async function connectListener(): Promise<void> {
  const client = new pg.Client({
    connectionString: config.REALTIME_DATABASE_URL,
    ssl: config.DB_MODE === "embedded" || process.env.DATABASE_SSL === "false"
      ? false
      : { rejectUnauthorized: false },
  });
  client.on("notification", (message) => {
    if (message.channel !== CHANNEL || !message.payload) return;
    try {
      deliverLocal(JSON.parse(message.payload) as Envelope);
    } catch (err) {
      console.error("realtime: payload inválido:", (err as Error).message);
    }
  });
  client.on("error", (err) => {
    console.error("realtime: conexão do LISTEN caiu:", err.message);
  });
  client.on("end", () => {
    if (listener !== client || stopping) return;
    listener = null;
    // Sem LISTEN este processo não recebe nada: fecha os streams (o front
    // cai no polling e reconecta) e tenta de novo com backoff.
    closeAllClients();
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    setTimeout(() => {
      connectListener()
        .then(() => {
          reconnectDelay = 1_000;
          console.log("realtime: LISTEN reconectado.");
        })
        .catch((err) => console.error("realtime: falha ao reconectar:", err.message));
    }, delay);
  });

  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
  listener = client;
}

/**
 * Sobe o barramento. Chamado depois do banco pronto (server.ts). Falha aqui
 * não derruba a API: cai para o modo memory, que funciona com uma instância.
 */
export async function startRealtimeBus(): Promise<void> {
  if (mode === "memory") {
    console.log("Tempo real: barramento em memória (uma instância).");
    return;
  }
  try {
    await connectListener();
    console.log("Tempo real: LISTEN/NOTIFY no Postgres.");
  } catch (err) {
    mode = "memory";
    console.warn(
      `⚠️  Tempo real: LISTEN indisponível (${(err as Error).message}). ` +
        "Usando o barramento em memória — só funciona com uma instância.",
    );
  }
}

export async function stopRealtimeBus(): Promise<void> {
  stopping = true;
  closeAllClients();
  await listener?.end().catch(() => {});
  listener = null;
}
