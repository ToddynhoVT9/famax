/**
 * FAMAX — Notificações (Shared)
 *
 * O sininho do header (badge de não lidas + dropdown com as últimas), o
 * contador no título da aba e o desenho de cada aviso, que a página
 * html/notifications.html reaproveita.
 *
 * Polling a cada 30 s, no mesmo espírito do chat-widget: pausa com a aba
 * oculta e consulta na hora quando ela volta. (O prompt de tempo real troca
 * o polling por push.)
 *
 * Tudo entra por textContent / createElement: nome, título e trecho de
 * comentário são texto de usuário.
 */
import { api, getToken } from "./api.js";
import { communityUrl, pages, postUrl, profileUrl } from "./pages.js";
import { avatarColor, initials, timeAgo, truncate } from "./dom.js";

export type NotificationType =
    | "post_comment"
    | "comment_reply"
    | "post_like"
    | "content_removed"
    | "community_role"
    | "mention"
    | "follow"
    | "event";

export interface AppNotification {
    notification_id: string;
    type: NotificationType;
    read_at: string | null;
    created_at: string;
    post_id: string | null;
    comment_id: string | null;
    community_id: string | null;
    event_id?: string | null;
    event_title?: string | null;
    event_starts_at?: string | null;
    data: { role?: string; kind?: string; title?: string; excerpt?: string } | null;
    actor_id: string | null;
    actor_username: string | null;
    actor_display_name: string | null;
    actor_avatar_url: string | null;
    post_title: string | null;
    community_name: string | null;
    comment_excerpt: string | null;
    likes_count: number | null;
}

export interface NotificationPage {
    data: AppNotification[];
    nextCursor: string | null;
    unread: number;
}

const POLL_MS = 30_000;

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
    return n.actor_display_name?.trim() || n.actor_username || "Alguém";
}

const quoted = (text: string | null | undefined) => `“${truncate(text ?? "", 80)}”`;

/**
 * A frase em pedaços: strings são texto comum, { strong } vira negrito.
 * Montada assim para nunca passar texto de usuário por innerHTML.
 */
type Part = string | { strong: string };

