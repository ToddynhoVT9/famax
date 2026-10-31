/**
 * FAMAX — Página de resultados da busca (search.html?q=&type=&page=)
 *
 * Aberta pelo Enter no campo de pesquisa do header. "Tudo" mostra as cinco
 * primeiras de cada tipo, com atalho para ver todas; as outras abas mostram
 * um tipo só, paginado. Aba, termo e página ficam na URL.
 *
 * As abas e o escopo do header ("Tudo ▾") são o mesmo controle: trocar a aba
 * troca o escopo (setSearchScope), e o escopo troca a aba (SCOPE_CHANGE). A
 * paginação tem números do tablet ao desktop; no celular, "Carregar mais"
 * acrescenta a próxima página à lista.
 */
import { api } from "./shared/api.js";
import { ICONS, initLayout } from "./shared/layout.js";
import { SCOPE_CHANGE, setSearchScope } from "./shared/header-dropdowns.js";
import { communityUrl, postUrl, profileUrl, searchUrl, type SearchType } from "./shared/pages.js";
import { avatarColor, initials, timeAgo, truncate } from "./shared/dom.js";
import type { SearchCommunity as CommunityResult, SearchPost as PostResult, SearchSection as Section, UserSummary as UserResult } from "../../shared/api-types.js";

// No tablet e no celular, o campo de busca fica no lugar do logo.
initLayout({ pesquisa: true });

const PER_PAGE = 10;
const TYPES: SearchType[] = ["all", "communities", "users", "posts"];
/** No celular, "Carregar mais" no lugar dos números. */
const PHONE = window.matchMedia("(max-width: 599px)");

const params = new URLSearchParams(window.location.search);
const q = (params.get("q") ?? "").trim();
let type: SearchType = TYPES.includes(params.get("type") as SearchType)
    ? (params.get("type") as SearchType)
    : "all";
let page = Math.max(1, Number(params.get("page")) || 1);

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

const results = $("searchResults");
const pager = $("searchPager");

// O campo do header mostra o termo pesquisado.
const headerInput = $<HTMLInputElement>("searchInput");
if (headerInput) headerInput.value = q;

