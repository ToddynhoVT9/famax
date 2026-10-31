/**
 * FAMAX — Moderação da comunidade (community/moderation.html?id=)
 *
 * Fila de denúncias de posts e comentários (shared/report-queue.ts) e a lista
 * de banidos, com "desbanir", em duas abas (a aberta vai para a URL:
 * ?tab=banidos). Só dono e moderadores: os outros veem o aviso — e o backend
 * responde 403 de qualquer forma.
 */
import { api } from "./shared/api.js";
import { requireLogin } from "./shared/auth-guard.js";
import { initLayout } from "./shared/layout.js";
import { communityUrl, profileUrl } from "./shared/pages.js";
import { queryParam } from "./shared/dom.js";
import { confirmDialog, toast } from "./shared/dialog.js";
import { banUntil, isStaff, type CommunityRole } from "./shared/moderation.js";
import { createReportQueue } from "./shared/report-queue.js";
import { bindTabKeys } from "./shared/tabs.js";
import type { CommunityBan as Ban } from "../../shared/api-types.js";

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

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

const statusEl = $("modStatus");
const bansList = $("bansList");
const bansSummary = $("bansSummary");

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
        const { data } = await api.communities.bans(communityId);
        if (bansSummary) {
            bansSummary.textContent = `${data.length} ${data.length === 1 ? "pessoa banida" : "pessoas banidas"}`;
        }
        if (data.length === 0) {
            bansList.replaceChildren(el("li", "tf-feed-status", "Ninguém banido no momento."));
            return;
        }
        bansList.replaceChildren(
            ...data.map((ban) => {
                const name = ban.displayName?.trim() || ban.username;
                const item = el("li", "fx-member");
                item.dataset.userId = ban.userId;
                item.dataset.name = name;

                const info = el("div", "fx-member-info");
                const link = el("a", "fx-member-name", name);
                link.href = profileUrl(ban.userId);
                const meta = [`@${ban.username}`, banUntil(ban.expiresAt)];
                if (ban.bannedByUsername) meta.push(`por @${ban.bannedByUsername}`);
                info.append(link, el("span", "fx-member-meta", meta.join(" · ")));
                if (ban.reason) info.append(el("span", "mod-ban-reason", ban.reason));

                const unban = el("button", "fx-btn fx-btn--sm fx-btn--pill fx-btn--outline-ink", "Desbanir");
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
    const item = button?.closest<HTMLElement>("[data-user-id]");
    if (!button || !item?.dataset.userId || !communityId) return;

    const ok = await confirmDialog({
        title: `Desbanir ${item.dataset.name}?`,
        message: "A pessoa poderá entrar de novo na comunidade, se quiser. Ela não volta automaticamente para os membros.",
        confirmLabel: "Desbanir",
    });
    if (!ok) return;

    button.disabled = true;
    try {
        await api.communities.unban(communityId, item.dataset.userId);
        toast(`${item.dataset.name} foi desbanido.`);
        await loadBans();
    } catch (err) {
        toast(err instanceof Error ? err.message : "Não foi possível desbanir.", "error");
        button.disabled = false;
    }
});

// ===========================================================================
// Abas: Denúncias e Banidos
// ===========================================================================

type ModTab = "denuncias" | "banidos";

function selectTab(tab: ModTab): void {
    document.querySelectorAll<HTMLButtonElement>('#modTabs [role="tab"]').forEach((button) => {
        const active = button.dataset.tab === tab;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        const panel = button.getAttribute("aria-controls");
        if (panel) $(panel)?.toggleAttribute("hidden", !active);
    });
    // A aba fica na URL: o link volta ao mesmo lugar.
    const url = new URL(window.location.href);
    if (tab === "banidos") url.searchParams.set("tab", tab);
    else url.searchParams.delete("tab");
    history.replaceState(null, "", url);
}

$("modTabs")?.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    if (tab?.dataset.tab) selectTab(tab.dataset.tab as ModTab);
});
bindTabKeys($("modTabs"));
selectTab(queryParam("tab") === "banidos" ? "banidos" : "denuncias");

// ===========================================================================
// Início
// ===========================================================================

async function init(): Promise<void> {
    if (!communityId) {
        setStatus("Nenhuma comunidade informada.");
        return;
    }

    let community: { name: string; myRole: CommunityRole | null };
    try {
        ({ community } = await api.communities.get(communityId));
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

    if (!isStaff(community.myRole)) {
        setStatus("Esta página é só para o dono e os moderadores da comunidade.");
        return;
    }

    if (statusEl) statusEl.hidden = true;
    const content = $("modContent");
    if (content) content.hidden = false;

    const queueRoot = $("reportQueue");
    if (queueRoot) {
        const queue = createReportQueue(queueRoot, {
            source: { communityId },
            viewerRole: community.myRole!,
            onBan: () => void loadBans(),
        });
        void queue.reload();
    }
    void loadBans();
}

void init();
