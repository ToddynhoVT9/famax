/**
 * FAMAX — Página da comunidade
 *
 * Topo (capa, descrição, participar/sair/editar), abas Conversas / Ajudar os
 * outros / Categorias com o estado na URL e posts paginados com "carregar
 * mais". Os links Regras, Membros e Eventos da sidebar trocam de vista sem
 * recarregar (?view=rules|members|events); as vistas de membros e de eventos
 * ficam em community-members.ts e community-events.ts. O desenho dos posts, os comentários em árvore e as ações sobre eles
 * ficam em shared/post-thread.ts (a página do post usa o mesmo módulo); o
 * modal de criar/editar, em shared/post-editor.ts.
 */
import { api, getToken } from "./shared/api.js";
import { goToLogin } from "./shared/auth-guard.js";
import { initLayout, refreshMyCommunities, setCurrentPageLink } from "./shared/layout.js";
import {
    communityEditUrl,
    communityUrl,
    moderationUrl,
    pages,
    type CommunityView,
} from "./shared/pages.js";
import { avatarColor, queryParam } from "./shared/dom.js";
import { confirmDialog, toast } from "./shared/dialog.js";
import { createPostThread, type Post } from "./shared/post-thread.js";
import { openPostEditor, type PostCategory } from "./shared/post-editor.js";
import { emptyState, skeleton } from "./shared/skeleton.js";
import { banUntil, isStaff } from "./shared/moderation.js";
import { createMembersView } from "./community-members.js";
import { createLeaderboard } from "./community-leaderboard.js";
import { createEventsView, loadUpcomingWidget } from "./community-events.js";

interface Community {
    community_id: string;
    name: string;
    description: string | null;
    rules: string | null;
    cover_image_url: string | null;
    owner_id: string;
    category_name: string | null;
    members_count: number;
    my_role: "owner" | "moderator" | "member" | null;
    is_banned: boolean;
    my_ban_expires_at: string | null;
    /** Comunidade +18, e se quem vê não pode ver. */
    is_nsfw: boolean;
    nsfw_blocked: boolean;
}

type Tab = "all" | "unanswered" | "categories";
type Sort = "new" | "hot" | "top" | "comments";
const SORTS: Sort[] = ["new", "hot", "top", "comments"];
type View = "discussions" | CommunityView;

const POSTS_PER_PAGE = 10;

// ===========================================================================
// Estado
// ===========================================================================

const communityId = queryParam("id");

let community: Community | null = null;
let categories: PostCategory[] = [];

let view: View = "discussions";
let tab: Tab = "all";
let categoryFilter: string | null = null;
let sort: Sort = "new";
let page = 0;
let totalPages = 0;
// Descarta respostas de uma aba/filtro que o usuário já deixou para trás.
let feedSeq = 0;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

const postsList = $("tfPostsList");
const loadMoreBtn = $<HTMLButtonElement>("tfLoadMore");
const chipsEl = $("tfCategoryChips");
const tabHint = $("tfTabHint");
const sortSelect = $<HTMLSelectElement>("tfSort");

/** Link da sidebar que troca de vista sem recarregar (o href abre em nova aba). */
const viewLink = (label: string, target: View) => ({
    label,
    key: target,
    href: communityUrl(communityId!, target === "discussions" ? undefined : target),
    onClick: (event: MouseEvent) => {
        event.preventDefault();
        // "Discussões" também volta para a aba Conversas.
        if (target === "discussions" && view === "discussions") selectTab("all");
        showView(target);
        $("main-content")?.scrollIntoView({ behavior: "smooth" });
    },
});

initLayout({
    pageLinks: communityId
        ? [
              viewLink("Discussões", "discussions"),
              viewLink("Regras", "rules"),
              viewLink("Membros", "members"),
              viewLink("Eventos", "events"),
              // Ainda sem página própria: desativado com "Em breve".
              { label: "Suporte" },
          ]
        : [],
});

const thread = postsList
    ? createPostThread(postsList, {
          onEditPost: (post) => void editPost(post),
          onPostDeleted: () => {
              if (thread?.posts.size === 0) showEmptyFeed();
          },
      })
    : null;

// ===========================================================================
// Utilidades
// ===========================================================================

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

/** Exige sessão; sem ela manda para o login e devolve false. */
function ensureLoggedIn(): boolean {
    if (getToken()) return true;
    goToLogin();
    return false;
}

// ===========================================================================
// Topo da comunidade
// ===========================================================================

