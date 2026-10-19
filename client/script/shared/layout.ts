/**
 * FAMAX — Layout compartilhado (header + sidebar)
 *
 * Antes cada HTML trazia a sua cópia do header e da sidebar, e as cópias
 * divergiam: o link "usuário" era texto fixo, as páginas de perfil listavam
 * "Comunidade que participo 1..9" e o loadMyCommunities existia duas vezes.
 * Agora o HTML só tem os placeholders e tudo sai daqui:
 *
 *   <header id="app-header" class="header"></header>
 *   <aside id="app-sidebar" class="sidebar"></aside>
 *
 * Os placeholders já levam as classes do layout, então o CSS reserva o espaço
 * antes de este script rodar. A estrutura é desenhada na hora, de forma
 * síncrona, com o usuário e as comunidades em estado de carregamento — o que
 * depende da API é preenchido quando ela responde, sem deslocar nada.
 *
 * Regra de sempre: dado da API entra por textContent/atributo, nunca por
 * innerHTML (ver dom.ts).
 */
import { api, getMe, getToken, logout, type Me } from "./api.js";
import { communityUrl, loginUrlReturningHere, pages } from "./pages.js";
import { avatarColor, initials } from "./dom.js";
import { initHeaderDropdowns } from "./header-dropdowns.js";
import { initSidebar } from "./sidebar.js";

export interface SidebarLink {
    label: string;
    /** Sem href o link aparece desativado, com o selo "Em breve". */
    href?: string;
    /**
     * Ação no lugar da navegação (ex.: "Discussões" volta para a aba sem
     * recarregar). O href continua lá para abrir em nova aba.
     */
    onClick?: (event: MouseEvent) => void;
    /** Mantém o destaque de página atual mesmo com query diferente. */
    current?: boolean;
    /** Identifica o link para setCurrentPageLink (troca de vista sem recarregar). */
    key?: string;
}

export interface LayoutOptions {
    /**
     * Links próprios da página, logo abaixo de "Página Inicial". A comunidade
     * usa para Discussões/Regras/Membros/Eventos/Suporte.
     */
    pageLinks?: SidebarLink[];
}

// ===========================================================================
// Header
// ===========================================================================

// Markup fixo (sem dado de usuário): pode ir por innerHTML. Os ids são os que
// o header-dropdowns.ts procura.
const HEADER_HTML = `
    <a class="logo-container" data-nav="home">
        <span class="logo-text">FAMAX</span>
        <span class="logo-subtext">Logo</span>
    </a>

    <form class="search-container" id="searchForm" role="search">
        <input type="search" id="searchInput" class="search-input" placeholder="Pesquisar"
               autocomplete="off" maxlength="80" aria-label="Pesquisar"
               role="combobox" aria-autocomplete="list" aria-expanded="false"
               aria-controls="searchSuggestions">
        <div class="search-suggestions" id="searchSuggestions" role="listbox" aria-label="Sugestões"></div>
    </form>

    <div class="header-actions">
        <div class="filtros-container">
            <button type="button" class="btn-filtros" id="btnFiltros"
                    aria-haspopup="true" aria-expanded="false" aria-controls="filtrosDropdown">Filtros</button>
            <!-- O filtro escolhe o tipo da busca (ver header-dropdowns.ts). -->
            <div class="filtros-dropdown" id="filtrosDropdown" role="radiogroup" aria-label="Pesquisar em">
                <label class="filtro-item">
                    <input type="radio" name="filtroOpcao" value="all" checked>
                    <span class="custom-radio"></span>Tudo
                </label>
                <label class="filtro-item">
                    <input type="radio" name="filtroOpcao" value="communities">
                    <span class="custom-radio"></span>Comunidades
                </label>
                <label class="filtro-item">
                    <input type="radio" name="filtroOpcao" value="users">
                    <span class="custom-radio"></span>Usuários
                </label>
                <label class="filtro-item">
                    <input type="radio" name="filtroOpcao" value="posts">
                    <span class="custom-radio"></span>Posts
                </label>
            </div>
        </div>

        <div class="user-area" id="userArea"></div>
    </div>
`;

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function renderGuestArea(area: HTMLElement): void {
    area.replaceChildren();

    const login = el("a", "header-auth-btn", "Entrar");
    login.href = loginUrlReturningHere();

    const register = el("a", "header-auth-btn header-auth-btn--primary", "Criar conta");
    register.href = pages.register;

    area.append(login, register);
}