function describe(n: AppNotification): Part[] {
    const actor = { strong: actorName(n) };
    const title = quoted(n.post_title);
    switch (n.type) {
        case "post_comment":
            return [actor, " comentou na sua discussão ", title];
        case "comment_reply":
            return [actor, " respondeu seu comentário em ", title];
        case "post_like": {
            const others = Math.max(0, (n.likes_count ?? 1) - 1);
            return others > 0
                ? [actor, ` e mais ${others} ${others === 1 ? "pessoa reagiram a" : "pessoas reagiram a"} `, title]
                : [actor, " reagiu a ", title];
        }
        case "content_removed":
            return n.data?.kind === "comment"
                ? ["A moderação de ", { strong: n.community_name ?? "uma comunidade" }, " removeu seu comentário ", quoted(n.data?.excerpt)]
                : ["A moderação de ", { strong: n.community_name ?? "uma comunidade" }, " removeu sua discussão ", quoted(n.data?.title)];
        case "community_role":
            return n.data?.role === "owner"
                ? [actor, " transferiu ", { strong: n.community_name ?? "a comunidade" }, " para você"]
                : ["Você agora é moderador de ", { strong: n.community_name ?? "uma comunidade" }];
        case "mention":
            return [actor, " mencionou você em ", title];
        case "follow":
            return [actor, " começou a seguir você"];
        case "event":
            return [
                "Novo evento em ",
                { strong: n.community_name ?? "uma comunidade" },
                ": ",
                quoted(n.event_title ?? n.data?.title),
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
            return n.post_id ? postUrl(n.post_id, n.comment_id) : pages.home;
        case "post_like":
            return n.post_id ? postUrl(n.post_id) : pages.home;
        case "follow":
            return n.actor_id ? profileUrl(n.actor_id) : pages.home;
        case "event":
            return n.community_id ? communityUrl(n.community_id, "events") : pages.home;
        default:
            // Conteúdo removido (o post não existe mais) e papel.
            return n.community_id ? communityUrl(n.community_id) : pages.home;
    }
}

function renderAvatar(n: AppNotification): HTMLElement {
    // Aviso do sistema (moderação): sem pessoa, um ícone.
    if (!n.actor_id || n.type === "content_removed") {
        const icon = el("span", "notif-avatar notif-avatar--system", "!");
        icon.setAttribute("aria-hidden", "true");
        return icon;
    }
    if (n.actor_avatar_url) {
        const img = el("img", "notif-avatar");
        img.src = n.actor_avatar_url;
        img.alt = "";
        return img;
    }
    const span = el("span", `notif-avatar ${avatarColor(n.actor_id)}`, initials(actorName(n)));
    span.setAttribute("aria-hidden", "true");
    return span;
}

/** Um aviso como link. Quem chama decide o que fazer no clique (marcar lida). */
export function renderNotification(n: AppNotification): HTMLAnchorElement {
    const item = el("a", `notif-item${n.read_at ? "" : " is-unread"}`);
    item.href = notificationHref(n);
    item.dataset.id = n.notification_id;

    const body = el("span", "notif-body");
    const text = el("span", "notif-text");
    for (const part of describe(n)) {
        text.append(typeof part === "string" ? part : el("strong", "", part.strong));
    }
    body.append(text);

    if ((n.type === "post_comment" || n.type === "comment_reply") && n.comment_excerpt) {
        body.append(el("span", "notif-excerpt", truncate(n.comment_excerpt, 120)));
    }
    body.append(el("span", "notif-time", timeAgo(n.created_at)));

    item.append(renderAvatar(n), body);
    if (!n.read_at) {
        const dot = el("span", "notif-dot");
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
    const page = await api<NotificationPage>(`/notifications?${params}`);
    setUnreadCount(page.unread);
    return page;
}

/** Sem ids: todas. Atualiza o badge com a contagem que o servidor devolve. */
export async function markRead(ids?: string[]): Promise<void> {
    const { unread: count } = await api<{ unread: number }>("/notifications/read", {
        method: "POST",
        body: JSON.stringify(ids ? { ids } : {}),
        // Clique num aviso navega logo em seguida: keepalive deixa o pedido
        // terminar mesmo com a página saindo.
        keepalive: true,
    });
    setUnreadCount(count);
}

/**
 * Clique num aviso: marca como lido e segue o link. Com Ctrl/⌘/meio (nova
 * aba) só marca, sem segurar a navegação.
 */
export function handleNotificationClick(event: MouseEvent, item: HTMLAnchorElement): void {
    const id = item.dataset.id;
    if (!id || !item.classList.contains("is-unread")) return;

    item.classList.remove("is-unread");
    item.querySelector(".notif-dot")?.remove();
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
        const { unread: count } = await api<{ unread: number }>("/notifications/unread-count");
        setUnreadCount(count);
    } catch {
        /* rede instável: tenta de novo no próximo ciclo; 401 o api() já trata */
    }
}

function schedulePoll(): void {
    window.clearTimeout(pollTimer);
    if (document.hidden) return;
    pollTimer = window.setTimeout(async () => {
        await refreshCount();
        schedulePoll();
    }, POLL_MS);
}

function startPolling(): void {
    if (polling) return;
    polling = true;
    watchTitle();
    void refreshCount();
    schedulePoll();
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

    const button = el("button", "notif-bell-btn");
    button.type = "button";
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    const icon = el("span", "notif-bell-icon", "🔔");
    icon.setAttribute("aria-hidden", "true");
    const badge = el("span", "notif-badge");
    badge.hidden = true;
    button.append(icon, badge);

    const panel = el("div", "notif-panel");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Notificações");

    const head = el("div", "notif-panel-head");
    const markAll = el("button", "notif-mark-all", "Marcar todas como lidas");
    markAll.type = "button";
    head.append(el("strong", "", "Notificações"), markAll);
    const list = el("div", "notif-list");
    const footer = el("a", "notif-panel-footer", "Ver todas");
    footer.href = pages.notifications;
    panel.append(head, list, footer);
    wrapper.append(button, panel);

    onUnreadChange((count) => {
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? "99+" : String(count);
        button.setAttribute("aria-label", count > 0 ? `Notificações: ${count} não lidas` : "Notificações");
        markAll.disabled = count === 0;
    });

    let loadSeq = 0;
    const load = async (): Promise<void> => {
        const seq = ++loadSeq;
        list.replaceChildren(el("p", "notif-status", "Carregando..."));
        try {
            const { data } = await fetchNotifications(null, 8);
            if (seq !== loadSeq) return;
            list.replaceChildren(
                ...(data.length
                    ? data.map(renderNotification)
                    : [el("p", "notif-status", "Nenhuma notificação ainda.")]),
            );
        } catch (err) {
            if (seq === loadSeq) {
                list.replaceChildren(
                    el("p", "notif-status", err instanceof Error ? err.message : "Não foi possível carregar."),
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
        const item = (event.target as Element).closest<HTMLAnchorElement>(".notif-item");
        if (item) handleNotificationClick(event, item);
    });

    markAll.addEventListener("click", async () => {
        markAll.disabled = true;
        try {
            await markRead();
            list.querySelectorAll(".notif-item.is-unread").forEach((item) => {
                item.classList.remove("is-unread");
                item.querySelector(".notif-dot")?.remove();
            });
        } catch {
            markAll.disabled = false;
        }
    });

    startPolling();
    return wrapper;
}