function renderHero(): void {
    if (!community) return;
    const c = community;

    document.title = `FAMAX - ${c.name}`;
    const name = $("communityName");
    if (name) name.textContent = c.name;

    const meta = $("communityMeta");
    if (meta) {
        meta.textContent = [
            c.is_nsfw ? "+18" : null,
            c.category_name,
            `${c.members_count} ${c.members_count === 1 ? "membro" : "membros"}`,
        ]
            .filter(Boolean)
            .join(" • ");
    }

    const description = $("communityDescription");
    if (description) {
        description.textContent = c.description ?? "";
        description.hidden = !c.description;
    }

    // Capa ou, sem ela, a inicial na cor estável da comunidade.
    const banner = $("communityBanner");
    const initial = $("communityInitial");
    if (banner) {
        banner.className = "tf-community-banner";
        if (c.cover_image_url) {
            banner.style.backgroundImage = `url(${JSON.stringify(c.cover_image_url)})`;
            banner.classList.add("has-image");
            if (initial) initial.textContent = "";
        } else {
            banner.style.backgroundImage = "";
            banner.classList.add(avatarColor(c.community_id));
            if (initial) initial.textContent = c.name.trim().charAt(0).toUpperCase();
        }
    }

    renderNsfwBanner(c);
    renderActions();
    renderRules();
    $("communityHero")?.removeAttribute("aria-busy");
}

/** Comunidade +18 vista por quem não pode ver: aviso no topo das discussões. */
function renderNsfwBanner(c: Community): void {
    document.getElementById("nsfwBanner")?.remove();
    // Sem acesso não há como publicar: o "Compartilhe-os" levaria a um 403.
    const greeting = $("btnCreatePost")?.closest<HTMLElement>(".tf-widget");
    if (greeting) greeting.hidden = c.nsfw_blocked;
    if (!c.nsfw_blocked) return;
    const banner = document.createElement("p");
    banner.id = "nsfwBanner";
    banner.className = "tf-nsfw-banner";
    banner.append("Esta comunidade é para maiores de 18. Para ver as discussões e participar, ative “Conteúdo adulto” nas ");
    const link = document.createElement("a");
    link.href = pages.settings;
    link.textContent = "configurações";
    banner.append(link, " (exige 18 anos pela data de nascimento).");
    $("viewDiscussions")?.prepend(banner);
}

function renderActions(): void {
    const actions = $("communityActions");
    if (!actions || !community) return;
    actions.replaceChildren();

    const button = (label: string, className = "tf-btn-join"): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = className;
        b.textContent = label;
        return b;
    };

    // Dono e moderadores: atalho para a fila de denúncias.
    if (isStaff(community.my_role)) {
        const moderation = document.createElement("a");
        moderation.className = "tf-btn-join tf-btn-secondary";
        moderation.href = moderationUrl(community.community_id);
        moderation.textContent = "Moderação";
        actions.append(moderation);
    }

    // Dono: editar (sair não existe para ele — ver leave no backend).
    if (community.my_role === "owner") {
        const badge = document.createElement("span");
        badge.className = "tf-owner-badge";
        badge.textContent = "Você é o dono";
        const edit = document.createElement("a");
        edit.className = "tf-btn-join";
        edit.href = communityEditUrl(community.community_id);
        edit.textContent = "Editar comunidade";
        actions.prepend(badge);
        actions.append(edit);
        return;
    }

    // Banido: no lugar do "Participar", o aviso com o prazo.
    if (community.is_banned) {
        const banned = document.createElement("span");
        banned.className = "tf-banned-badge";
        banned.textContent = `Você está banido desta comunidade (${banUntil(community.my_ban_expires_at)})`;
        actions.append(banned);
        return;
    }

    // Membro: "Participando ✓" abre um menu com "Sair".
    if (community.my_role) {
        const wrapper = document.createElement("div");
        wrapper.className = "tf-member-menu";
        const toggle = button("Participando ✓", "tf-btn-join tf-btn-joined");
        toggle.setAttribute("aria-haspopup", "menu");
        toggle.setAttribute("aria-expanded", "false");
        const menu = document.createElement("div");
        menu.className = "tf-menu-list";
        menu.setAttribute("role", "menu");
        menu.hidden = true;
        const leave = button("Sair da comunidade", "tf-menu-item tf-menu-item--danger");
        leave.setAttribute("role", "menuitem");
        menu.append(leave);
        wrapper.append(toggle, menu);
        actions.append(wrapper);

        toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            menu.hidden = !menu.hidden;
            toggle.setAttribute("aria-expanded", String(!menu.hidden));
        });
        document.addEventListener("click", (event) => {
            if (!wrapper.contains(event.target as Node)) {
                menu.hidden = true;
                toggle.setAttribute("aria-expanded", "false");
            }
        });
        leave.addEventListener("click", () => void leaveCommunity());
        return;
    }

    // +18 sem conteúdo adulto liberado: não há como entrar (a API recusa).
    if (community.nsfw_blocked && getToken()) return;

    // Visitante ou não-membro: participar (visitante vai ao login).
    const join = button("Participar");
    join.addEventListener("click", () => void joinCommunity(join));
    actions.append(join);
}

