/**
 * FAMAX — Pesquisa e filtros do header (Shared)
 *
 * Ao digitar (pausa de 300 ms, mínimo 2 caracteres) o dropdown mostra
 * sugestões reais de GET /api/search, agrupadas por tipo. Sem texto, mostra as
 * comunidades mais recentes. Setas navegam, Enter abre a sugestão escolhida —
 * ou, sem escolha, a página de resultados completa —, Esc fecha.
 *
 * O dropdown "Filtros" define o tipo da busca (Tudo, Comunidades, Usuários,
 * Posts); a escolha fica guardada no localStorage deste navegador.
 */
import { api } from "./api.js";
import { communityUrl, postUrl, profileUrl, searchUrl, type SearchType } from "./pages.js";
import { avatarColor, initials } from "./dom.js";

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;
const TYPE_KEY = "famax_search_type";

const PLACEHOLDERS: Record<SearchType, string> = {
    all: "Pesquisar comunidade, usuário ou post",
    communities: "Pesquisar comunidade",
    users: "Pesquisar usuário",
    posts: "Pesquisar post",
};

const GROUP_LABELS: Record<Exclude<SearchType, "all">, string> = {
    communities: "Comunidades",
    users: "Usuários",
    posts: "Posts",
};

interface Suggestion {
    label: string;
    detail: string;
    href: string;
    badge?: { text: string; colorSeed: string };
}

/** localStorage pode não existir ou lançar (aba anônima, bloqueio): nunca é crítico. */
function loadType(): SearchType {
    try {
        const value = localStorage.getItem(TYPE_KEY);
        if (value && value in PLACEHOLDERS) return value as SearchType;
    } catch {
        /* sem armazenamento: usa o padrão */
    }
    return "all";
}

function saveType(type: SearchType): void {
    try {
        localStorage.setItem(TYPE_KEY, type);
    } catch {
        /* idem */
    }
}

/**
 * O que vira sugestão: o resultado da busca ou só a lista de comunidades
 * recentes (que não vem da busca) — daí os campos mínimos, e não SearchResponse.
 */
interface SuggestionSource {
    results: {
        communities?: { data: Array<{ communityId: string; name: string; membersCount: number; categoryName: string | null }> };
        users?: { data: Array<{ userId: string; username: string; displayName: string | null }> };
        posts?: { data: Array<{ postId: string; title: string; communityName: string }> };
    };
}

function toSuggestions(response: SuggestionSource): Array<{ group: string; items: Suggestion[] }> {
    const groups: Array<{ group: string; items: Suggestion[] }> = [];
    const { communities, users, posts } = response.results;

    if (communities?.data.length) {
        groups.push({
            group: GROUP_LABELS.communities,
            items: communities.data.map((c) => ({
                label: c.name,
                detail: `${c.membersCount} ${c.membersCount === 1 ? "membro" : "membros"}${c.categoryName ? ` · ${c.categoryName}` : ""}`,
                href: communityUrl(c.communityId),
                badge: { text: c.name.charAt(0).toUpperCase(), colorSeed: c.communityId },
            })),
        });
    }
    if (users?.data.length) {
        groups.push({
            group: GROUP_LABELS.users,
            items: users.data.map((u) => ({
                label: u.displayName ?? u.username,
                detail: `@${u.username}`,
                href: profileUrl(u.userId),
                badge: { text: initials(u.displayName ?? u.username), colorSeed: u.userId },
            })),
        });
    }
    if (posts?.data.length) {
        groups.push({
            group: GROUP_LABELS.posts,
            items: posts.data.map((p) => ({
                label: p.title,
                detail: `em ${p.communityName}`,
                href: postUrl(p.postId),
            })),
        });
    }
    return groups;
}

