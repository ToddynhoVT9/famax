/**
 * FAMAX — Tempo real no navegador (Shared)
 *
 * Uma conexão SSE por aba (GET /api/stream), aberta na primeira vez que
 * alguém se inscreve num evento. O EventSource não manda o header
 * Authorization, então antes de cada conexão pede-se um ticket de uso único
 * (POST /api/stream/ticket) que vai na query string.
 *
 * Quando a conexão cai (rede, deploy, servidor reiniciando), fecha o
 * EventSource — a reconexão automática dele reusaria o ticket já gasto — e
 * tenta de novo com backoff exponencial (1 s → 30 s, com variação para as
 * abas não voltarem todas no mesmo instante). Enquanto estiver fora, quem
 * depende do stream (chat, sininho) cai para o polling, avisado por
 * onRealtimeStatus.
 *
 * Os eventos levam só ids; quem recebe busca o resto pela API.
 */
import { api, getToken } from "./api.js";

export type RealtimeEvent =
    | "message:new"
    | "message:deleted"
    | "conversation:read"
    | "conversation:updated"
    | "notification:new"
    | "typing";

const EVENTS: RealtimeEvent[] = [
    "message:new",
    "message:deleted",
    "conversation:read",
    "conversation:updated",
    "notification:new",
    "typing",
];

type Handler = (data: Record<string, unknown>) => void;

const handlers = new Map<RealtimeEvent, Set<Handler>>();
const statusListeners = new Set<(open: boolean) => void>();

let source: EventSource | null = null;
let open = false;
let started = false;
let retryDelay = 1_000;
let retryTimer: number | undefined;

function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    for (const listener of statusListeners) listener(open);
}

function scheduleReconnect(): void {
    window.clearTimeout(retryTimer);
    const jitter = Math.random() * 0.3 * retryDelay;
    retryTimer = window.setTimeout(() => void connect(), retryDelay + jitter);
    retryDelay = Math.min(retryDelay * 2, 30_000);
}

async function connect(): Promise<void> {
    if (!getToken()) return;
    source?.close();
    source = null;

    let ticket: string;
    try {
        ({ ticket } = await api.stream.ticket());
    } catch {
        // 401 o api() já trata (manda ao login); outro erro: tenta de novo depois.
        scheduleReconnect();
        return;
    }

    const es = new EventSource(`/api/stream?ticket=${encodeURIComponent(ticket)}`);
    source = es;

    es.addEventListener("ready", () => {
        retryDelay = 1_000;
        setOpen(true);
    });
    // O servidor encerra conexões longas para revalidar a sessão: reconecta
    // na hora, com ticket novo.
    es.addEventListener("reconnect", () => {
        es.close();
        setOpen(false);
        retryDelay = 1_000;
        void connect();
    });
    es.onerror = () => {
        if (source !== es) return;
        es.close();
        source = null;
        setOpen(false);
        scheduleReconnect();
    };

    for (const type of EVENTS) {
        es.addEventListener(type, (event) => {
            let data: Record<string, unknown> = {};
            try {
                data = JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>;
            } catch {
                return;
            }
            for (const handler of handlers.get(type) ?? []) handler(data);
        });
    }
}

function ensureStarted(): void {
    if (started || !getToken()) return;
    started = true;
    void connect();
    // Voltou a ter rede: não espera o backoff.
    window.addEventListener("online", () => {
        if (!open) {
            retryDelay = 1_000;
            void connect();
        }
    });
}

/** Inscreve num evento (e abre a conexão, se ainda não abriu). */
export function onRealtime(type: RealtimeEvent, handler: Handler): () => void {
    let set = handlers.get(type);
    if (!set) {
        set = new Set();
        handlers.set(type, set);
    }
    set.add(handler);
    ensureStarted();
    return () => set?.delete(handler);
}

/** Avisa quando o stream abre ou cai (true = tempo real funcionando). */
export function onRealtimeStatus(listener: (open: boolean) => void): () => void {
    statusListeners.add(listener);
    ensureStarted();
    return () => statusListeners.delete(listener);
}

export function isRealtimeOpen(): boolean {
    return open;
}
