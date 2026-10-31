/**
 * FAMAX — Notificações (Shared)
 *
 * O sininho do header (badge de não lidas + dropdown com as últimas), o
 * contador no título da aba e o desenho de cada aviso, que a página
 * html/notifications.html reaproveita.
 *
 * Tempo real: o evento notification:new do stream SSE (shared/realtime.ts)
 * atualiza o badge (e o dropdown aberto) na hora. O polling ficou de
 * reserva: só roda enquanto o stream está fora, a cada 60 s, pausado com a
 * aba oculta e com uma consulta na hora quando ela volta.
 *
 * Tudo entra por textContent / createElement: nome, título e trecho de
 * comentário são texto de usuário.
 */
import { api, getToken } from "./api.js";
import { communityUrl, pages, postUrl, profileUrl } from "./pages.js";
import { avatarColor, initials, timeAgo, truncate } from "./dom.js";
import { isRealtimeOpen, onRealtime, onRealtimeStatus } from "./realtime.js";
import { ICONS } from "./icons.js";
import type { AppNotification, NotificationPage, NotificationType } from "../../../shared/api-types.js";
export type { AppNotification, NotificationPage, NotificationType };

/** Polling de reserva, só enquanto o stream SSE está fora. */
const FALLBACK_POLL_MS = 60_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// ===========================================================================
// Texto e destino de cada aviso
// ===========================================================================

function actorName(n: AppNotification): string {
    return n.actorDisplayName?.trim() || n.actorUsername || "Alguém";
}

const quoted = (text: string | null | undefined) => `“${truncate(text ?? "", 80)}”`;

/**
 * A frase em pedaços: strings são texto comum, { strong } vira negrito.
 * Montada assim para nunca passar texto de usuário por innerHTML.
 */
type Part = string | { strong: string };

function describe(n: AppNotification): Part[] {
    const actor = { strong: actorName(n) };
    const title = quoted(n.postTitle);
    switch (n.type) {
        case "post_comment":
            return [actor, " comentou na sua discussão ", title];
        case "comment_reply":
            return [actor, " respondeu seu comentário em ", title];
        case "post_like": {
            const others = Math.max(0, (n.likesCount ?? 1) - 1);
            return others > 0
                ? [actor, ` e mais ${others} ${others === 1 ? "pessoa reagiram a" : "pessoas reagiram a"} `, title]
                : [actor, " reagiu a ", title];
        }
        case "content_removed":
            return n.data?.kind === "comment"
                ? ["A moderação de ", { strong: n.communityName ?? "uma comunidade" }, " removeu seu comentário ", quoted(n.data?.excerpt)]
                : ["A moderação de ", { strong: n.communityName ?? "uma comunidade" }, " removeu sua discussão ", quoted(n.data?.title)];
        case "community_role":
            return n.data?.role === "owner"
                ? [actor, " transferiu ", { strong: n.communityName ?? "a comunidade" }, " para você"]
                : ["Você agora é moderador de ", { strong: n.communityName ?? "uma comunidade" }];
        case "mention":
            return [actor, " mencionou você em ", title];
        case "follow":
            return [actor, " começou a seguir você"];
        case "event":
            return [
                "Novo evento em ",
                { strong: n.communityName ?? "uma comunidade" },
                ": ",
                quoted(n.eventTitle ?? n.data?.title),
            ];
        default:
            return ["Nova notificação"];
    }
}

/** Para onde o aviso leva. Comentário: âncora no comentário, na página do post. */
export function notificationHref(n: AppNotification): string {
    switch (n.type) {
        case "post_comment":
        case "comment_reply":
        case "mention":
            return n.postId ? postUrl(n.postId, n.commentId) : pages.home;
        case "post_like":
            return n.postId ? postUrl(n.postId) : pages.home;
        case "follow":
            return n.actorId ? profileUrl(n.actorId) : pages.home;
        case "event":
            return n.communityId ? communityUrl(n.communityId, "events") : pages.home;
        default:
            // Conteúdo removido (o post não existe mais) e papel.
            return n.communityId ? communityUrl(n.communityId) : pages.home;
    }
}