async function loadCommunity(): Promise<void> {
    if (!communityId) return;
    try {
        const result = await api<{ community: Community; categories: PostCategory[] }>(
            `/communities/${encodeURIComponent(communityId)}`,
        );
        community = result.community;
        categories = result.categories;
        renderHero();
        renderChips();
        if (view === "events") void eventsView?.reload();
    } catch (err) {
        const name = $("communityName");
        if (name) name.textContent = errorMessage(err, "Comunidade não encontrada");
        $("communityHero")?.removeAttribute("aria-busy");
    }
}

async function joinCommunity(button?: HTMLButtonElement): Promise<boolean> {
    if (!communityId || !ensureLoggedIn()) return false;
    if (button) button.disabled = true;
    try {
        await api(`/communities/${encodeURIComponent(communityId)}/join`, { method: "POST" });
        await loadCommunity(); // atualiza papel e contagem de membros
        void refreshMyCommunities();
        toast("Agora você participa desta comunidade.");
        return true;
    } catch (err) {
        toast(errorMessage(err, "Não foi possível participar."), "error");
        if (button) button.disabled = false;
        return false;
    }
}

async function leaveCommunity(): Promise<void> {
    if (!communityId || !community) return;
    const ok = await confirmDialog({
        title: "Sair da comunidade?",
        message: `Você deixará de participar de "${community.name}". Seus posts e comentários continuam publicados.`,
        confirmLabel: "Sair",
        danger: true,
    });
    if (!ok) return;

    try {
        await api(`/communities/${encodeURIComponent(communityId)}/leave`, { method: "POST" });
        await loadCommunity();
        void refreshMyCommunities();
        toast("Você saiu da comunidade.");
    } catch (err) {
        toast(errorMessage(err, "Não foi possível sair da comunidade."), "error");
    }
}

// ===========================================================================
// Abas, categorias e URL
// ===========================================================================

const TAB_HINTS: Record<Tab, string | null> = {
    all: null,
    unanswered: "Perguntas que ainda não têm uma resposta aceita pelo autor. Que tal ajudar?",
    categories: "Escolha uma categoria para ver só as discussões dela.",
};

/** Reflete aba, categoria e ordenação na URL, para recarregar ou compartilhar. */
function syncUrl(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    url.searchParams.delete("categoryId");
    url.searchParams.delete("view");
    url.searchParams.delete("sort");
    if (view !== "discussions") {
        url.searchParams.set("view", view);
    } else {
        if (tab !== "all") url.searchParams.set("tab", tab);
        if (tab === "categories" && categoryFilter) url.searchParams.set("categoryId", categoryFilter);
        if (sort !== "new") url.searchParams.set("sort", sort);
    }
    history.replaceState(null, "", url);
}

sortSelect?.addEventListener("change", () => {
    sort = SORTS.includes(sortSelect.value as Sort) ? (sortSelect.value as Sort) : "new";
    syncUrl();
    void loadPosts(true);
});

function renderTabs(): void {
    document.querySelectorAll<HTMLButtonElement>(".tf-tab").forEach((button) => {
        const active = button.dataset.tab === tab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        if (active) $("tfFeedPanel")?.setAttribute("aria-labelledby", button.id);
    });
    if (tabHint) {
        tabHint.textContent = TAB_HINTS[tab] ?? "";
        tabHint.hidden = !TAB_HINTS[tab];
    }
    if (chipsEl) chipsEl.hidden = tab !== "categories";
    updateIndicator();
}

function renderChips(): void {
    if (!chipsEl) return;
    const chip = (label: string, value: string | null): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tf-chip";
        b.textContent = label;
        b.dataset.categoryId = value ?? "";
        b.setAttribute("aria-pressed", String(categoryFilter === value));
        return b;
    };
    chipsEl.replaceChildren(
        chip("Todas", null),
        ...categories.map((c) => chip(c.name, c.community_category_id)),
    );
}

function selectTab(next: Tab, nextCategory: string | null = null): void {
    tab = next;
    categoryFilter = next === "categories" ? nextCategory : null;
    renderTabs();
    renderChips();
    syncUrl();
    void loadPosts(true);
}

