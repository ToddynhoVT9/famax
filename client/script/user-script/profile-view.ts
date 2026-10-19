/**
 * FAMAX — Perfil (próprio ou de outra pessoa)
 *
 * ?id=<userId> mostra o perfil daquela pessoa; sem id, o próprio (exige
 * login). Antes a página era estática e "ver outro perfil" era simulado por
 * ?view=other&name=, com o nome tirado da URL — agora tudo vem de
 * GET /api/users/:id, e a privacidade é decidida no servidor.
 *
 * Abas: Posts e Respostas, com "Carregar mais". A aba "Recursos" do protótipo
 * foi removida: não há nada no modelo de dados que a sustente, e uma aba que
 * só diz "em breve" é um clique sem saída.
 */
import { api, getMe, getToken, type SocialLink } from "../shared/api.js";
import { requireLogin } from "../shared/auth-guard.js";
import { initLayout } from "../shared/layout.js";
import { communityUrl, pages } from "../shared/pages.js";
import { avatarColor, initials, queryParam, timeAgo, truncate } from "../shared/dom.js";
import { SOCIAL_PLATFORM_LABELS, isSafeLink } from "../shared/social.js";
import { openReportDialog } from "../shared/moderation.js";

// Visitante pode ver o perfil público de alguém; o próprio perfil exige conta.
const requestedId = queryParam("id");
if (!requestedId) requireLogin();
initLayout();

// ===========================================================================
// Tipos
// ===========================================================================

interface PublicProfile {
    userId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    isPrivate: boolean;
    isOwner: boolean;
    // Ausentes quando o perfil é privado e quem vê não é o dono.
    nickname?: string | null;
    bannerUrl?: string | null;
    bio?: string | null;
    createdAt?: string;
    stats?: { posts: number; comments: number; communities: number };
    socialLinks?: SocialLink[];
}

interface ProfilePost {
    post_id: string;
    title: string;
    content: string;
    likes_count: number;
    comments_count: number;
    created_at: string;
    community_id: string;
    community_name: string;
}

interface ProfileComment {
    comment_id: string;
    content: string;
    created_at: string;
    post_id: string;
    post_title: string;
    community_id: string;
    community_name: string;
}

interface Page<T> {
    data: T[];
    pagination: { page: number; totalPages: number; total: number };
}

// ===========================================================================
// Elementos
// ===========================================================================

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const container = $("profileContainer");
const bannerEl = $("profileBanner");
const avatarEl = $("profileAvatar");
const editBtn = $<HTMLAnchorElement>("btnEditProfile");
const nameEl = $("profileName");
const padlockEl = $("privatePadlockProfile");
const usernameEl = $("profileUsername");
const bioEl = $("profileBio");
const joinedEl = $("profileJoined");
const socialEl = $("profileSocial");
const statsEl = $("profileStats");
const privateNotice = $("privateNotice");
const tabsEl = $("profileTabs");
const feedEl = $("profileFeed");
const feedList = $("profileFeedList");
const feedStatus = $("profileFeedStatus");
const loadMoreBtn = $<HTMLButtonElement>("btnLoadMore");

// ===========================================================================
// Cabeçalho do perfil
// ===========================================================================

function renderAvatar(profile: PublicProfile): void {
    if (!avatarEl) return;
    avatarEl.replaceChildren();
    avatarEl.className = "profile-picture";

    if (profile.avatarUrl) {
        const img = document.createElement("img");
        img.src = profile.avatarUrl;
        img.alt = "";
        avatarEl.append(img);
        return;
    }

    // Sem foto: iniciais na mesma cor estável do header e dos posts. Num
    // elemento interno porque .profile-picture já tem cor de fundo própria.
    const fallback = document.createElement("span");
    fallback.className = `profile-initials ${avatarColor(profile.userId)}`;
    fallback.textContent = initials(profile.displayName ?? profile.username);
    avatarEl.append(fallback);
}

function renderSocialLinks(links: SocialLink[]): void {
    if (!socialEl) return;
    const items = links.filter((link) => isSafeLink(link.url)).map((link) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = link.url;
        a.target = "_blank";
        // noopener: a página aberta não ganha acesso a esta; nofollow: o
        // fórum não endossa links de usuários para buscadores.
        a.rel = "noopener noreferrer nofollow";
        a.textContent = SOCIAL_PLATFORM_LABELS[link.platform] ?? link.platform;
        a.title = link.url;
        li.append(a);
        return li;
    });
    socialEl.replaceChildren(...items);
    socialEl.hidden = items.length === 0;
}