// ===========================================================================
// Render (tudo por textContent / createElement)
// ===========================================================================

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function avatar(text: string, seed: string): HTMLElement {
    const node = el("span", `fx-avatar fx-avatar--md ${avatarColor(seed)}`, text);
    node.setAttribute("aria-hidden", "true");
    return node;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function communityItem(c: CommunityResult): HTMLElement {
    const a = el("a", "fx-result");
    a.href = communityUrl(c.communityId);
    const body = el("span", "fx-result-body");
    body.append(
        el("span", "fx-result-title", c.name),
        el(
            "span",
            "fx-result-meta",
            [c.categoryName, plural(c.membersCount, "membro", "membros")].filter(Boolean).join(" · "),
        ),
    );
    if (c.description) body.append(el("span", "fx-result-snippet", truncate(c.description, 160)));
    a.append(avatar(c.name.charAt(0).toUpperCase(), c.communityId), body);
    return a;
}

function userItem(u: UserResult): HTMLElement {
    const a = el("a", "fx-result");
    a.href = profileUrl(u.userId);
    const name = u.displayName ?? u.username;
    const body = el("span", "fx-result-body");
    body.append(el("span", "fx-result-title", name), el("span", "fx-result-meta", `@${u.username}`));
    a.append(avatar(initials(name), u.userId), body);
    return a;
}

/** Na ordem do PostCard: avatar, autor e comunidade, título, trecho e números. */
function postItem(p: PostResult): HTMLElement {
    const a = el("a", "fx-result");
    a.href = postUrl(p.postId);
    const author = p.authorDisplayName ?? p.authorUsername;
    const meta = el("span", "fx-result-meta");
    meta.append(el("strong", "", author), ` · em ${p.communityName} · ${timeAgo(p.createdAt)}`);
    const body = el("span", "fx-result-body");
    body.append(
        meta,
        el("span", "fx-result-title", p.title),
        el("span", "fx-result-snippet", truncate(p.snippet.replace(/\s+/g, " "), 200)),
        el(
            "span",
            "fx-result-meta fx-result-stats",
            `${plural(p.likesCount, "curtida", "curtidas")} · ${plural(p.commentsCount, "comentário", "comentários")}`,
        ),
    );
    a.append(avatar(initials(author), p.authorUsername), body);
    return a;
}

const SECTION_LABEL: Record<Exclude<SearchType, "all">, string> = {
    communities: "Comunidades",
    users: "Usuários",
    posts: "Posts",
};

function renderItem(key: Exclude<SearchType, "all">, item: unknown): HTMLElement {
    if (key === "communities") return communityItem(item as CommunityResult);
    if (key === "users") return userItem(item as UserResult);
    return postItem(item as PostResult);
}

function renderSection(
    key: Exclude<SearchType, "all">,
    section: Section<unknown> | undefined,
    preview: boolean,
): HTMLElement | null {
    if (!section) return null;
    const wrapper = el("section", "fx-rsection");

    if (preview) {
        const header = el("div", "fx-rsection-head");
        header.append(el("h2", "fx-rsection-title", `${SECTION_LABEL[key]} (${section.total})`));
        if (section.total > section.data.length) {
            const more = el("a", "fx-rsection-more", "Ver todos");
            more.href = searchUrl(q, key);
            more.addEventListener("click", (event) => {
                event.preventDefault();
                selectType(key);
            });
            header.append(more);
        }
        wrapper.append(header);
    }

    if (section.data.length === 0) {
        wrapper.append(el("p", "search-status", `Nenhum resultado em ${SECTION_LABEL[key].toLowerCase()}.`));
        return wrapper;
    }

    // De ponta a ponta no celular (.r-edge).
    const list = el("div", "fx-results r-edge");
    list.dataset.resultList = "";
    for (const item of section.data) list.append(renderItem(key, item));
    wrapper.append(list);
    return wrapper;
}

function setStatus(message: string): void {
    results?.replaceChildren(el("p", "search-status", message));
    lastSection = null;
    renderPager();
}

// ===========================================================================
// Paginação
// ===========================================================================

/** A seção paginada na tela (aba de um tipo só), para redesenhar a paginação. */
let lastSection: Section<unknown> | null = null;
/** Última página já na lista (no celular, "Carregar mais" acrescenta). */
let shownPage = page;

/** Páginas com número: todas até 7; acima disso, as pontas e as vizinhas da atual. */
function pageNumbers(current: number, total: number): Array<number | null> {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const wanted = new Set([1, total, current - 1, current, current + 1]);
    const list: Array<number | null> = [];
    for (let n = 1; n <= total; n++) {
        if (!wanted.has(n)) continue;
        if (list.length && (list[list.length - 1] as number) < n - 1) list.push(null);
        list.push(n);
    }
    return list;
}

function pagerButton(label: string, className = ""): HTMLButtonElement {
    const button = el("button", `fx-btn fx-btn--outline fx-btn--sm fx-btn--pill ${className}`.trim(), label);
    button.type = "button";
    return button;
}

function renderPager(): void {
    if (!pager) return;
    const section = lastSection;
    if (!section || section.totalPages <= 1) {
        pager.hidden = true;
        pager.replaceChildren();
        return;
    }
    pager.hidden = false;
    const info = el("p", "search-pager-info");

    if (PHONE.matches) {
        const shown = Math.min(section.total, shownPage * PER_PAGE);
        info.textContent = `${shown} de ${plural(section.total, "resultado", "resultados")}`;
        const children: HTMLElement[] = [];
        if (shownPage < section.totalPages) {
            const more = el("button", "fx-btn fx-btn--outline fx-btn--pill fx-btn--block", "Carregar mais");
            more.type = "button";
            more.dataset.pagerMore = "";
            children.push(more);
        }
        pager.replaceChildren(...children, info);
        return;
    }

    const prev = pagerButton("");
    prev.innerHTML = ICONS.prev;
    prev.setAttribute("aria-label", "Página anterior");
    prev.disabled = section.page <= 1;
    prev.dataset.page = String(section.page - 1);
    const next = pagerButton("");
    next.innerHTML = ICONS.next;
    next.setAttribute("aria-label", "Próxima página");
    next.disabled = section.page >= section.totalPages;
    next.dataset.page = String(section.page + 1);

    const numbers = pageNumbers(section.page, section.totalPages).map((n) => {
        if (n === null) {
            const gap = el("span", "search-pager-gap", "…");
            gap.setAttribute("aria-hidden", "true");
            return gap;
        }
        const button = pagerButton(String(n));
        button.dataset.page = String(n);
        button.setAttribute("aria-label", `Página ${n}`);
        if (n === section.page) button.setAttribute("aria-current", "page");
        return button;
    });
    info.textContent = `Página ${section.page} de ${section.totalPages} · ${plural(section.total, "resultado", "resultados")}`;
    pager.replaceChildren(prev, ...numbers, next, info);
}

PHONE.addEventListener("change", renderPager);

// ===========================================================================
// Abas, URL e carregamento
// ===========================================================================

function syncUrl(): void {
    const url = new URL(window.location.href);
    url.searchParams.set("q", q);
    if (type === "all") url.searchParams.delete("type");
    else url.searchParams.set("type", type);
    if (page > 1) url.searchParams.set("page", String(page));
    else url.searchParams.delete("page");
    history.replaceState(null, "", url);
}

function renderTabs(): void {
    document.querySelectorAll<HTMLButtonElement>('#searchTabs [role="tab"]').forEach((tab) => {
        const active = tab.dataset.type === type;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        if (active) {
            results?.setAttribute("aria-labelledby", tab.id);
            // A aba escolhida fica à vista na linha que rola.
            tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    });
}

/** fromScope: a troca veio do escopo do header, que já está certo. */
function selectType(next: SearchType, fromScope = false): void {
    if (next === type) return;
    type = next;
    page = 1;
    renderTabs();
    if (!fromScope) setSearchScope(type);
    syncUrl();
    if (q.length >= 2) void load();
}

let seq = 0;

async function load(): Promise<void> {
    if (!results) return;
    const current = ++seq;
    setStatus("Buscando...");

    try {
        const { results: data } = await api.search({ q, type, page, limit: PER_PAGE });
        if (current !== seq) return;

        if (type === "all") {
            const sections = (["communities", "users", "posts"] as const)
                .map((key) => renderSection(key, data[key] as Section<unknown> | undefined, true))
                .filter((s): s is HTMLElement => s !== null);
            const total = (data.communities?.total ?? 0) + (data.users?.total ?? 0) + (data.posts?.total ?? 0);
            if (total === 0) return setStatus(`Nada encontrado para "${q}".`);
            results.replaceChildren(...sections);
            renderPager();
            return;
        }

        const section = data[type] as Section<unknown> | undefined;
        const rendered = renderSection(type, section, false);
        if (!section || section.total === 0 || !rendered) {
            return setStatus(`Nada encontrado em ${SECTION_LABEL[type].toLowerCase()} para "${q}".`);
        }
        results.replaceChildren(rendered);
        lastSection = section;
        shownPage = section.page;
        renderPager();
    } catch (err) {
        if (current === seq) setStatus(err instanceof Error ? err.message : "Não foi possível buscar.");
    }
}

/** Celular: a próxima página entra no fim da lista; a URL continua na primeira. */
async function loadMore(button: HTMLButtonElement): Promise<void> {
    const key = type;
    const list = results?.querySelector<HTMLElement>("[data-result-list]");
    if (key === "all" || !list || !lastSection) return;
    const current = seq;
    button.disabled = true;
    try {
        const { results: data } = await api.search({ q, type: key, page: shownPage + 1, limit: PER_PAGE });
        if (current !== seq) return;
        const section = data[key] as Section<unknown> | undefined;
        if (!section) return;
        for (const item of section.data) list.append(renderItem(key, item));
        lastSection = { ...section, page: lastSection.page };
        shownPage = section.page;
        renderPager();
        pager?.querySelector<HTMLElement>("[data-pager-more]")?.focus();
    } catch (err) {
        button.disabled = false;
        pager?.querySelector(".search-pager-info")?.replaceChildren(
            err instanceof Error ? err.message : "Não foi possível carregar mais.",
        );
    }
}

$("searchTabs")?.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    const next = tab?.dataset.type as SearchType | undefined;
    if (next) selectType(next);
});