document.querySelectorAll<HTMLButtonElement>(".tf-tab").forEach((button) => {
    button.addEventListener("click", () => {
        const next = button.dataset.tab as Tab;
        if (next !== tab) selectTab(next);
    });
});

// Teclado no padrão de tablist: setas, Home e End mudam de aba.
$("tfTabsContainer")?.addEventListener("keydown", (event) => {
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tf-tab"));
    const index = tabs.findIndex((t) => t.dataset.tab === tab);
    let target = -1;
    if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = tabs.length - 1;
    if (target < 0) return;
    event.preventDefault();
    tabs[target].focus();
    selectTab(tabs[target].dataset.tab as Tab);
});

chipsEl?.addEventListener("click", (event) => {
    const chip = (event.target as Element).closest<HTMLButtonElement>(".tf-chip");
    if (!chip) return;
    selectTab("categories", chip.dataset.categoryId || null);
});

function updateIndicator(): void {
    const activeTab = document.querySelector<HTMLElement>(".tf-tab.active");
    const indicator = $("tfTabIndicator");
    const container = $("tfTabsContainer");
    if (activeTab && indicator && container) {
        const containerRect = container.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();
        indicator.style.width = `${tabRect.width}px`;
        indicator.style.transform = `translateX(${tabRect.left - containerRect.left}px)`;
    }
}

window.addEventListener("load", () => setTimeout(updateIndicator, 50));
window.addEventListener("resize", updateIndicator);

// ===========================================================================
// Vistas: Discussões, Regras, Membros
// ===========================================================================

const VIEW_IDS: Record<View, string> = {
    discussions: "viewDiscussions",
    rules: "viewRules",
    members: "viewMembers",
    events: "viewEvents",
};

const membersRoot = $("membersRoot");
const membersView =
    communityId && membersRoot
        ? createMembersView(membersRoot, {
              communityId,
              viewerRole: () => community?.my_role ?? null,
              communityName: () => community?.name ?? "",
              onCommunityChanged: loadCommunity,
          })
        : null;

const upcomingWidget = $("upcomingWidget");
const refreshUpcoming = (): void => {
    if (communityId && upcomingWidget) void loadUpcomingWidget(upcomingWidget, communityId);
};

const eventsRoot = $("eventsRoot");
const eventsView =
    communityId && eventsRoot
        ? createEventsView(eventsRoot, {
              communityId,
              viewerRole: () => community?.my_role ?? null,
              onChanged: refreshUpcoming,
          })
        : null;
let eventsLoaded = false;

// Os links do widget levam à vista de eventos sem recarregar a página.
upcomingWidget?.addEventListener("click", (event) => {
    const link = (event.target as Element).closest("a");
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    showView("events");
    $("main-content")?.scrollIntoView({ behavior: "smooth" });
});

function renderRules(): void {
    const text = $("rulesText");
    const edit = $<HTMLAnchorElement>("rulesEdit");
    if (!text || !community) return;
    // textContent + white-space: pre-wrap no CSS: quebras de linha sem HTML.
    text.textContent = community.rules?.trim() || "Esta comunidade ainda não tem regras escritas.";
    text.classList.toggle("is-empty", !community.rules?.trim());
    if (edit) {
        edit.hidden = community.my_role !== "owner";
        edit.href = communityEditUrl(community.community_id);
    }
}

function showView(next: View): void {
    const changed = next !== view;
    view = next;
    for (const [key, id] of Object.entries(VIEW_IDS)) {
        const section = $(id);
        if (section) section.hidden = key !== view;
    }
    setCurrentPageLink(view);
    syncUrl();
    if (view === "members" && (changed || membersRoot?.childElementCount === 0)) {
        void membersView?.reload();
    }
    // O papel (quem cria eventos) chega com a comunidade; a vista recarrega
    // quando ela chega também (ver loadCommunity).
    if (view === "events" && (changed || !eventsLoaded)) {
        eventsLoaded = true;
        void eventsView?.reload();
    }
    if (view === "discussions") updateIndicator();
}

// ===========================================================================
// Posts
// ===========================================================================

function showFeedStatus(message: string, isError = false): void {
    if (!postsList) return;
    postsList.innerHTML = `<div class="tf-feed-status${isError ? " error" : ""}"></div>`;
    const el = postsList.querySelector(".tf-feed-status");
    if (el) el.textContent = message;
}

function emptyMessage(): string {
    if (tab === "unanswered") return "Todas as perguntas já têm uma resposta aceita. 🎉";
    if (tab === "categories" && categoryFilter) return "Nenhuma discussão nesta categoria ainda.";
    return "Nenhuma discussão ainda. Seja o primeiro a publicar!";
}