export function initHeaderDropdowns(): void {
    const form = document.getElementById("searchForm");
    const input = document.getElementById("searchInput");
    const list = document.getElementById("searchSuggestions");
    const btnFiltros = document.getElementById("btnFiltros");
    const filtrosDropdown = document.getElementById("filtrosDropdown");

    if (
        !(form instanceof HTMLFormElement) ||
        !(input instanceof HTMLInputElement) ||
        !(list instanceof HTMLElement) ||
        !(btnFiltros instanceof HTMLButtonElement) ||
        !(filtrosDropdown instanceof HTMLElement)
    ) {
        return;
    }

    let type = loadType();
    let timer: number | undefined;
    // Respostas que chegam fora de ordem (digitação rápida) são descartadas.
    let requestSeq = 0;
    let activeIndex = -1;

    // ----- Filtro (tipo da busca) ---------------------------------------------

    const applyType = (next: SearchType): void => {
        type = next;
        input.placeholder = PLACEHOLDERS[type];
        input.setAttribute("aria-label", PLACEHOLDERS[type]);
        const radio = filtrosDropdown.querySelector<HTMLInputElement>(`input[value="${type}"]`);
        if (radio) radio.checked = true;
    };
    applyType(type);

    filtrosDropdown.addEventListener("change", (event) => {
        const radio = event.target as HTMLInputElement;
        if (radio.name !== "filtroOpcao") return;
        applyType(radio.value as SearchType);
        saveType(type);
        setFiltersOpen(false);
        // Com texto digitado, refaz as sugestões já no tipo novo.
        if (input.value.trim().length >= MIN_CHARS) void suggest();
        input.focus();
    });

    const setFiltersOpen = (open: boolean): void => {
        filtrosDropdown.classList.toggle("show", open);
        btnFiltros.classList.toggle("active", open);
        btnFiltros.setAttribute("aria-expanded", String(open));
    };

    btnFiltros.addEventListener("click", (event) => {
        event.stopPropagation();
        setFiltersOpen(!filtrosDropdown.classList.contains("show"));
    });

    // ----- Sugestões ------------------------------------------------------------

    const options = () => Array.from(list.querySelectorAll<HTMLAnchorElement>(".suggestion-item[role='option']"));

    const setOpen = (open: boolean): void => {
        list.classList.toggle("show", open);
        input.setAttribute("aria-expanded", String(open));
        if (!open) setActive(-1);
    };

    const setActive = (index: number): void => {
        const all = options();
        activeIndex = index;
        all.forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
        const active = all[index];
        if (active) {
            input.setAttribute("aria-activedescendant", active.id);
            active.scrollIntoView({ block: "nearest" });
        } else {
            input.removeAttribute("aria-activedescendant");
        }
    };

    /** Status (carregando, nada encontrado, erro) no lugar das opções. */
    const renderStatus = (text: string): void => {
        const status = document.createElement("div");
        status.className = "suggestion-status";
        status.textContent = text;
        list.replaceChildren(status);
        setActive(-1);
    };

    const renderGroups = (groups: Array<{ group: string; items: Suggestion[] }>, footer?: Suggestion): void => {
        list.replaceChildren();
        let n = 0;
        for (const { group, items } of groups) {
            const heading = document.createElement("div");
            heading.className = "fx-menu-label";
            heading.textContent = group;
            heading.setAttribute("role", "presentation");
            list.append(heading);

            for (const item of items) {
                const option = document.createElement("a");
                option.className = "fx-menu-item suggestion-item";
                option.id = `search-option-${n++}`;
                option.href = item.href;
                option.setAttribute("role", "option");
                option.setAttribute("aria-selected", "false");

                if (item.badge) {
                    const badge = document.createElement("span");
                    badge.className = `fx-avatar fx-avatar--sm ${avatarColor(item.badge.colorSeed)}`;
                    badge.textContent = item.badge.text;
                    badge.setAttribute("aria-hidden", "true");
                    option.append(badge);
                }
                const text = document.createElement("span");
                text.className = "suggestion-text";
                const label = document.createElement("span");
                label.className = "suggestion-label";
                label.textContent = item.label;
                const detail = document.createElement("span");
                detail.className = "suggestion-detail";
                detail.textContent = item.detail;
                text.append(label, detail);
                option.append(text);
                list.append(option);
            }
        }

        if (footer) {
            const option = document.createElement("a");
            option.className = "fx-menu-item suggestion-item suggestion-footer";
            option.id = `search-option-${n++}`;
            option.href = footer.href;
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", "false");
            option.textContent = footer.label;
            list.append(option);
        }
        setActive(-1);
    };

    /** Sem texto: as comunidades mais recentes, para a pessoa ter por onde começar. */
    const showRecent = async (): Promise<void> => {
        const seq = ++requestSeq;
        renderStatus("Carregando...");
        try {
            const { data } = await api.communities.list({ limit: 5 });
            if (seq !== requestSeq) return;
            if (data.length === 0) return renderStatus("Nenhuma comunidade ainda.");
            renderGroups(
                toSuggestions({ results: { communities: { data } } }).map((g) => ({
                    ...g,
                    group: "Comunidades recentes",
                })),
            );
        } catch {
            if (seq === requestSeq) renderStatus("Não foi possível carregar sugestões.");
        }
    };

    const suggest = async (): Promise<void> => {
        const q = input.value.trim();
        if (q.length === 0) return showRecent();
        if (q.length < MIN_CHARS) return renderStatus(`Digite pelo menos ${MIN_CHARS} caracteres.`);

        const seq = ++requestSeq;
        renderStatus("Buscando...");
        try {
            const params = new URLSearchParams({ q, type, limit: "5" });
            const response = await api.search({ q, type, limit: 5 });
            if (seq !== requestSeq) return;

            const groups = toSuggestions(response);
            const footer: Suggestion = {
                label: `Ver todos os resultados para "${q}"`,
                detail: "",
                href: searchUrl(q, type),
            };
            if (groups.length === 0) {
                renderGroups([], footer);
                const empty = document.createElement("div");
                empty.className = "suggestion-status";
                empty.textContent = "Nada encontrado.";
                list.prepend(empty);
                return;
            }
            renderGroups(groups, footer);
        } catch (err) {
            if (seq === requestSeq) {
                renderStatus(err instanceof Error ? err.message : "Não foi possível buscar.");
            }
        }
    };

    input.addEventListener("focus", () => {
        setOpen(true);
        void suggest();
    });

    input.addEventListener("input", () => {
        setOpen(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void suggest(), DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (event) => {
        const all = options();
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            if (all.length) setActive((activeIndex + 1) % all.length);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (all.length) setActive(activeIndex <= 0 ? all.length - 1 : activeIndex - 1);
        } else if (event.key === "Escape") {
            setOpen(false);
        } else if (event.key === "Enter" && activeIndex >= 0 && all[activeIndex]) {
            // Sugestão escolhida pelas setas: abre ela, não a página de resultados.
            event.preventDefault();
            window.location.href = all[activeIndex].href;
        }
    });

    // Enter sem sugestão escolhida: página de resultados completa.
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const q = input.value.trim();
        if (q.length >= MIN_CHARS) window.location.href = searchUrl(q, type);
    });

    document.addEventListener("click", (event) => {
        const target = event.target as Node;
        if (!form.contains(target)) setOpen(false);
        if (!btnFiltros.contains(target) && !filtrosDropdown.contains(target)) setFiltersOpen(false);
    });
}
