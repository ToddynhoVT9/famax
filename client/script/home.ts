/**
 * FAMAX — Home Page Script
 *
 * Duas abas (com sessão): "Comunidades" e "Seguindo" (?tab=following).
 *
 * Comunidades: o feed de GET /api/communities, agrupado por categoria, com
 * chips para filtrar uma categoria só (?categoryId=, refletido na URL). Cada
 * card mostra a capa — ou um gradiente com a inicial —, membros e o começo
 * da descrição.
 *
 * Seguindo: posts recentes de quem o usuário segue (GET /api/feed/following),
 * desenhados por shared/post-thread.ts como no feed da comunidade.
 */
import { api, getToken } from "./shared/api.js";
import { initLayout } from "./shared/layout.js";
import { communityUrl, pages } from "./shared/pages.js";
import { avatarColor, escapeHtml, truncate } from "./shared/dom.js";
import { toast } from "./shared/dialog.js";
import { createPostThread, type Post } from "./shared/post-thread.js";
import { emptyState, skeleton } from "./shared/skeleton.js";
import type { Category, CommunityCard } from "../../shared/api-types.js";

initLayout();

const feed = document.getElementById("homeFeed");
const chipsEl = document.getElementById("homeChips");

let categoryFilter = new URLSearchParams(window.location.search).get("categoryId");
let feedSeq = 0;

function renderCard(community: CommunityCard): string {
    const href = escapeHtml(communityUrl(community.communityId));
    const members = `${community.membersCount} ${community.membersCount === 1 ? "membro" : "membros"}`;
    const description = community.description
        ? `<span class="card-description">${escapeHtml(truncate(community.description, 90))}</span>`
        : "";

    // A capa entra como background-image porque .card já define tamanho e
    // cantos. Sem capa: gradiente na cor estável da comunidade + a inicial.
    const cover = community.coverImageUrl
        ? `<div class="card-cover" style="background-image:url('${escapeHtml(community.coverImageUrl)}')"></div>`
        : `<div class="card-cover card-cover--placeholder ${avatarColor(community.communityId)}">
               <span class="card-initial" aria-hidden="true">${escapeHtml(community.name.trim().charAt(0).toUpperCase())}</span>
           </div>`;

    return `
        <a href="${href}" class="card">
            ${cover}
            <div class="card-footer">
                <span class="card-name">${escapeHtml(community.name)}</span>
                <span class="card-members">${escapeHtml(members)}</span>
                ${description}
            </div>
        </a>
    `;
}

function showStatus(message: string, isError = false): void {
    if (!feed) return;
    feed.innerHTML = `<div class="feed-status${isError ? " error" : ""}"></div>`;
    const el = feed.querySelector(".feed-status");
    if (el) el.textContent = message;
}

function syncUrl(): void {
    const url = new URL(window.location.href);
    if (categoryFilter && tab === "communities") url.searchParams.set("categoryId", categoryFilter);
    else url.searchParams.delete("categoryId");
    if (tab === "following") url.searchParams.set("tab", "following");
    else url.searchParams.delete("tab");
    history.replaceState(null, "", url);
}

async function loadFeed(): Promise<void> {
    if (!feed) return;
    const seq = ++feedSeq;
    feed.replaceChildren(skeleton("card", 6, "Carregando comunidades..."));

    try {
        const params = new URLSearchParams({ limit: "50" });
        if (categoryFilter) params.set("categoryId", categoryFilter);
        const { data } = await api.communities.list({ limit: 50, categoryId: categoryFilter });
        if (seq !== feedSeq) return;

        if (data.length === 0) {
            feed.replaceChildren(
                emptyState(
                    categoryFilter
                        ? "Nenhuma comunidade nesta categoria ainda."
                        : "Nenhuma comunidade ainda.",
                    "Que tal começar uma?",
                    { label: "Criar comunidade", href: pages.newCommunity },
                ),
            );
            return;
        }

        // Agrupa preservando a ordem de chegada das categorias.
        const groups = new Map<string, CommunityCard[]>();
        for (const community of data) {
            const key = community.categoryName ?? "Outros";
            const list = groups.get(key);
            if (list) list.push(community);
            else groups.set(key, [community]);
        }

        feed.innerHTML = Array.from(groups.entries())
            .map(
                ([categoryName, communities]) => `
                    <section class="category-section">
                        <h2 class="category-title">${escapeHtml(categoryName)}</h2>
                        <div class="cards-container">
                            ${communities.map(renderCard).join("")}
                        </div>
                    </section>
                `,
            )
            .join("");
    } catch (err) {
        if (seq !== feedSeq) return;
        showStatus(
            err instanceof Error
                ? `Não foi possível carregar as comunidades: ${err.message}`
                : "Não foi possível carregar as comunidades.",
            true,
        );
    }
}