function renderStats(stats: NonNullable<PublicProfile["stats"]>): void {
    if (!statsEl) return;
    const entries: Array<[number, string, string]> = [
        [stats.posts, "post", "posts"],
        [stats.comments, "resposta", "respostas"],
        [stats.communities, "comunidade", "comunidades"],
    ];
    statsEl.replaceChildren(
        ...entries.map(([count, one, many]) => {
            const span = document.createElement("span");
            const strong = document.createElement("strong");
            strong.textContent = String(count);
            span.append(strong, ` ${count === 1 ? one : many}`);
            return span;
        }),
    );
    statsEl.hidden = false;
}

function renderProfile(profile: PublicProfile): void {
    const name = profile.displayName ?? profile.username;
    document.title = `FAMAX - ${name}`;

    if (nameEl) {
        nameEl.textContent = name;
        nameEl.classList.remove("skeleton-text");
    }
    if (usernameEl) usernameEl.textContent = `@${profile.username}`;
    if (padlockEl) padlockEl.hidden = !profile.isPrivate;
    renderAvatar(profile);

    if (editBtn) {
        editBtn.href = pages.settings;
        editBtn.hidden = !profile.isOwner;
    }
    setupReportMenu(profile);

    const canView = profile.stats !== undefined;
    if (!canView) {
        if (privateNotice) privateNotice.hidden = false;
        return;
    }

    if (bannerEl && profile.bannerUrl) {
        // CSS.escape não serve para URL; JSON.stringify gera uma string CSS
        // válida com as aspas e barras escapadas.
        bannerEl.style.backgroundImage = `url(${JSON.stringify(profile.bannerUrl)})`;
        bannerEl.classList.add("has-image");
    }

    if (bioEl) {
        bioEl.textContent = profile.bio ?? "";
        bioEl.hidden = !profile.bio;
    }

    if (joinedEl && profile.createdAt) {
        const since = new Date(profile.createdAt).toLocaleDateString("pt-BR", {
            month: "long",
            year: "numeric",
        });
        joinedEl.textContent = `Membro desde ${since}`;
        joinedEl.hidden = false;
    }

    renderSocialLinks(profile.socialLinks ?? []);
    if (profile.stats) renderStats(profile.stats);

    if (tabsEl) tabsEl.hidden = false;
    if (feedEl) feedEl.hidden = false;
    void loadTab("posts", true);
}

// ===========================================================================
// Abas: Posts e Respostas
// ===========================================================================

type Tab = "posts" | "comments";

let profileUserId = "";
let isOwnProfile = false;
let currentTab: Tab = "posts";
let currentPage = 0;
// Descarta respostas de uma aba que o usuário já deixou para trás.
let requestSeq = 0;

function itemMeta(communityId: string, communityName: string, createdAt: string): HTMLElement {
    const meta = document.createElement("div");
    meta.className = "profile-item-meta";
    const link = document.createElement("a");
    link.href = communityUrl(communityId);
    link.textContent = communityName;
    meta.append(link, ` • ${timeAgo(createdAt)}`);
    return meta;
}

function renderPostItem(post: ProfilePost): HTMLElement {
    const item = document.createElement("article");
    item.className = "profile-item";

    // Ainda não há página de post (prompt 07): o título leva à comunidade.
    const title = document.createElement("a");
    title.className = "profile-item-title";
    title.href = communityUrl(post.community_id);
    title.textContent = post.title;

    const snippet = document.createElement("p");
    snippet.className = "profile-item-snippet";
    snippet.textContent = truncate(post.content, 220);

    const stats = document.createElement("div");
    stats.className = "profile-item-stats";
    stats.textContent = `👍 ${post.likes_count}  💬 ${post.comments_count}`;

    item.append(itemMeta(post.community_id, post.community_name, post.created_at), title, snippet, stats);
    return item;
}

function renderCommentItem(comment: ProfileComment): HTMLElement {
    const item = document.createElement("article");
    item.className = "profile-item";

    const context = document.createElement("div");
    context.className = "profile-item-context";
    const postLink = document.createElement("a");
    postLink.href = communityUrl(comment.community_id);
    postLink.textContent = comment.post_title;
    context.append("Em resposta a ", postLink);

    const content = document.createElement("p");
    content.className = "profile-item-snippet";
    content.textContent = truncate(comment.content, 300);

    item.append(itemMeta(comment.community_id, comment.community_name, comment.created_at), context, content);
    return item;
}

