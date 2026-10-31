/**
 * FAMAX — Página da comunidade
 *
 * Topo (capa, descrição, participar/sair/editar) e as vistas em abas:
 * Discussões, Regras, Membros e Eventos. A troca de vista não recarrega:
 * vai para a URL (?view=rules|members|events) com pushState, e o Voltar do
 * navegador volta para a vista anterior (popstate). As vistas de membros e
 * de eventos ficam em community-members.ts e community-events.ts.
 *
 * Discussões: os filtros Conversas / Ajudar os outros / Categorias (chips)
 * e a ordenação, com o estado na URL, e os posts paginados com "carregar
 * mais". O desenho dos posts, os comentários em árvore e as ações sobre eles
 * ficam em shared/post-thread.ts (a página do post usa o mesmo módulo); o
 * modal de criar/editar, em shared/post-editor.ts.
 *
 * As ações do topo mudam de lugar com a faixa (community.css): no tablet e
 * no celular entra "Criar post", e a Moderação vai para o ⋯. Quais ações
 * cada papel tem não muda.
 */
import { api, getToken } from "./shared/api.js";
import { goToLogin } from "./shared/auth-guard.js";
import { initLayout, refreshMyCommunities } from "./shared/layout.js";
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
import { bindTabKeys } from "./shared/tabs.js";
import { ICONS } from "./shared/icons.js";
import { createMembersView } from "./community-members.js";
import { createLeaderboard, loadPodium } from "./community-leaderboard.js";
import { createEventsView, loadUpcomingWidget } from "./community-events.js";
import type { Community } from "../../shared/api-types.js";

type Tab = "all" | "unanswered" | "categories";
type Sort = "new" | "hot" | "top" | "comments";
const SORTS: Sort[] = ["new", "hot", "top", "comments"];
type View = "discussions" | CommunityView;
const VIEWS: View[] = ["discussions", "rules", "members", "events"];

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
const feedFilters = $("feedFilters");
const tabHint = $("tfTabHint");
const sortSelect = $<HTMLSelectElement>("tfSort");
const viewTabs = $("communityViews");

// A gaveta fica igual à das outras páginas: as vistas estão nas abas.
initLayout();

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Botão que abre um fx-menu logo abaixo, alinhado à direita ("Participando ✓",
 * o ⋯ do topo). Fecha com clique fora, Esc e ao escolher um item.
 */