// Teclado no padrão de tablist.
$("searchTabs")?.addEventListener("keydown", (event) => {
    const index = TYPES.indexOf(type);
    let target = -1;
    if (event.key === "ArrowRight") target = (index + 1) % TYPES.length;
    else if (event.key === "ArrowLeft") target = (index - 1 + TYPES.length) % TYPES.length;
    if (target < 0) return;
    event.preventDefault();
    selectType(TYPES[target]);
    document.querySelector<HTMLButtonElement>(`#searchTabs [data-type="${TYPES[target]}"]`)?.focus();
});

// O escopo do header escolhido no menu troca a aba.
document.addEventListener(SCOPE_CHANGE, (event) => {
    const next = (event as CustomEvent<SearchType>).detail;
    if (TYPES.includes(next)) selectType(next, true);
});

pager?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    if (button.dataset.pagerMore !== undefined) {
        void loadMore(button);
        return;
    }
    const next = Number(button.dataset.page);
    if (!next || next === page) return;
    page = next;
    syncUrl();
    void load();
    window.scrollTo({ top: 0, behavior: "smooth" });
});

// ===========================================================================
// Início
// ===========================================================================

const title = $("searchTitle");
renderTabs();
if (q.length < 2) {
    if (title) title.textContent = "Pesquisa";
    setStatus("Digite pelo menos 2 caracteres no campo de pesquisa.");
} else {
    if (title) title.textContent = `Resultados para "${q}"`;
    document.title = `${q} · Pesquisa · FAMAX`;
    void load();
}