function renderAvatar(n: AppNotification): HTMLElement {
    // Aviso do sistema (moderação): sem pessoa, um ícone.
    if (!n.actorId || n.type === "content_removed") {
        const icon = el("span", "fx-avatar fx-avatar--md fx-avatar--system", "!");
        icon.setAttribute("aria-hidden", "true");
        return icon;
    }
    if (n.actorAvatarUrl) {
        const img = el("img", "fx-avatar fx-avatar--md");
        img.src = n.actorAvatarUrl;
        img.alt = "";
        return img;
    }
    const span = el("span", `fx-avatar fx-avatar--md ${avatarColor(n.actorId)}`, initials(actorName(n)));
    span.setAttribute("aria-hidden", "true");
    return span;
}

/** Um aviso como link. Quem chama decide o que fazer no clique (marcar lida). */
export function renderNotification(n: AppNotification): HTMLAnchorElement {
    const item = el("a", `fx-notif-item${n.readAt ? "" : " is-unread"}`);
    item.href = notificationHref(n);
    item.dataset.notifId = n.notificationId;

    const body = el("span", "fx-notif-body");
    const text = el("span", "fx-notif-text");
    for (const part of describe(n)) {
        text.append(typeof part === "string" ? part : el("strong", "", part.strong));
    }
    body.append(text);

    if ((n.type === "post_comment" || n.type === "comment_reply") && n.commentExcerpt) {
        body.append(el("span", "fx-notif-excerpt", truncate(n.commentExcerpt, 120)));
    }
    body.append(el("span", "fx-notif-time", timeAgo(n.createdAt)));

    item.append(renderAvatar(n), body);
    if (!n.readAt) {
        const dot = el("span", "fx-notif-dot");
        dot.dataset.notifDot = "";
        dot.setAttribute("aria-label", "não lida");
        item.append(dot);
    }
    return item;
}

// ===========================================================================
// Contagem compartilhada: badge, título da aba e quem mais escutar
// ===========================================================================

let unread = 0;
const listeners = new Set<(count: number) => void>();

export function onUnreadChange(listener: (count: number) => void): void {
    listeners.add(listener);
    listener(unread);
}

export function setUnreadCount(count: number): void {
    unread = Math.max(0, count);
    applyTitle();
    for (const listener of listeners) listener(unread);
}

const TITLE_PREFIX = /^\(\d+\)\s*/;

/** "(3) FAMAX - ..." — mantém o título que a página definiu. */
function applyTitle(): void {
    const base = document.title.replace(TITLE_PREFIX, "");
    const next = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base;
    if (document.title !== next) document.title = next;
}

let titleObserver: MutationObserver | null = null;

/**
 * Páginas trocam o título depois de carregar (post, comunidade). O observer
 * recoloca o contador; o if em applyTitle evita laço infinito.
 */
function watchTitle(): void {
    const titleEl = document.querySelector("title");
    if (!titleEl || titleObserver) return;
    titleObserver = new MutationObserver(() => applyTitle());
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
}

// ===========================================================================
// API
// ===========================================================================

export async function fetchNotifications(cursor?: string | null, limit = 20): Promise<NotificationPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const page = await api.notifications.list({ limit, cursor });
    setUnreadCount(page.unread);
    return page;
}

/** Sem ids: todas. Atualiza o badge com a contagem que o servidor devolve. */
export async function markRead(ids?: string[]): Promise<void> {
    const { unread: count } = await api.notifications.markRead(ids);
    setUnreadCount(count);
}

/**
 * Clique num aviso: marca como lido e segue o link. Com Ctrl/⌘/meio (nova
 * aba) só marca, sem segurar a navegação.
 */
export function handleNotificationClick(event: MouseEvent, item: HTMLAnchorElement): void {
    const id = item.dataset.notifId;
    if (!id || !item.classList.contains("is-unread")) return;

    item.classList.remove("is-unread");
    item.querySelector("[data-notif-dot]")?.remove();
    const newTab = event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1;
    if (newTab) {
        void markRead([id]).catch(() => {});
        return;
    }
    event.preventDefault();
    // Não espera para sempre: se a API demorar, navega mesmo assim.
    const timeout = new Promise((resolve) => window.setTimeout(resolve, 800));
    void Promise.race([markRead([id]).catch(() => {}), timeout]).then(() => {
        window.location.href = item.href;
    });
}

// ===========================================================================
// Sininho do header
// ===========================================================================

let pollTimer: number | undefined;
let polling = false;

async function refreshCount(): Promise<void> {
    if (!getToken()) return;
    try {
        const { unread: count } = await api.notifications.unreadCount();
        setUnreadCount(count);
    } catch {
        /* rede instável: tenta de novo no próximo ciclo; 401 o api() já trata */
    }
}