function setStatus(text: string | null): void {
    if (!feedStatus) return;
    feedStatus.textContent = text ?? "";
    feedStatus.hidden = text === null;
}

function emptyMessage(tab: Tab): string {
    if (tab === "posts") {
        return isOwnProfile ? "Você ainda não publicou nenhum post." : "Nenhum post ainda.";
    }
    return isOwnProfile ? "Você ainda não respondeu nenhuma discussão." : "Nenhuma resposta ainda.";
}

async function loadTab(tab: Tab, reset: boolean): Promise<void> {
    if (!feedList || !loadMoreBtn) return;

    const seq = ++requestSeq;
    if (reset) {
        currentTab = tab;
        currentPage = 0;
        feedList.replaceChildren();
        loadMoreBtn.hidden = true;
        setStatus("Carregando...");
    }
    loadMoreBtn.disabled = true;

    const nextPage = currentPage + 1;
    try {
        const path = `/users/${encodeURIComponent(profileUserId)}/${tab}?page=${nextPage}&limit=10`;
        const result =
            tab === "posts"
                ? await api<Page<ProfilePost>>(path)
                : await api<Page<ProfileComment>>(path);
        if (seq !== requestSeq) return;

        currentPage = nextPage;
        const nodes =
            tab === "posts"
                ? (result.data as ProfilePost[]).map(renderPostItem)
                : (result.data as ProfileComment[]).map(renderCommentItem);
        feedList.append(...nodes);

        setStatus(feedList.childElementCount === 0 ? emptyMessage(tab) : null);
        loadMoreBtn.hidden = currentPage >= result.pagination.totalPages;
    } catch (err) {
        if (seq !== requestSeq) return;
        setStatus(err instanceof Error ? `Não foi possível carregar: ${err.message}` : "Não foi possível carregar.");
    } finally {
        if (seq === requestSeq) loadMoreBtn.disabled = false;
    }
}

tabsEl?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".tab-btn");
    const tab = button?.dataset.tab as Tab | undefined;
    if (!button || !tab || tab === currentTab) return;

    tabsEl.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((b) => {
        const active = b === button;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
    });
    void loadTab(tab, true);
});

loadMoreBtn?.addEventListener("click", () => {
    void loadTab(currentTab, false);
});

// ===========================================================================
// Início
// ===========================================================================

function showFatal(message: string): void {
    if (nameEl) {
        nameEl.textContent = message;
        nameEl.classList.remove("skeleton-text");
    }
    if (usernameEl) usernameEl.textContent = "";
}

async function init(): Promise<void> {
    let userId = requestedId;
    if (!userId) {
        if (!getToken()) return; // requireLogin já está redirecionando
        try {
            userId = (await getMe()).userId;
        } catch {
            return; // 401: o api() redireciona para o login
        }
    }
    profileUserId = userId;

    try {
        const { user } = await api<{ user: PublicProfile }>(`/users/${encodeURIComponent(userId)}`);
        isOwnProfile = user.isOwner;
        renderProfile(user);
    } catch (err) {
        showFatal(err instanceof Error ? err.message : "Não foi possível carregar o perfil.");
    } finally {
        container?.removeAttribute("aria-busy");
    }
}

void init();

// ===========================================================================
// "⋯" com Denunciar (perfil de outra pessoa, com sessão)
// ===========================================================================

function setupReportMenu(profile: PublicProfile): void {
    const wrapper = document.getElementById("profileMore");
    const button = document.getElementById("profileMoreBtn");
    const menu = document.getElementById("profileMoreMenu");
    const report = document.getElementById("btnReportUser");
    if (!wrapper || !button || !menu || !report) return;

    wrapper.hidden = profile.isOwner || !getToken();
    if (wrapper.hidden || wrapper.dataset.ready) return;
    wrapper.dataset.ready = "true";

    const setOpen = (open: boolean): void => {
        menu.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(menu.hidden);
    });
    document.addEventListener("click", (event) => {
        if (!wrapper.contains(event.target as Node)) setOpen(false);
    });
    report.addEventListener("click", () => {
        setOpen(false);
        void openReportDialog("user", profile.userId);
    });
}
