/**
 * FAMAX — Layout compartilhado (header, gaveta e barra inferior)
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
 * Moldura das pranchas R: no desktop e no compacto o header tem ☰, logo,
 * busca com escopo, sino, chat e avatar; no tablet e no celular, só o logo e o
 * chat, e a navegação vai para a barra inferior (Início, Pesquisa,
 * Comunidades, Avisos e Você). O que muda por faixa é CSS (layout.css); aqui
 * só se monta tudo uma vez.
 *
 * Regra de sempre: dado da API entra por textContent/atributo, nunca por
 * innerHTML (ver dom.ts).
 */
import { api, getMe, getToken, logout, type Me } from "./api.js";
import { THEME_LABELS, getThemePref, onThemeChange, setThemePref, type ThemePref } from "./theme.js";
import { communityUrl, loginUrlReturningHere, pages } from "./pages.js";
import { avatarColor, initials } from "./dom.js";
import { initHeaderDropdowns } from "./header-dropdowns.js";
import { initSidebar } from "./sidebar.js";
import { createNotificationBell, onUnreadChange } from "./notifications.js";
import { trapFocus } from "./focus-trap.js";

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
     * Links próprios da página, logo abaixo de "Página inicial". A comunidade
     * usa para Discussões/Regras/Membros/Eventos/Suporte.
     */
    pageLinks?: SidebarLink[];
    /**
     * Página de pesquisa: no tablet e no celular o campo de busca fica no
     * lugar do logo (lá não há busca no header; ela é esta página).
     */
    pesquisa?: boolean;
}

// ===========================================================================
// Ícones de traço (desenho fixo, sem dado: pode ir por innerHTML)
// ===========================================================================

const svg = (paths: string): string =>
    `<svg class="r-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICONS = {
    menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    chevron: svg('<path d="M6 9l6 6 6-6"/>'),
    bell: svg('<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'),
    chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
    home: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
    search: svg('<circle cx="10" cy="10" r="6"/><path d="M15 15l6 6"/>'),
    communities: svg(
        '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/>' +
            '<circle cx="17" cy="9" r="2.5"/><path d="M16 14c2.8 0 5 2 5 5"/>',
    ),
    you: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5c1.5-2 3.3-3 5.5-3s4 1 5.5 3"/>'),
    login: svg('<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    // Post (post-thread.ts), lightbox e paginação da pesquisa.
    dots: svg('<path d="M5 12h.01M12 12h.01M19 12h.01"/>').replace('class="r-ico"', 'class="r-ico r-ico--dots"'),
    comment: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
    bookmark: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
    link: svg(
        '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/>' +
            '<path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    ),
    prev: svg('<path d="M15 6l-6 6 6 6"/>'),
    next: svg('<path d="M9 6l6 6-6 6"/>'),
};

// ===========================================================================
// Header
// ===========================================================================

// Markup fixo (sem dado de usuário): pode ir por innerHTML. Os ids são os que
// o header-dropdowns.ts, o sidebar.ts e o chat-widget.ts procuram.
const HEADER_HTML = `
    <button type="button" class="fx-btn fx-btn--icon r-menu-btn" id="sidebarToggle" data-sidebar-toggle
            aria-controls="app-sidebar" aria-expanded="false" aria-label="Abrir menu lateral">${ICONS.menu}</button>

    <a class="r-logo" data-nav="home" aria-label="FAMAX — página inicial">FAMAX</a>

    <form class="r-search" id="searchForm" role="search">
        <div class="r-scope">
            <button type="button" class="r-scope-btn" id="searchScopeBtn" aria-haspopup="menu"
                    aria-expanded="false" aria-controls="searchScopeMenu" aria-label="Pesquisar em: Tudo">
                <span id="searchScopeLabel">Tudo</span>${ICONS.chevron}
            </button>
            <input type="search" id="searchInput" class="fx-search" placeholder="Pesquisar"
                   autocomplete="off" maxlength="80" aria-label="Pesquisar"
                   role="combobox" aria-autocomplete="list" aria-expanded="false"
                   aria-controls="searchSuggestions">
        </div>
        <!-- O escopo (Tudo, Comunidades, Usuários, Posts) é montado pelo header-dropdowns.ts. -->
        <div class="fx-menu r-scope-menu" id="searchScopeMenu" role="menu" aria-label="Pesquisar em" hidden></div>
        <div class="fx-menu" id="searchSuggestions" role="listbox" aria-label="Sugestões"></div>
    </form>

    <div class="header-actions">
        <!-- Sino (com sessão) e ícone do chat (chat-widget.ts), nesta ordem, antes do avatar. -->
        <span class="r-slot" id="headerBellSlot"></span>
        <span class="r-slot" id="headerChatSlot"></span>
        <div class="user-area" id="userArea"></div>
    </div>