/** Círculo do avatar: a foto, ou as iniciais na cor estável do usuário. */
function renderAvatar(me: Me): HTMLElement {
    if (me.avatarUrl) {
        const img = el("img", "user-avatar");
        img.src = me.avatarUrl;
        img.alt = "";
        return img;
    }
    const name = me.displayName ?? me.username;
    return el("span", `user-avatar ${avatarColor(me.userId)}`, initials(name));
}

function renderUserArea(area: HTMLElement, me: Me): void {
    area.replaceChildren();

    const menu = el("div", "user-menu");

    const button = el("button", "user-menu-btn");
    button.type = "button";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.append(renderAvatar(me), el("span", "user-name", me.displayName ?? me.username));

    const dropdown = el("div", "user-dropdown");
    dropdown.setAttribute("role", "menu");
    dropdown.hidden = true;

    const profile = el("a", "user-dropdown-item", "Meu perfil");
    profile.href = pages.profile;
    const settings = el("a", "user-dropdown-item", "Configurações");
    settings.href = pages.settings;
    const signOut = el("button", "user-dropdown-item", "Sair");
    signOut.type = "button";
    const items: HTMLElement[] = [profile, settings];
    if (me.isAdmin) {
        const admin = el("a", "user-dropdown-item", "Denúncias de usuários");
        admin.href = pages.adminReports;
        items.push(admin);
    }
    items.push(signOut);
    for (const item of items) item.setAttribute("role", "menuitem");

    dropdown.append(...items);
    menu.append(button, dropdown);
    area.append(menu);

    const setOpen = (open: boolean): void => {
        dropdown.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
    };

    button.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(dropdown.hidden);
    });
    document.addEventListener("click", (event) => {
        if (event.target instanceof Node && !menu.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !dropdown.hidden) {
            setOpen(false);
            button.focus();
        }
    });

    signOut.addEventListener("click", () => {
        signOut.disabled = true;
        void logout();
    });
}

let userAreaEl: HTMLElement | null = null;

/**
 * Redesenha nome e avatar do header. A tela de configurações chama depois de
 * salvar, para a mudança aparecer sem recarregar a página.
 */
export function updateHeaderUser(me: Me): void {
    if (userAreaEl) renderUserArea(userAreaEl, me);
}

function renderHeader(header: HTMLElement): void {
    header.innerHTML = HEADER_HTML;

    const logo = header.querySelector<HTMLAnchorElement>('[data-nav="home"]');
    if (logo) logo.href = pages.home;

    const area = header.querySelector<HTMLElement>("#userArea");
    if (!area) return;
    userAreaEl = area;

    // Sem token não há o que perguntar à API: visitante na hora.
    if (!getToken()) {
        renderGuestArea(area);
        return;
    }

    // Reserva o lugar do avatar enquanto o /me responde — sem isto a área
    // nasceria vazia e "pularia" quando o nome chegasse.
    area.replaceChildren(el("span", "user-avatar user-avatar--loading"));
    area.setAttribute("aria-busy", "true");

    getMe()
        .then((me) => renderUserArea(area, me))
        .catch(() => {
            // 401: o api() já limpou o token (e redireciona se a página exige
            // login). Erro de rede: melhor mostrar "Entrar" do que um vazio.
            renderGuestArea(area);
        })
        .finally(() => area.removeAttribute("aria-busy"));
}

// ===========================================================================
// Sidebar
// ===========================================================================

/**
 * Link atual: mesmo caminho e mesma query. É o que separa uma comunidade da
 * outra (community.html?id=A vs ?id=B). Hash é ignorado.
 */
function isCurrent(href: string): boolean {
    const url = new URL(href, window.location.href);
    return (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
    );
}

function sidebarLink(label: string, href: string, className = "sidebar-link"): HTMLAnchorElement {
    const link = el("a", className, label);
    link.href = href;
    if (href !== "#" && isCurrent(href)) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
    }
    return link;
}