function renderChips(categories: Category[]): void {
    if (!chipsEl) return;
    const chip = (label: string, value: string | null): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "home-chip";
        button.textContent = label;
        button.dataset.categoryId = value ?? "";
        button.setAttribute("aria-pressed", String(categoryFilter === value));
        return button;
    };
    chipsEl.replaceChildren(
        chip("Todas", null),
        ...categories.map((c) => chip(c.name, c.categoryId)),
    );
}

async function loadCategories(): Promise<void> {
    try {
        const { data } = await api.categories.list();
        renderChips(data);
    } catch {
        // Sem chips a home continua funcionando, só sem o filtro.
        if (chipsEl) chipsEl.hidden = true;
    }
}

chipsEl?.addEventListener("click", (event) => {
    const chip = (event.target as Element).closest<HTMLButtonElement>(".home-chip");
    if (!chip) return;
    categoryFilter = chip.dataset.categoryId || null;
    chipsEl.querySelectorAll<HTMLButtonElement>(".home-chip").forEach((c) =>
        c.setAttribute("aria-pressed", String(c === chip)),
    );
    syncUrl();
    void loadFeed();
});

// ===========================================================================
// Aba "Seguindo"
// ===========================================================================

type HomeTab = "communities" | "following";

const tabsEl = document.getElementById("homeTabs");
const communitiesPanel = document.getElementById("homeCommunities");
const followingPanel = document.getElementById("homeFollowing");
const followingList = document.getElementById("followingList");
const followingMore = document.getElementById("followingMore") as HTMLButtonElement | null;
const FOLLOWING_PER_PAGE = 10;

const loggedIn = Boolean(getToken());
let tab: HomeTab =
    loggedIn && new URLSearchParams(window.location.search).get("tab") === "following" ? "following" : "communities";
let followingPage = 0;
let followingLoaded = false;

const followingThread = followingList ? createPostThread(followingList, { showCommunity: true }) : null;

function followingStatus(message: string, isError = false): void {
    if (!followingList) return;
    followingList.innerHTML = `<div class="tf-feed-status${isError ? " error" : ""}"></div>`;
    const el = followingList.querySelector(".tf-feed-status");
    if (el) el.textContent = message;
}

async function loadFollowing(reset: boolean): Promise<void> {
    if (!followingList || !followingMore || !followingThread) return;
    if (reset) {
        followingPage = 0;
        followingThread.clear();
        followingList.replaceChildren(skeleton("post", 3, "Carregando posts de quem você segue..."));
        followingMore.hidden = true;
    }
    followingMore.disabled = true;
    try {
        const result = await api.feed.following({ page: followingPage + 1, limit: FOLLOWING_PER_PAGE });
        followingPage += 1;
        if (reset) followingList.innerHTML = "";
        followingThread.add(result.data);
        if (followingThread.posts.size === 0) {
            followingList.replaceChildren(
                emptyState(
                    "Nada por aqui ainda.",
                    "Siga pessoas pelo perfil delas para ver aqui o que elas publicam. Comece pelas comunidades.",
                    { label: "Explorar comunidades", href: pages.home },
                ),
            );
        }
        followingMore.hidden = followingPage >= result.pagination.totalPages;
        followingLoaded = true;
    } catch (err) {
        const message = err instanceof Error ? err.message : "erro";
        if (reset) followingStatus(`Não foi possível carregar: ${message}`, true);
        else toast(message, "error");
    } finally {
        followingMore.disabled = false;
    }
}

function renderHomeTabs(): void {
    tabsEl?.querySelectorAll<HTMLButtonElement>(".home-tab").forEach((button) => {
        const active = button.dataset.tab === tab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
    });
    if (communitiesPanel) communitiesPanel.hidden = tab !== "communities";
    if (followingPanel) followingPanel.hidden = tab !== "following";
}

function selectHomeTab(next: HomeTab): void {
    tab = next;
    renderHomeTabs();
    syncUrl();
    if (tab === "following" && !followingLoaded) void loadFollowing(true);
}

tabsEl?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".home-tab");
    const next = button?.dataset.tab as HomeTab | undefined;
    if (next && next !== tab) selectHomeTab(next);
});

tabsEl?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: HomeTab = tab === "communities" ? "following" : "communities";
    selectHomeTab(next);
    tabsEl.querySelector<HTMLButtonElement>(`.home-tab[data-tab="${next}"]`)?.focus();
});

followingMore?.addEventListener("click", () => void loadFollowing(false));

// Visitante não segue ninguém: sem abas, só as comunidades.
if (tabsEl) tabsEl.hidden = !loggedIn;
renderHomeTabs();
if (tab === "following") void loadFollowing(true);

void loadCategories();
void loadFeed();

export {};