function dropdown(toggle: HTMLButtonElement, items: HTMLElement[], className = ""): HTMLDivElement {
    const wrapper = el("div", `cm-menu ${className}`.trim());
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    const menu = el("div", "fx-menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    for (const item of items) item.setAttribute("role", "menuitem");
    menu.append(...items);
    wrapper.append(toggle, menu);

    const setOpen = (open: boolean): void => {
        menu.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(menu.hidden);
        if (!menu.hidden) items[0]?.focus();
    });
    // Captura: antes da ação do item. O foco volta ao botão, e a confirmação
    // que a ação abrir devolve o foco a ele (o item some com o menu).
    menu.addEventListener(
        "click",
        () => {
            setOpen(false);
            toggle.focus();
        },
        true,
    );
    document.addEventListener("click", (event) => {
        if (!wrapper.contains(event.target as Node)) setOpen(false);
    });
    wrapper.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !menu.hidden) {
            event.stopPropagation();
            setOpen(false);
            toggle.focus();
        }
    });
    return wrapper;
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

    // Meta (categoria · membros) e, para o dono, o selo na mesma linha.
    const meta = $("communityMeta");
    if (meta) {
        const text = el(
            "span",
            "",
            [
                c.isNsfw ? "+18" : null,
                c.categoryName,
                `${c.membersCount} ${c.membersCount === 1 ? "membro" : "membros"}`,
            ]
                .filter(Boolean)
                .join(" · "),
        );
        meta.replaceChildren(text);
        if (c.myRole === "owner") meta.append(el("span", "fx-badge fx-badge--owner", "Você é o dono"));
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
        banner.className = "fx-cbanner";
        if (c.coverImageUrl) {
            banner.style.backgroundImage = `url(${JSON.stringify(c.coverImageUrl)})`;
            banner.classList.add("has-image");
            if (initial) initial.textContent = "";
        } else {
            banner.style.backgroundImage = "";
            banner.classList.add(avatarColor(c.communityId));
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
    // Sem acesso não há como publicar: o "Criar post" levaria a um 403.
    const createWidget = $("createWidget");
    if (createWidget) createWidget.hidden = c.nsfwBlocked;
    if (!c.nsfwBlocked) return;
    const banner = el("p", "fx-banner fx-banner--danger");
    banner.id = "nsfwBanner";
    banner.append("Esta comunidade é para maiores de 18. Para ver as discussões e participar, ative “Conteúdo adulto” nas ");
    const link = el("a", "", "configurações");
    link.href = pages.settings;
    banner.append(link, " (exige 18 anos pela data de nascimento).");
    $("viewDiscussions")?.prepend(banner);
}

/**
 * As ações do topo. Cada papel tem as mesmas ações de antes; a faixa decide
 * onde ficam (.cm-wide: desktop e compacto; .cm-narrow: tablet e celular):
 *  - dono: Moderação e Editar comunidade · Criar post, Editar e ⋯ (Moderação);
 *  - moderador: Moderação e Participando ✓ · Criar post, Participando ✓ e ⋯;
 *  - membro: Participando ✓ · Criar post e Participando ✓;
 *  - visitante ou quem não participa: Participar.
 */
function renderActions(): void {
    const actions = $("communityActions");
    if (!actions || !community) return;
    actions.replaceChildren();
    const c = community;

    const button = (label: string, className: string): HTMLButtonElement => {
        const b = el("button", className, label);
        b.type = "button";
        return b;
    };
    const link = (label: string, href: string, className: string): HTMLAnchorElement => {
        const a = el("a", className, label);
        a.href = href;
        return a;
    };

    // Banido: no lugar do "Participar", o aviso com o prazo.
    if (c.isBanned && !c.myRole) {
        actions.append(el("span", "cm-banned", `Você está banido desta comunidade (${banUntil(c.myBanExpiresAt)})`));
        return;
    }

    if (!c.myRole) {
        // +18 sem conteúdo adulto liberado: não há como entrar (a API recusa).
        if (c.nsfwBlocked && getToken()) return;
        // Visitante ou não-membro: participar (visitante vai ao login).
        const join = button("Participar", "fx-btn fx-btn--primary");
        join.addEventListener("click", () => void joinCommunity(join));
        actions.append(join);
        return;
    }

    // Tablet e celular: "Criar post" no topo (o widget da direita não aparece).
    const create = button("Criar post", "fx-btn fx-btn--primary cm-narrow");
    create.insertAdjacentHTML("afterbegin", ICONS.plus);
    create.addEventListener("click", () => void createPost());

    // O ⋯ com a Moderação (tablet e celular), para dono e moderadores.
    const moreMenu = (): HTMLDivElement => {
        const more = button("", "fx-btn fx-btn--outline cm-iconbtn");
        more.innerHTML = ICONS.dots;
        more.setAttribute("aria-label", "Mais opções da comunidade");
        return dropdown(more, [link("Moderação", moderationUrl(c.communityId), "fx-menu-item")], "cm-narrow");
    };

    if (c.myRole === "owner") {
        // Sair não existe para o dono (ver leave no backend).
        actions.append(
            link("Moderação", moderationUrl(c.communityId), "fx-btn fx-btn--outline cm-wide"),
            link("Editar comunidade", communityEditUrl(c.communityId), "fx-btn fx-btn--primary cm-wide"),
            create,
            link("Editar", communityEditUrl(c.communityId), "fx-btn fx-btn--outline cm-narrow"),
            moreMenu(),
        );
        return;
    }

    // Membro (e moderador): "Participando ✓" abre um menu com "Sair".
    const leave = button("Sair da comunidade", "fx-menu-item fx-menu-item--danger");
    leave.addEventListener("click", () => void leaveCommunity());
    const participating = dropdown(button("Participando ✓", "fx-btn fx-btn--outline"), [leave]);

    if (isStaff(c.myRole)) {
        actions.append(link("Moderação", moderationUrl(c.communityId), "fx-btn fx-btn--outline cm-wide"), create, participating, moreMenu());
    } else {
        actions.append(create, participating);
    }
}

async function loadCommunity(): Promise<void> {
    if (!communityId) return;
    try {
        const result = await api.communities.get(communityId);
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
        await api.communities.join(communityId);
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
        await api.communities.leave(communityId);
        await loadCommunity();
        void refreshMyCommunities();
        toast("Você saiu da comunidade.");
    } catch (err) {
        toast(errorMessage(err, "Não foi possível sair da comunidade."), "error");
    }
}

// ===========================================================================
// Filtros do feed, categorias e URL
// ===========================================================================

const TAB_HINTS: Record<Tab, string | null> = {
    all: null,
    unanswered: "Perguntas que ainda não têm uma resposta aceita pelo autor. Que tal ajudar?",
    categories: "Escolha uma categoria para ver só as discussões dela.",
};

/**
 * Reflete vista, filtro, categoria e ordenação na URL, para recarregar ou
 * compartilhar. push: troca de vista (o Voltar volta para a anterior).
 */
function syncUrl(push = false): void {
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
    if (push && url.href !== window.location.href) history.pushState({ view }, "", url);
    else history.replaceState({ view }, "", url);
}

sortSelect?.addEventListener("change", () => {
    sort = SORTS.includes(sortSelect.value as Sort) ? (sortSelect.value as Sort) : "new";
    syncUrl();
    void loadPosts(true);
});

function renderFilters(): void {
    feedFilters?.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((chip) => {
        chip.setAttribute("aria-pressed", String(chip.dataset.tab === tab));
    });
    if (tabHint) {
        tabHint.textContent = TAB_HINTS[tab] ?? "";
        tabHint.hidden = !TAB_HINTS[tab];
    }
    if (chipsEl) chipsEl.hidden = tab !== "categories";
}

function renderChips(): void {
    if (!chipsEl) return;
    const chip = (label: string, value: string | null): HTMLButtonElement => {
        const b = el("button", "fx-chip", label);
        b.type = "button";
        b.dataset.categoryId = value ?? "";
        b.setAttribute("aria-pressed", String(categoryFilter === value));
        return b;
    };
    chipsEl.replaceChildren(
        chip("Todas", null),
        ...categories.map((c) => chip(c.name, c.communityCategoryId)),
    );
}

function selectTab(next: Tab, nextCategory: string | null = null): void {
    tab = next;
    categoryFilter = next === "categories" ? nextCategory : null;
    renderFilters();
    renderChips();
    syncUrl();
    void loadPosts(true);
}

// O que cada filtro mostra não mudou: só deixaram de ser abas e viraram chips.
feedFilters?.addEventListener("click", (event) => {
    const chip = (event.target as Element).closest<HTMLButtonElement>("[data-tab]");
    const next = chip?.dataset.tab as Tab | undefined;
    if (next && next !== tab) selectTab(next);
});

chipsEl?.addEventListener("click", (event) => {
    const chip = (event.target as Element).closest<HTMLButtonElement>(".fx-chip");
    if (!chip) return;
    selectTab("categories", chip.dataset.categoryId || null);
});

// ===========================================================================
// Vistas: Discussões, Regras, Membros, Eventos
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
              viewerRole: () => community?.myRole ?? null,
              communityName: () => community?.name ?? "",
              onCommunityChanged: loadCommunity,
          })
        : null;