`;

export function el<K extends keyof HTMLElementTagNameMap>(
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
    document.getElementById("headerBellSlot")?.replaceChildren();

    const login = el("a", "fx-btn fx-btn--on-chrome-outline", "Entrar");
    login.href = loginUrlReturningHere();

    // No tablet e no celular só "Entrar": "Criar conta" passava da borda (CSS).
    const register = el("a", "fx-btn fx-btn--on-chrome r-guest-wide", "Criar conta");
    register.href = pages.register;

    area.append(login, register);
}

/** Círculo do avatar: a foto, ou as iniciais na cor estável do usuário. */
function renderAvatar(me: Me): HTMLElement {
    if (me.avatarUrl) {
        const img = el("img", "fx-avatar fx-avatar--md");
        img.src = me.avatarUrl;
        img.alt = "";
        return img;
    }
    const name = me.displayName ?? me.username;
    return el("span", `fx-avatar fx-avatar--md ${avatarColor(me.userId)}`, initials(name));
}

// ----- Itens do menu do usuário (lista no header e folha na barra) ---------

/**
 * Os itens do menu do usuário. O header (lista suspensa) e a folha inferior
 * do tablet e do celular montam a partir daqui, para nunca divergirem.
 */
function userMenuItems(me: Me): HTMLElement[] {
    const profile = el("a", "fx-menu-item", "Meu perfil");
    profile.href = pages.profile;
    const settings = el("a", "fx-menu-item", "Configurações");
    settings.href = pages.settings;
    const links: HTMLElement[] = [profile, settings];
    if (me.isAdmin) {
        const admin = el("a", "fx-menu-item", "Denúncias de usuários");
        admin.href = pages.adminReports;
        links.push(admin);
    }
    for (const link of links) link.setAttribute("role", "menuitem");

    // Tema: escolha manual (fica neste navegador) ou o do sistema.
    const themeGroup = el("div");
    themeGroup.setAttribute("role", "group");
    themeGroup.setAttribute("aria-label", "Tema");
    themeGroup.append(el("span", "fx-menu-label", "Tema"));
    for (const pref of Object.keys(THEME_LABELS) as ThemePref[]) {
        const option = el("button", "fx-menu-item", THEME_LABELS[pref]);
        option.type = "button";
        option.setAttribute("role", "menuitemradio");
        // data-theme-pref, não data-theme: [data-theme="light"] no tokens.css
        // aplicaria o tema claro dentro do próprio botão.
        option.dataset.themePref = pref;
        option.setAttribute("aria-checked", String(getThemePref() === pref));
        option.addEventListener("click", () => setThemePref(pref));
        themeGroup.append(option);
    }

    const signOut = el("button", "fx-menu-item", "Sair");
    signOut.type = "button";
    signOut.setAttribute("role", "menuitem");
    signOut.addEventListener("click", () => {
        signOut.disabled = true;
        void logout();
    });

    return [...links, el("div", "fx-menu-sep"), themeGroup, el("div", "fx-menu-sep"), signOut];
}

// O ✓ do tema acompanha a escolha em todas as listas abertas (menu e folha).
onThemeChange((pref) => {
    document.querySelectorAll<HTMLElement>("[data-theme-pref]").forEach((option) => {
        option.setAttribute("aria-checked", String(option.dataset.themePref === pref));
    });
});

/** Uma instância por página: o header redesenha, o sininho (e o polling) fica. */
let notificationBell: HTMLElement | null = null;
/** O menu da área do usuário: o último desenhado (updateHeaderUser redesenha). */
let userMenu: { wrapper: HTMLElement; setOpen: (open: boolean) => void } | null = null;
/** Quem está logado, para a folha da barra ("Você"). */
let currentMe: Me | null = null;

function renderUserArea(area: HTMLElement, me: Me): void {
    currentMe = me;
    area.replaceChildren();
    notificationBell ??= createNotificationBell();
    document.getElementById("headerBellSlot")?.replaceChildren(notificationBell);

    const wrapper = el("div", "user-menu");
    const name = me.displayName ?? me.username;

    const button = el("button", "fx-user");
    button.type = "button";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `Menu do usuário: ${name}`);
    // O nome só aparece a partir de 1280px (CSS); o rótulo acima vale sempre.
    button.append(renderAvatar(me), el("span", "user-name", name));

    const dropdown = el("div", "fx-menu");
    dropdown.setAttribute("role", "menu");
    dropdown.setAttribute("aria-label", "Menu do usuário");
    dropdown.hidden = true;
    dropdown.append(...userMenuItems(me));

    wrapper.append(button, dropdown);
    area.append(wrapper);

    const setOpen = (open: boolean): void => {
        dropdown.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(dropdown.hidden);
    });
    userMenu = { wrapper, setOpen };
    syncBarUser();
}

// Clique fora e Esc fecham o menu do usuário (uma vez só: o menu redesenha).
document.addEventListener("click", (event) => {
    if (userMenu && event.target instanceof Node && !userMenu.wrapper.contains(event.target)) userMenu.setOpen(false);
});
document.addEventListener("keydown", (event) => {
    const menu = userMenu?.wrapper.querySelector<HTMLElement>('[role="menu"]');
    if (event.key === "Escape" && menu && !menu.hidden) {
        userMenu?.setOpen(false);
        userMenu?.wrapper.querySelector<HTMLButtonElement>(".fx-user")?.focus();
    }
});

let userAreaEl: HTMLElement | null = null;

/**
 * Redesenha nome e avatar do header. A tela de configurações chama depois de
 * salvar, para a mudança aparecer sem recarregar a página.
 */
export function updateHeaderUser(me: Me): void {
    if (userAreaEl) renderUserArea(userAreaEl, me);
}

/**
 * Faixa no topo do conteúdo enquanto o e-mail não foi confirmado: sem ele não
 * dá para criar comunidade nem mandar mensagem (middleware/verified-email.ts).
 * Some na página de verificação, que já trata do assunto.
 */
function renderVerifyBanner(me: Me): void {
    const main = document.getElementById("main-content");
    document.getElementById("verifyBanner")?.remove();
    if (!main || me.emailVerified || window.location.pathname === pages.verifyEmail) return;

    const banner = el("div", "fx-banner fx-banner--warning");
    banner.id = "verifyBanner";
    banner.setAttribute("role", "status");
    const text = el("span", "fx-banner-text");
    text.append("Confirme seu e-mail ", el("strong", "", me.email), " para criar comunidades e mandar mensagens.");
    const resend = el("button", "fx-btn fx-btn--sm", "Reenviar link");
    resend.type = "button";
    const settings = el("a", "fx-banner-link", "Trocar e-mail");
    settings.href = pages.settings;
    banner.append(text, resend, settings);

    resend.addEventListener("click", async () => {
        resend.disabled = true;
        try {
            const { message } = await api.auth.resendVerification();
            text.textContent = message;
        } catch (err) {
            text.textContent = err instanceof Error ? err.message : "Não foi possível reenviar.";
            resend.disabled = false;
        }
    });
    main.prepend(banner);
}

function renderHeader(header: HTMLElement, options: LayoutOptions): void {
    header.innerHTML = HEADER_HTML;
    header.classList.toggle("header--pesquisa", Boolean(options.pesquisa));

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
    area.replaceChildren(el("span", "fx-avatar fx-avatar--md fx-avatar--loading"));
    area.setAttribute("aria-busy", "true");

    getMe()
        .then((me) => {
            renderUserArea(area, me);
            renderVerifyBanner(me);
        })
        .catch(() => {
            // 401: o api() já limpou o token (e redireciona se a página exige
            // login). Erro de rede: melhor mostrar "Entrar" do que um vazio.
            renderGuestArea(area);
            renderBottomBar(false);
        })
        .finally(() => area.removeAttribute("aria-busy"));
}

/**
 * Tablet e celular: o header some ao rolar para baixo e volta ao rolar para
 * cima; só a barra inferior fica fixa. Não some com menu, gaveta ou chat
 * abertos (eles se ancoram nele).
 */
function initHideOnScroll(): void {
    const comBarra = window.matchMedia("(max-width: 1023px)");
    const root = document.documentElement;
    let ultimoY = window.scrollY;

    const algoAberto = (): boolean =>
        document.body.classList.contains("sidebar-is-open") ||
        document.body.classList.contains("chat-is-open") ||
        Boolean(document.querySelector('#app-header [aria-expanded="true"], .r-sheet'));

    window.addEventListener(
        "scroll",
        () => {
            const y = window.scrollY;
            const esconder = comBarra.matches && !algoAberto() && y > ultimoY && y > 56;
            root.classList.toggle("r--hide-header", esconder);
            ultimoY = y;
        },
        { passive: true },
    );
    comBarra.addEventListener("change", () => root.classList.remove("r--hide-header"));
}

// ===========================================================================
// Barra inferior (tablet e celular) e folha do menu do usuário
// ===========================================================================

let barYou: HTMLButtonElement | null = null;

/** Página atual: o item da barra com o mesmo caminho leva aria-current. */
function barLink(href: string, label: string, icon: string): HTMLAnchorElement {
    const link = el("a", "r-bar-item");
    link.href = href;
    link.innerHTML = icon; // ícone fixo, sem dado
    link.append(el("span", "r-bar-label", label));
    if (new URL(href, window.location.href).pathname === window.location.pathname) {
        link.setAttribute("aria-current", "page");
    }
    return link;
}

function barButton(label: string, icon: string): HTMLButtonElement {
    const button = el("button", "r-bar-item");
    button.type = "button";
    button.innerHTML = icon;
    button.append(el("span", "r-bar-label", label));
    return button;
}

/**
 * A barra fica no fim do <body>; o CSS a esconde a partir de 1024px. Uma
 * página pede a tela sem barra com class="r--nobar" no <body>.
 */
function renderBottomBar(session: boolean): void {
    document.querySelector(".r-bar")?.remove();
    barYou = null;
    if (document.body.classList.contains("r--nobar")) return;

    const nav = el("nav", "r-bar");
    nav.setAttribute("aria-label", "Navegação principal");
    nav.append(barLink(pages.home, "Início", ICONS.home), barLink(pages.search, "Pesquisa", ICONS.search));

    if (!session) {
        nav.append(barLink(loginUrlReturningHere(), "Entrar", ICONS.login));
        document.body.append(nav);
        return;
    }

    // "Comunidades" abre a gaveta: o sidebar.ts trata todo [data-sidebar-toggle].
    const communities = barButton("Comunidades", ICONS.communities);
    communities.dataset.sidebarToggle = "";
    communities.setAttribute("aria-controls", "app-sidebar");
    communities.setAttribute("aria-expanded", "false");

    const alerts = barLink(pages.notifications, "Avisos", "");
    const badged = el("span", "r-badged");
    badged.innerHTML = ICONS.bell;
    const count = el("span", "fx-counter-badge");
    count.setAttribute("aria-hidden", "true");
    count.hidden = true;
    badged.append(count);
    alerts.prepend(badged);
    alerts.setAttribute("aria-label", "Avisos");
    onUnreadChange((n) => {
        count.hidden = n === 0;
        count.textContent = n > 99 ? "99+" : String(n);
        alerts.setAttribute("aria-label", n > 0 ? `Avisos, ${n} ${n === 1 ? "não lido" : "não lidos"}` : "Avisos");
    });

    barYou = barButton("Você", ICONS.you);
    barYou.setAttribute("aria-haspopup", "dialog");
    barYou.setAttribute("aria-expanded", "false");
    // Até o /me chegar não há o que mostrar na folha.
    barYou.disabled = !currentMe;
    barYou.addEventListener("click", () => openUserSheet());

    nav.append(communities, alerts, barYou);
    document.body.append(nav);
}

/** "Você" só abre a folha depois que o /me chegou. */
function syncBarUser(): void {
    if (barYou) barYou.disabled = false;
}

export interface SheetOptions {
    /** Nome da folha (aria-label) e do menu dentro dela. */
    label: string;
    menuLabel: string;
    /** O que vai no topo, antes do ✕ (avatar e nome, ou só o título). */
    head: Node[];
    items: Node[];
    /** Botão que abriu: ganha aria-expanded enquanto a folha está aberta. */
    opener?: HTMLElement | null;
    onClose?: () => void;
}

/**
 * Menu numa folha inferior (tablet e celular): o menu do usuário ("Você") e
 * o ⋯ do post aberto. Esc, ✕ e o véu fecham; o foco fica preso dentro e volta
 * para quem abriu. Ao passar para 1024px ou mais, a folha some: lá o mesmo
 * menu é uma lista. Devolve a função que fecha.
 */
export function openSheet(options: SheetOptions): () => void {
    const veil = el("div", "r-veil r-veil--all");
    const sheet = el("section", "r-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", options.label);

    const head = el("div", "r-sheet-head");
    const close = el("button", "fx-btn fx-btn--icon fx-btn--icon-paper");
    close.type = "button";
    close.setAttribute("aria-label", "Fechar menu");
    close.innerHTML = ICONS.close;
    head.append(...options.head, close);

    const menu = el("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", options.menuLabel);
    menu.append(...options.items);

    const grip = el("div", "r-sheet-grip");
    grip.setAttribute("aria-hidden", "true");
    sheet.append(grip, head, menu);
    document.body.append(veil, sheet);
    options.opener?.setAttribute("aria-expanded", "true");

    const desktop = window.matchMedia("(min-width: 1024px)");
    let open = true;
    const dismiss = (): void => {
        if (!open) return;
        open = false;
        desktop.removeEventListener("change", onChange);
        veil.remove();
        sheet.remove();
        options.opener?.setAttribute("aria-expanded", "false");
        release();
        options.onClose?.();
    };
    const onChange = (): void => {
        if (desktop.matches) dismiss();
    };
    desktop.addEventListener("change", onChange);

    const release = trapFocus(sheet, { onEscape: dismiss, initialFocus: close });
    close.addEventListener("click", dismiss);
    veil.addEventListener("click", dismiss);
    return dismiss;
}

let closeUserSheet: (() => void) | null = null;

/** "Você", no tablet e no celular: o menu do usuário, com o avatar e o nome no topo. */
function openUserSheet(): void {
    const me = currentMe;
    if (!me || closeUserSheet) return;
    closeUserSheet = openSheet({
        label: "Menu do usuário",
        menuLabel: "Opções da conta",
        head: [renderAvatar(me), el("span", "r-sheet-name", me.displayName ?? me.username)],
        items: userMenuItems(me),
        opener: barYou,
        onClose: () => {
            closeUserSheet = null;
        },
    });
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
        const { data } = await api.me.communities();

        if (data.length === 0) {
            container.replaceChildren(
                sidebarStatus("Você ainda não participa de nenhuma comunidade."),
            );
            return;
        }

        container.replaceChildren(
            ...data.map((c) => sidebarLink(c.name, communityUrl(c.communityId))),
        );
    } catch {
        // Sidebar é acessório; a página continua utilizável sem ela.
        container.replaceChildren(sidebarStatus("Não foi possível carregar."));
    }
}

function renderSidebar(sidebar: HTMLElement, options: LayoutOptions): void {
    const home = el("div", "sidebar-header");
    home.append(sidebarLink("Página inicial", pages.home));

    const pageLinks = (options.pageLinks ?? []).map((link) => {
        if (!link.href) {
            // Recurso que ainda não existe: visível, mas sem fingir que é link.
            const disabled = el("span", "sidebar-link sidebar-link--disabled");
            disabled.setAttribute("aria-disabled", "true");
            disabled.append(link.label, el("span", "fx-badge fx-badge--outline", "Em breve"));
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

    // Quem abre a gaveta é o ☰ do header e "Comunidades" na barra inferior.
    sidebar.replaceChildren(home, ...pageLinks, create, title, myCommunitiesEl);

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
 * Monta header, gaveta e barra inferior e liga os comportamentos (busca,
 * gaveta, header que some ao rolar). Chamar uma vez, no topo do script da
 * página.
 */
export function initLayout(options: LayoutOptions = {}): void {
    const header = document.getElementById("app-header");
    const sidebar = document.getElementById("app-sidebar");

    if (header) renderHeader(header, options);
    if (sidebar) renderSidebar(sidebar, options);
    renderBottomBar(Boolean(getToken()));
    addSkipLink();

    initHeaderDropdowns();
    initSidebar();
    initHideOnScroll();
}

/**
 * "Pular para o conteúdo": primeiro item do Tab, aparece só com foco. Sem ele,
 * quem navega por teclado atravessa header e sidebar inteiros em toda página.
 */
function addSkipLink(): void {
    const main = document.querySelector<HTMLElement>("main");
    if (!main || document.querySelector(".skip-link")) return;
    if (!main.id) main.id = "main-content";
    if (!main.hasAttribute("tabindex")) main.tabIndex = -1; // recebe o foco do link
    const link = el("a", "skip-link", "Pular para o conteúdo");
    link.href = `#${main.id}`;
    document.body.prepend(link);
}
