/**
 * FAMAX — Moderação da comunidade (community/moderation.html?id=)
 *
 * Fila de denúncias de posts e comentários (shared/report-queue.ts) e a lista
 * de banidos, com "desbanir". Só dono e moderadores: os outros veem o aviso
 * — e o backend responde 403 de qualquer forma.
 */
import { api } from "./shared/api.js";
import { requireLogin } from "./shared/auth-guard.js";
import { initLayout } from "./shared/layout.js";
import { communityUrl, profileUrl } from "./shared/pages.js";
import { queryParam } from "./shared/dom.js";
import { confirmDialog, toast } from "./shared/dialog.js";
import { banUntil, isStaff, type CommunityRole } from "./shared/moderation.js";
import { createReportQueue } from "./shared/report-queue.js";

requireLogin();

const communityId = queryParam("id");

initLayout({
    pageLinks: communityId
        ? [
              { label: "Discussões", href: communityUrl(communityId) },
              { label: "Regras", href: communityUrl(communityId, "rules") },
              { label: "Membros", href: communityUrl(communityId, "members") },
          ]
        : [],
});

interface Ban {
    user_id: string;
    username: string;
    display_name: string | null;
    reason: string | null;
    expires_at: string | null;
    created_at: string;
    banned_by_username: string | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

const statusEl = $("modStatus");
const bansList = $("bansList");

function setStatus(message: string): void {
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.hidden = false;
    }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// ===========================================================================
// Banidos
// ===========================================================================

async function loadBans(): Promise<void> {
    if (!communityId || !bansList) return;
    try {
        const { data } = await api<{ data: Ban[] }>(`/communities/${encodeURIComponent(communityId)}/bans`);
        if (data.length === 0) {
            bansList.replaceChildren(el("li", "tf-feed-status", "Ninguém banido no momento."));
            return;
        }
        bansList.replaceChildren(
            ...data.map((ban) => {
                const name = ban.display_name?.trim() || ban.username;
                const item = el("li", "mod-ban");
                item.dataset.userId = ban.user_id;
                item.dataset.name = name;

                const info = el("div", "mod-ban-info");
                const link = el("a", "mod-ban-name", name);
                link.href = profileUrl(ban.user_id);
                const meta = [`@${ban.username}`, banUntil(ban.expires_at)];
                if (ban.banned_by_username) meta.push(`por @${ban.banned_by_username}`);
                info.append(link, el("span", "mod-ban-meta", meta.join(" · ")));
                if (ban.reason) info.append(el("span", "mod-ban-reason", ban.reason));

                const unban = el("button", "report-btn", "Desbanir");
                unban.type = "button";
                unban.dataset.action = "unban";
                item.append(info, unban);
                return item;
            }),
        );
    } catch (err) {
        bansList.replaceChildren(
            el("li", "tf-feed-status error", err instanceof Error ? err.message : "Não foi possível carregar."),
        );
    }
}

bansList?.addEventListener("click", async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-action="unban"]');
    const item = button?.closest<HTMLElement>(".mod-ban");
    if (!button || !item?.dataset.userId || !communityId) return;

    const ok = await confirmDialog({
        title: `Desbanir ${item.dataset.name}?`,
        message: "A pessoa poderá entrar de novo na comunidade, se quiser. Ela não volta automaticamente para os membros.",
        confirmLabel: "Desbanir",
    });
    if (!ok) return;

    button.disabled = true;
    try {
        await api(
            `/communities/${encodeURIComponent(communityId)}/bans/${encodeURIComponent(item.dataset.userId)}`,
            { method: "DELETE" },
        );
        toast(`${item.dataset.name} foi desbanido.`);
        await loadBans();
    } catch (err) {
        toast(err instanceof Error ? err.message : "Não foi possível desbanir.", "error");
        button.disabled = false;
    }
});

// ===========================================================================
// Início
// ===========================================================================

async function init(): Promise<void> {
    if (!communityId) {
        setStatus("Nenhuma comunidade informada.");
        return;
    }

    let community: { name: string; my_role: CommunityRole | null };
    try {
        ({ community } = await api<{ community: { name: string; my_role: CommunityRole | null } }>(
            `/communities/${encodeURIComponent(communityId)}`,
        ));
    } catch (err) {
        setStatus(err instanceof Error ? err.message : "Comunidade não encontrada.");
        return;
    }

    const back = $<HTMLAnchorElement>("backToCommunity");
    if (back) {
        back.href = communityUrl(communityId);
        back.textContent = community.name;
    }
    const title = $("modTitle");
    if (title) title.textContent = `Moderação · ${community.name}`;
    document.title = `FAMAX - Moderação · ${community.name}`;

    if (!isStaff(community.my_role)) {
        setStatus("Esta página é só para o dono e os moderadores da comunidade.");
        return;
    }

    if (statusEl) statusEl.hidden = true;
    const content = $("modContent");
    if (content) content.hidden = false;

    const queueRoot = $("reportQueue");
    if (queueRoot) {
        const queue = createReportQueue(queueRoot, {
            endpoint: `/communities/${encodeURIComponent(communityId)}/reports`,
            viewerRole: community.my_role!,
            onBan: () => void loadBans(),
        });
        void queue.reload();
    }
    void loadBans();
}

void init();
