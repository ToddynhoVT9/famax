/**
 * FAMAX — Página de resultados da busca (search.html?q=&type=&page=)
 *
 * Aberta pelo Enter no campo de pesquisa do header. "Tudo" mostra as cinco
 * primeiras de cada tipo, com atalho para ver todas; as outras abas mostram
 * um tipo só, paginado. Aba, termo e página ficam na URL.
 */
import { api } from "./shared/api.js";
import { initLayout } from "./shared/layout.js";
import { communityUrl, postUrl, profileUrl, searchUrl, type SearchType } from "./shared/pages.js";
import { avatarColor, initials, timeAgo, truncate } from "./shared/dom.js";

initLayout();

interface CommunityResult {
    community_id: string;
    name: string;
    description: string | null;
    category_name: string | null;
    members_count: number;
}
interface UserResult {
    user_id: string;
    username: string;
    display_name: string | null;
}
interface PostResult {
    post_id: string;
    title: string;
    snippet: string;
    created_at: string;
    community_id: string;
    community_name: string;
    author_username: string;
    author_display_name: string | null;
    likes_count: number;
    comments_count: number;
}
interface Section<T> {
    data: T[];
    total: number;
    page: number;
    totalPages: number;
}
interface SearchResponse {
    results: {
        communities?: Section<CommunityResult>;
        users?: Section<UserResult>;
        posts?: Section<PostResult>;
    };
}

const PER_PAGE = 10;
const TYPES: SearchType[] = ["all", "communities", "users", "posts"];

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

function badge(text: string, seed: string): HTMLElement {
    const node = el("span", `result-badge ${avatarColor(seed)}`, text);
    node.setAttribute("aria-hidden", "true");
    return node;
}

function communityItem(c: CommunityResult): HTMLElement {
    const a = el("a", "result-item");
    a.href = communityUrl(c.community_id);
    const body = el("span", "result-body");
    body.append(
        el("span", "result-title", c.name),
        el(
            "span",
            "result-meta",
            [c.category_name, `${c.members_count} ${c.members_count === 1 ? "membro" : "membros"}`]
                .filter(Boolean)
                .join(" · "),
        ),
    );
    if (c.description) body.append(el("span", "result-snippet", truncate(c.description, 160)));
    a.append(badge(c.name.charAt(0).toUpperCase(), c.community_id), body);
    return a;
}

function userItem(u: UserResult): HTMLElement {
    const a = el("a", "result-item");
    a.href = profileUrl(u.user_id);
    const name = u.display_name ?? u.username;
    const body = el("span", "result-body");
    body.append(el("span", "result-title", name), el("span", "result-meta", `@${u.username}`));
    a.append(badge(initials(name), u.user_id), body);
    return a;
}

function postItem(p: PostResult): HTMLElement {
    const a = el("a", "result-item result-item--post");
    a.href = postUrl(p.post_id);
    const body = el("span", "result-body");
    body.append(
        el(
            "span",
            "result-meta",
            `${p.community_name} · ${p.author_display_name ?? p.author_username} · ${timeAgo(p.created_at)}`,
        ),
        el("span", "result-title", p.title),
        el("span", "result-snippet", truncate(p.snippet.replace(/\s+/g, " "), 200)),
        el("span", "result-meta", `👍 ${p.likes_count}  💬 ${p.comments_count}`),
    );
    a.append(body);
    return a;
}

const SECTION_LABEL: Record<Exclude<SearchType, "all">, string> = {
    communities: "Comunidades",
    users: "Usuários",
    posts: "Posts",
};

function renderSection(
    key: Exclude<SearchType, "all">,
    section: Section<unknown> | undefined,
    preview: boolean,
): HTMLElement | null {
    if (!section) return null;
    const wrapper = el("section", "result-section");

    if (preview) {
        const header = el("div", "result-section-header");
        header.append(el("h2", "result-section-title", `${SECTION_LABEL[key]} (${section.total})`));
        if (section.total > section.data.length) {
            const more = el("a", "result-section-more", "Ver todos");
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
        wrapper.append(el("p", "result-empty", `Nenhum resultado em ${SECTION_LABEL[key].toLowerCase()}.`));
        return wrapper;
    }

    const list = el("div", "result-list");
    for (const item of section.data) {
        if (key === "communities") list.append(communityItem(item as CommunityResult));
        else if (key === "users") list.append(userItem(item as UserResult));
        else list.append(postItem(item as PostResult));
    }
    wrapper.append(list);
    return wrapper;
}

function setStatus(message: string): void {
    results?.replaceChildren(el("p", "result-empty", message));
    if (pager) pager.hidden = true;
}

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
    document.querySelectorAll<HTMLButtonElement>(".search-tab").forEach((tab) => {
        const active = tab.dataset.type === type;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
    });
}

function selectType(next: SearchType): void {
    type = next;
    page = 1;
    renderTabs();
    syncUrl();
    void load();
}

let seq = 0;

async function load(): Promise<void> {
    if (!results) return;
    const current = ++seq;
    setStatus("Buscando...");

    try {
        const query = new URLSearchParams({ q, type, page: String(page), limit: String(PER_PAGE) });
        const { results: data } = await api<SearchResponse>(`/search?${query}`);
        if (current !== seq) return;

        if (type === "all") {
            const sections = (["communities", "users", "posts"] as const)
                .map((key) => renderSection(key, data[key] as Section<unknown> | undefined, true))
                .filter((s): s is HTMLElement => s !== null);
            const total = (data.communities?.total ?? 0) + (data.users?.total ?? 0) + (data.posts?.total ?? 0);
            if (total === 0) return setStatus(`Nada encontrado para "${q}".`);
            results.replaceChildren(...sections);
            if (pager) pager.hidden = true;
            return;
        }

        const section = data[type] as Section<unknown> | undefined;
        const rendered = renderSection(type, section, false);
        if (!section || section.total === 0 || !rendered) {
            return setStatus(`Nada encontrado em ${SECTION_LABEL[type].toLowerCase()} para "${q}".`);
        }
        results.replaceChildren(rendered);

        if (pager) {
            pager.hidden = section.totalPages <= 1;
            const info = $("pagerInfo");
            if (info) info.textContent = `Página ${section.page} de ${section.totalPages} · ${section.total} resultados`;
            const prev = $<HTMLButtonElement>("pagerPrev");
            const next = $<HTMLButtonElement>("pagerNext");
            if (prev) prev.disabled = section.page <= 1;
            if (next) next.disabled = section.page >= section.totalPages;
        }
    } catch (err) {
        if (current === seq) setStatus(err instanceof Error ? err.message : "Não foi possível buscar.");
    }
}

$("searchTabs")?.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>(".search-tab");
    const next = tab?.dataset.type as SearchType | undefined;
    if (next && next !== type) selectType(next);
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
    document.querySelector<HTMLButtonElement>(`.search-tab[data-type="${TYPES[target]}"]`)?.focus();
});

const goToPage = (next: number): void => {
    page = next;
    syncUrl();
    void load();
    window.scrollTo({ top: 0, behavior: "smooth" });
};
$("pagerPrev")?.addEventListener("click", () => goToPage(Math.max(1, page - 1)));
$("pagerNext")?.addEventListener("click", () => goToPage(page + 1));

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