const upcomingWidget = $("upcomingWidget");
const miniEvents = $("miniEvents");
const refreshUpcoming = (): void => {
    if (!communityId) return;
    if (upcomingWidget) void loadUpcomingWidget(upcomingWidget, communityId, 3);
    if (miniEvents) void loadUpcomingWidget(miniEvents, communityId, 1);
};

const eventsRoot = $("eventsRoot");
const eventsView =
    communityId && eventsRoot
        ? createEventsView(eventsRoot, {
              communityId,
              viewerRole: () => community?.myRole ?? null,
              onChanged: refreshUpcoming,
          })
        : null;
let eventsLoaded = false;

// "Ver todos" e os eventos dos widgets levam à vista de eventos sem recarregar
// (com Ctrl/⌘/Shift, o href abre em outra aba).
document.querySelectorAll<HTMLElement>("#upcomingWidget, #miniEvents").forEach((widget) => {
    widget.addEventListener("click", (event) => {
        const link = (event.target as Element).closest("a");
        if (!link || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        showView("events", true);
        viewTabs?.querySelector<HTMLElement>('[data-view="events"]')?.focus();
    });
});

function renderRules(): void {
    const text = $("rulesText");
    const edit = $<HTMLAnchorElement>("rulesEdit");
    if (!text || !community) return;
    // textContent + white-space: pre-wrap no CSS: quebras de linha sem HTML.
    text.textContent = community.rules?.trim() || "Esta comunidade ainda não tem regras escritas.";
    text.classList.toggle("is-empty", !community.rules?.trim());
    if (edit) {
        edit.hidden = community.myRole !== "owner";
        edit.href = communityEditUrl(community.communityId);
    }
}

/** push: a troca veio de um clique (entra no histórico do navegador). */
function showView(next: View, push = false): void {
    const changed = next !== view;
    view = next;
    for (const [key, id] of Object.entries(VIEW_IDS)) {
        const section = $(id);
        if (section) section.hidden = key !== view;
    }
    viewTabs?.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((button) => {
        const active = button.dataset.view === view;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        // No celular a linha rola: a aba aberta fica à vista.
        if (active) button.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    syncUrl(push && changed);
    if (view === "members" && (changed || membersRoot?.childElementCount === 0)) {
        void membersView?.reload();
    }
    // O papel (quem cria eventos) chega com a comunidade; a vista recarrega
    // quando ela chega também (ver loadCommunity).
    if (view === "events" && (changed || !eventsLoaded)) {
        eventsLoaded = true;
        void eventsView?.reload();
    }
}

viewTabs?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    const next = button?.dataset.view as View | undefined;
    if (!next) return;
    // "Discussões" de novo volta para o filtro Conversas.
    if (next === "discussions" && view === "discussions" && tab !== "all") selectTab("all");
    showView(next, true);
});
bindTabKeys(viewTabs);

/** A vista que a URL pede (?view=). */
function viewFromUrl(): View {
    const urlView = new URLSearchParams(window.location.search).get("view") as View | null;
    return urlView && VIEWS.includes(urlView) ? urlView : "discussions";
}

// Voltar e Avançar do navegador: a vista da URL, sem empilhar de novo.
window.addEventListener("popstate", () => showView(viewFromUrl()));

// ===========================================================================
// Posts
// ===========================================================================

function showFeedStatus(message: string, isError = false): void {
    if (!postsList) return;
    postsList.innerHTML = `<div class="tf-feed-status${isError ? " error" : ""}"></div>`;
    const status = postsList.querySelector(".tf-feed-status");
    if (status) status.textContent = message;
}

function emptyMessage(): string {
    if (tab === "unanswered") return "Todas as perguntas já têm uma resposta aceita. 🎉";
    if (tab === "categories" && categoryFilter) return "Nenhuma discussão nesta categoria ainda.";
    return "Nenhuma discussão ainda. Seja o primeiro a publicar!";
}

/** Lista vazia com o atalho para publicar (menos em "Ajudar os outros"). */
function showEmptyFeed(): void {
    if (!postsList) return;
    const action = tab === "unanswered" ? undefined : { label: "Criar discussão", onClick: () => void createPost() };
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

    const query = {
        page: page + 1,
        limit: POSTS_PER_PAGE,
        sort,
        unanswered: tab === "unanswered" ? true : undefined,
        categoryId: tab === "categories" ? categoryFilter : null,
    };

    try {
        const result = await api.communities.posts(communityId, query);
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
    if (tab === "categories" && categoryFilter) return post.communityCategoryId === categoryFilter;
    return true; // "Conversas" e "Ajudar os outros" (post novo tem 0 respostas)
}

async function editPost(post: Post): Promise<void> {
    if (!communityId || !thread) return;
    const saved = await openPostEditor({ communityId, categories, post, communityName: community?.name });
    if (saved) {
        thread.replace(saved);
        toast("Discussão atualizada.");
    }
}

/** "Criar post" do widget (desktop), do topo (tablet e celular) e da lista vazia. */
async function createPost(): Promise<void> {
    if (!communityId || !thread || !postsList || !ensureLoggedIn()) return;
    if (!community?.myRole) {
        // Só membros publicam: oferece entrar em vez de deixar o erro 403.
        const ok = await confirmDialog({
            title: "Participar para publicar?",
            message: "Só quem participa da comunidade pode criar discussões.",
            confirmLabel: "Participar",
        });
        if (!ok || !(await joinCommunity())) return;
    }

    const post = await openPostEditor({ communityId, categories, communityName: community?.name });
    if (!post) return;
    // O post novo aparece em Discussões, mesmo que o editor tenha sido aberto de outra vista.
    if (view !== "discussions") showView("discussions", true);
    if (matchesCurrentFilter(post)) {
        if (thread.posts.size === 0) postsList.innerHTML = "";
        thread.add([post], "prepend");
    }
}

$("btnCreatePost")?.addEventListener("click", () => void createPost());

// ===========================================================================
// Início
// ===========================================================================

function readUrlState(): void {
    const params = new URLSearchParams(window.location.search);
    view = viewFromUrl();
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
    // Os "Ver todos" também abrem em nova aba (Ctrl/⌘ + clique).
    document.querySelectorAll<HTMLAnchorElement>('[data-view-link="events"]').forEach((a) => {
        a.href = communityUrl(communityId, "events");
    });
    readUrlState();
    renderFilters();
    // A vista inicial (vazia ou ?view=) é o estado de entrada: eventsLoaded faz a primeira carga.
    const initial = view;
    view = "discussions";
    showView(initial);
    void loadCommunity();
    void loadPosts(true);
    const leaderboardWidget = $("leaderboardWidget");
    if (leaderboardWidget) createLeaderboard(leaderboardWidget, communityId);
    const miniRanking = $("miniRanking");
    if (miniRanking) void loadPodium(miniRanking, communityId);
    refreshUpcoming();
}

export {};