/** Lista vazia com o atalho para publicar (menos na aba "Ajudar os outros"). */
function showEmptyFeed(): void {
    if (!postsList) return;
    const action =
        tab === "unanswered"
            ? undefined
            : { label: "Criar discussão", onClick: () => $("btnCreatePost")?.click() };
    postsList.replaceChildren(emptyState(emptyMessage(), undefined, action));
}

async function loadPosts(reset: boolean): Promise<void> {
    if (!communityId || !postsList || !loadMoreBtn || !thread) return;

    const seq = ++feedSeq;
    if (reset) {
        page = 0;
        totalPages = 0;
        thread.clear();
        postsList.replaceChildren(skeleton("post", 3, "Carregando discussões..."));
        loadMoreBtn.hidden = true;
    }
    loadMoreBtn.disabled = true;

    const params = new URLSearchParams({ page: String(page + 1), limit: String(POSTS_PER_PAGE), sort });
    if (tab === "unanswered") params.set("unanswered", "true");
    if (tab === "categories" && categoryFilter) params.set("categoryId", categoryFilter);

    try {
        const result = await api<{ data: Post[]; pagination: { totalPages: number } }>(
            `/communities/${encodeURIComponent(communityId)}/posts?${params}`,
        );
        if (seq !== feedSeq) return;

        page += 1;
        totalPages = result.pagination.totalPages;

        if (reset) postsList.innerHTML = "";
        thread.add(result.data);

        if (thread.posts.size === 0) showEmptyFeed();
        loadMoreBtn.hidden = page >= totalPages;
    } catch (err) {
        if (seq !== feedSeq) return;
        if (reset) {
            showFeedStatus(`Não foi possível carregar as discussões: ${errorMessage(err, "erro")}`, true);
        } else {
            toast(errorMessage(err, "Não foi possível carregar mais."), "error");
        }
    } finally {
        if (seq === feedSeq) loadMoreBtn.disabled = false;
    }
}

loadMoreBtn?.addEventListener("click", () => void loadPosts(false));

// ===========================================================================
// Criar e editar post
// ===========================================================================

/** O post novo aparece na lista atual se ela o incluiria. */
function matchesCurrentFilter(post: Post): boolean {
    if (tab === "categories" && categoryFilter) return post.community_category_id === categoryFilter;
    return true; // "Conversas" e "Ajudar os outros" (post novo tem 0 respostas)
}

async function editPost(post: Post): Promise<void> {
    if (!communityId || !thread) return;
    const saved = await openPostEditor({ communityId, categories, post });
    if (saved) {
        thread.replace(saved);
        toast("Discussão atualizada.");
    }
}

$("btnCreatePost")?.addEventListener("click", async () => {
    if (!communityId || !thread || !postsList || !ensureLoggedIn()) return;
    if (!community?.my_role) {
        // Só membros publicam: oferece entrar em vez de deixar o erro 403.
        const ok = await confirmDialog({
            title: "Participar para publicar?",
            message: "Só quem participa da comunidade pode criar discussões.",
            confirmLabel: "Participar",
        });
        if (!ok || !(await joinCommunity())) return;
    }

    const post = await openPostEditor({ communityId, categories });
    if (post && matchesCurrentFilter(post)) {
        if (thread.posts.size === 0) postsList.innerHTML = "";
        thread.add([post], "prepend");
    }
});

// ===========================================================================
// Início
// ===========================================================================

function readUrlState(): void {
    const params = new URLSearchParams(window.location.search);
    const urlView = params.get("view");
    if (urlView === "rules" || urlView === "members" || urlView === "events") view = urlView;
    const urlSort = params.get("sort") as Sort | null;
    if (urlSort && SORTS.includes(urlSort)) sort = urlSort;
    if (sortSelect) sortSelect.value = sort;
    const urlCategory = params.get("categoryId");
    const urlTab = params.get("tab");
    if (urlCategory || urlTab === "categories") {
        tab = "categories";
        categoryFilter = urlCategory;
    } else if (urlTab === "unanswered") {
        tab = "unanswered";
    }
}

if (!communityId) {
    showFeedStatus("Nenhuma comunidade selecionada. Volte para a home e escolha uma.", true);
    const name = $("communityName");
    if (name) name.textContent = "Comunidade";
} else {
    readUrlState();
    renderTabs();
    showView(view);
    void loadCommunity();
    void loadPosts(true);
    const leaderboardWidget = $("leaderboardWidget");
    if (leaderboardWidget) createLeaderboard(leaderboardWidget, communityId);
    refreshUpcoming();
}

export {};
