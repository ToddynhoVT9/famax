/**
 * FAMAX — Página de notificações (html/notifications.html)
 *
 * A lista completa, paginada por cursor ("Carregar mais"), com o mesmo
 * desenho e o mesmo clique (marca como lida e segue o link) do dropdown do
 * sininho — ambos vêm de shared/notifications.ts.
 */
import { requireLogin } from "./shared/auth-guard.js";
import { initLayout } from "./shared/layout.js";
import { pages } from "./shared/pages.js";
import { toast } from "./shared/dialog.js";
import { ICONS } from "./shared/icons.js";
import {
    fetchNotifications,
    handleNotificationClick,
    markRead,
    onUnreadChange,
    renderNotification,
} from "./shared/notifications.js";

requireLogin();
initLayout();

const list = document.getElementById("notifList");
const more = document.getElementById("btnMore") as HTMLButtonElement | null;
// "Marcar todas como lidas": em texto e, no celular, em ícone (o CSS mostra um dos dois).
const markAllButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-mark-all]"));
const markIcon = document.querySelector<HTMLButtonElement>(".notif-mark-icon");
if (markIcon) markIcon.innerHTML = ICONS.checks; // ícone fixo, sem dado
const settingsLink = document.getElementById("settingsLink") as HTMLAnchorElement | null;
if (settingsLink) settingsLink.href = pages.settings;

let cursor: string | null = null;

function status(text: string, isError = false): HTMLElement {
    const p = document.createElement("p");
    p.className = `fx-notif-status${isError ? " error" : ""}`;
    p.textContent = text;
    return p;
}

async function load(reset: boolean): Promise<void> {
    if (!list || !more) return;
    if (reset) {
        cursor = null;
        list.replaceChildren(status("Carregando notificações..."));
    }
    more.disabled = true;
    try {
        const page = await fetchNotifications(cursor, 20);
        if (reset) list.replaceChildren();
        list.append(...page.data.map(renderNotification));
        if (list.childElementCount === 0) list.replaceChildren(status("Nenhuma notificação ainda."));
        cursor = page.nextCursor;
        more.hidden = !cursor;
    } catch (err) {
        const message = err instanceof Error ? err.message : "Não foi possível carregar.";
        if (reset) list.replaceChildren(status(message, true));
        else toast(message, "error");
    } finally {
        more.disabled = false;
    }
}

list?.addEventListener("click", (event) => {
    const item = (event.target as Element).closest<HTMLAnchorElement>("[data-notif-id]");
    if (item) handleNotificationClick(event, item);
});

more?.addEventListener("click", () => void load(false));

const setMarkAllDisabled = (disabled: boolean): void => {
    for (const button of markAllButtons) button.disabled = disabled;
};

onUnreadChange((count) => setMarkAllDisabled(count === 0));

async function markAllRead(): Promise<void> {
    setMarkAllDisabled(true);
    try {
        await markRead();
        list?.querySelectorAll("[data-notif-id].is-unread").forEach((item) => {
            item.classList.remove("is-unread");
            item.querySelector("[data-notif-dot]")?.remove();
        });
        toast("Tudo marcado como lido.");
    } catch (err) {
        toast(err instanceof Error ? err.message : "Não foi possível marcar.", "error");
        setMarkAllDisabled(false);
    }
}

for (const button of markAllButtons) button.addEventListener("click", () => void markAllRead());

void load(true);