let myCommunitiesEl: HTMLElement | null = null;

function sidebarStatus(text: string): HTMLElement {
    return el("p", "sidebar-status", text);
}

/**
 * Preenche "Minhas comunidades". Exportada para a página chamar de novo quando
 * a lista muda (ex.: depois de "Participar").
 */
export async function refreshMyCommunities(): Promise<void> {
    const container = myCommunitiesEl;
    if (!container) return;

    if (!getToken()) {
        const login = sidebarLink("Entre para ver suas comunidades", loginUrlReturningHere());
        login.classList.add("sidebar-link--muted");
        container.replaceChildren(login);
        return;
    }

    try {
        const { data } = await api<{
            data: Array<{ community_id: string; name: string }>;
        }>("/me/communities");

        if (data.length === 0) {
            container.replaceChildren(
                sidebarStatus("Você ainda não participa de nenhuma comunidade."),
            );
            return;
        }

        container.replaceChildren(
            ...data.map((c) => sidebarLink(c.name, communityUrl(c.community_id))),
        );
    } catch {
        // Sidebar é acessório; a página continua utilizável sem ela.
        container.replaceChildren(sidebarStatus("Não foi possível carregar."));
    }
}

function renderSidebar(sidebar: HTMLElement, options: LayoutOptions): void {
    const home = el("div", "sidebar-header");
    home.append(sidebarLink("Página Inicial", pages.home));

    const pageLinks = (options.pageLinks ?? []).map((link) => {
        if (!link.href) {
            // Recurso que ainda não existe: visível, mas sem fingir que é link.
            const disabled = el("span", "sidebar-link sidebar-link--disabled");
            disabled.setAttribute("aria-disabled", "true");
            disabled.append(link.label, el("span", "sidebar-badge", "Em breve"));
            return disabled;
        }
        const anchor = sidebarLink(link.label, link.href);
        if (link.key) anchor.dataset.pageLink = link.key;
        if (link.current) {
            anchor.classList.add("active");
            anchor.setAttribute("aria-current", "page");
        }
        if (link.onClick) anchor.addEventListener("click", link.onClick);
        return anchor;
    });

    const create = el("div", "sidebar-header sidebar-section");
    create.append(
        sidebarLink("+ Criar comunidade", pages.newCommunity, "sidebar-link sidebar-link--secondary"),
    );

    const title = el("h2", "sidebar-title", "Minhas comunidades");

    myCommunitiesEl = el("nav", "sidebar-communities");
    myCommunitiesEl.setAttribute("aria-label", "Minhas comunidades");
    myCommunitiesEl.append(sidebarStatus("Carregando..."));

    sidebar.replaceChildren(home, ...pageLinks, create, title, myCommunitiesEl);

    // O botão que abre/fecha a sidebar vem logo antes dela no DOM.
    const toggle = el("button", "sidebar-toggle");
    toggle.type = "button";
    toggle.id = "sidebarToggle";
    toggle.setAttribute("aria-label", "Abrir menu lateral");
    toggle.setAttribute("aria-controls", sidebar.id);
    toggle.append(el("span"), el("span"), el("span"));
    sidebar.before(toggle);

    void refreshMyCommunities();
}

/**
 * Muda o destaque entre os links da página (os que têm `key`). A comunidade
 * usa ao trocar entre Discussões, Regras e Membros sem recarregar.
 */
export function setCurrentPageLink(key: string): void {
    document.querySelectorAll<HTMLAnchorElement>("#app-sidebar [data-page-link]").forEach((link) => {
        const current = link.dataset.pageLink === key;
        link.classList.toggle("active", current);
        if (current) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });
}

// ===========================================================================
// Entrada
// ===========================================================================

/**
 * Monta header e sidebar nos placeholders da página e liga os comportamentos
 * (dropdowns do header, toggle da sidebar). Chamar uma vez, no topo do script
 * da página.
 */
export function initLayout(options: LayoutOptions = {}): void {
    const header = document.getElementById("app-header");
    const sidebar = document.getElementById("app-sidebar");

    if (header) renderHeader(header);
    if (sidebar) renderSidebar(sidebar, options);

    initHeaderDropdowns();
    initSidebar();
}