function schedulePoll(): void {
    window.clearTimeout(pollTimer);
    if (document.hidden || isRealtimeOpen()) return;
    pollTimer = window.setTimeout(async () => {
        await refreshCount();
        schedulePoll();
    }, FALLBACK_POLL_MS);
}

/** Avisados a cada notificação nova (o dropdown aberto se recarrega). */
const newNotificationListeners = new Set<() => void>();

function startPolling(): void {
    if (polling) return;
    polling = true;
    watchTitle();
    void refreshCount();
    schedulePoll();
    onRealtime("notification:new", () => {
        void refreshCount();
        for (const listener of newNotificationListeners) listener();
    });
    onRealtimeStatus((open) => {
        // Voltou: acerta o que pode ter chegado enquanto estava fora.
        if (open) void refreshCount();
        schedulePoll();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            window.clearTimeout(pollTimer);
        } else {
            // Voltou para a aba: atualiza na hora, sem esperar o ciclo.
            void refreshCount();
            schedulePoll();
        }
    });
}

/**
 * Monta o sininho. Chamado pelo layout a cada redesenho da área do usuário;
 * o polling começa uma vez só.
 */
export function createNotificationBell(): HTMLElement {
    const wrapper = el("div", "notif-bell");

    const button = el("button", "fx-btn fx-btn--icon");
    button.type = "button";
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    const badge = el("span", "fx-counter-badge");
    badge.hidden = true;
    button.innerHTML = ICONS.bell; // ícone fixo, sem dado
    button.append(badge);
    // Notificação nova chegando (tempo real) é anunciada sem tirar o foco.
    const live = el("span", "visually-hidden");
    live.setAttribute("aria-live", "polite");
    let lastCount = 0;

    const panel = el("div", "fx-notif notif-panel");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Notificações");

    const head = el("div", "fx-notif-head");
    const markAll = el("button", "fx-link", "Marcar todas como lidas");
    markAll.type = "button";
    head.append(el("strong", "fx-notif-title", "Notificações"), markAll);
    const list = el("div", "fx-notif-list");
    const footer = el("a", "fx-notif-foot", "Ver todas");
    footer.href = pages.notifications;
    panel.append(head, list, footer);
    wrapper.append(button, live, panel);

    onUnreadChange((count) => {
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? "99+" : String(count);
        button.setAttribute("aria-label", count > 0 ? `Notificações: ${count} não lidas` : "Notificações");
        markAll.disabled = count === 0;
        if (count > lastCount) live.textContent = `${count} ${count === 1 ? "notificação não lida" : "notificações não lidas"}`;
        lastCount = count;
    });

    let loadSeq = 0;
    const load = async (): Promise<void> => {
        const seq = ++loadSeq;
        list.replaceChildren(el("p", "fx-notif-status", "Carregando..."));
        try {
            const { data } = await fetchNotifications(null, 8);
            if (seq !== loadSeq) return;
            list.replaceChildren(
                ...(data.length
                    ? data.map(renderNotification)
                    : [el("p", "fx-notif-status", "Nenhuma notificação ainda.")]),
            );
        } catch (err) {
            if (seq === loadSeq) {
                list.replaceChildren(
                    el("p", "fx-notif-status", err instanceof Error ? err.message : "Não foi possível carregar."),
                );
            }
        }
    };

    const setOpen = (open: boolean): void => {
        panel.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
        if (open) void load();
    };

    button.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(panel.hidden);
    });
    document.addEventListener("click", (event) => {
        if (!panel.hidden && event.target instanceof Node && !wrapper.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !panel.hidden) {
            setOpen(false);
            button.focus();
        }
    });

    list.addEventListener("click", (event) => {
        const item = (event.target as Element).closest<HTMLAnchorElement>("[data-notif-id]");
        if (item) handleNotificationClick(event, item);
    });

    markAll.addEventListener("click", async () => {
        markAll.disabled = true;
        try {
            await markRead();
            list.querySelectorAll("[data-notif-id].is-unread").forEach((item) => {
                item.classList.remove("is-unread");
                item.querySelector("[data-notif-dot]")?.remove();
            });
        } catch {
            markAll.disabled = false;
        }
    });

    newNotificationListeners.add(() => {
        if (!panel.hidden) void load();
    });

    startPolling();
    return wrapper;
}
