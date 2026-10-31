/**
 * FAMAX — Perfil (próprio ou de outra pessoa)
 *
 * ?id=<userId> mostra o perfil daquela pessoa; ?u=<username> também (é o link
 * das menções @username no texto, resolvido por GET /users/by-username);
 * sem nenhum dos dois, o próprio (exige login). Antes a página era estática e "ver outro perfil" era simulado por
 * ?view=other&name=, com o nome tirado da URL — agora tudo vem de
 * GET /api/users/:id, e a privacidade é decidida no servidor.
 *
 * Abas: Posts e Respostas, com "Carregar mais"; no próprio perfil, também
 * Salvos (GET /me/saved — privada, só o dono vê). A aba "Recursos" do protótipo
 * foi removida: não há nada no modelo de dados que a sustente, e uma aba que
 * só diz "em breve" é um clique sem saída.
 *
 * Desenho: ProfileHeader (capa, foto metade sobre a capa e as ações à direita
 * da foto) em 1080, e a lista em 760 (profile-view.css). No celular as ações
 * descem para uma linha própria, abaixo do nome.
 */
import { api, getMe, getToken, type SocialLink } from "../shared/api.js";
import { requireLogin } from "../shared/auth-guard.js";
import { initLayout } from "../shared/layout.js";
import { communityUrl, pages, postUrl } from "../shared/pages.js";
import { avatarColor, initials, queryParam, timeAgo, truncate } from "../shared/dom.js";
import { SOCIAL_PLATFORM_LABELS, isSafeLink } from "../shared/social.js";
import { openReportDialog } from "../shared/moderation.js";
import { confirmDialog, toast } from "../shared/dialog.js";
import { bindFollowButton, openFollowList } from "../shared/follow.js";
import { markdownToText } from "../shared/markdown.js";
import { openChatWith } from "../shared/chat-bus.js";
import { skeleton } from "../shared/skeleton.js";
import { bindTabKeys } from "../shared/tabs.js";
import { ICONS } from "../shared/icons.js";
import type { Page } from "../../../shared/api-types.js";
import type { ProfileComment, ProfilePost, PublicProfile } from "../../../shared/api-types.js";

// Visitante pode ver o perfil público de alguém; o próprio perfil exige conta.
const requestedId = queryParam("id");
const requestedUsername = queryParam("u");
if (!requestedId && !requestedUsername) requireLogin();
initLayout();

// ===========================================================================
// Tipos
// ===========================================================================

// ===========================================================================
// Elementos
// ===========================================================================

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const container = $("profileContainer");
const bannerEl = $("profileBanner");
const avatarEl = $("profileAvatar");
const editBtn = $<HTMLAnchorElement>("btnEditProfile");
const nameEl = $("profileNameText");
const padlockEl = $("privatePadlockProfile");
const usernameEl = $("profileUsername");
const bioEl = $("profileBio");
const joinedEl = $("profileJoined");
const socialEl = $("profileSocial");
const statsEl = $("profileStats");
const privateNotice = $("privateNotice");
const tabsEl = $("profileTabs");
const tabsBar = $("profileTabsBar");
const feedEl = $("profileFeed");
const feedList = $("profileFeedList");
const feedStatus = $("profileFeedStatus");
const loadMoreBtn = $<HTMLButtonElement>("btnLoadMore");

// ===========================================================================
// Ações: à direita da foto; no celular, numa linha abaixo do nome
// ===========================================================================

const actionsEl = $("profileActions");
const phone = window.matchMedia("(max-width: 599px)");
function placeActions(): void {
    const slot = phone.matches ? $("profileActionsPhone") : $("profileBar");
    if (actionsEl && slot && actionsEl.parentElement !== slot) slot.append(actionsEl);
}
placeActions();
phone.addEventListener("change", placeActions);

const moreBtn = $("profileMoreBtn");
if (moreBtn) moreBtn.innerHTML = ICONS.dots; // ícone fixo, sem dado

// ===========================================================================
// Cabeçalho do perfil
// ===========================================================================

function renderAvatar(profile: PublicProfile): void {
    if (!avatarEl) return;
    avatarEl.replaceChildren();
    avatarEl.className = "fx-avatar pv-pic";

    if (profile.avatarUrl) {
        const img = document.createElement("img");
        img.src = profile.avatarUrl;
        img.alt = "";
        avatarEl.append(img);
        return;
    }

    // Sem foto: iniciais na mesma cor estável do header e dos posts.
    avatarEl.classList.add(avatarColor(profile.userId));
    avatarEl.textContent = initials(profile.displayName ?? profile.username);
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

function statNode(count: number, one: string, many: string, tag: "span" | "button" = "span"): HTMLElement {
    const node = document.createElement(tag);
    const strong = document.createElement("strong");
    strong.textContent = String(count);
    const label = document.createElement("span");
    label.textContent = ` ${count === 1 ? one : many}`;
    node.append(strong, label);
    return node;
}

function renderStats(profile: PublicProfile): void {
    const stats = profile.stats;
    if (!statsEl || !stats) return;
    const name = profile.displayName ?? profile.username;

    // Seguidores e Seguindo abrem a lista num diálogo.
    const followList = (count: number, one: string, many: string, kind: "followers" | "following") => {
        const button = statNode(count, one, many, "button") as HTMLButtonElement;
        button.type = "button";
        button.className = "fx-stat-link";
        button.dataset.stat = kind;
        button.addEventListener("click", () => openFollowList(profile.userId, kind, name));
        return button;
    };

    statsEl.replaceChildren(
        followList(stats.followers, "seguidor", "seguidores", "followers"),
        followList(stats.following, "seguindo", "seguindo", "following"),
        statNode(stats.posts, "post", "posts"),
        statNode(stats.comments, "resposta", "respostas"),
        statNode(stats.communities, "comunidade", "comunidades"),
    );
    statsEl.hidden = false;
}

/** Atualiza o "N seguidores" depois de seguir / deixar de seguir. */
function updateFollowersCount(count: number): void {
    const stat = statsEl?.querySelector('[data-stat="followers"]');
    if (stat) stat.replaceChildren(...statNode(count, "seguidor", "seguidores").childNodes);
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
    setupFollowButton(profile);

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
    renderStats(profile);

    if (tabsBar) tabsBar.hidden = false;
    const savedTab = document.getElementById("tabSaved");
    if (savedTab) savedTab.hidden = !profile.isOwner;
    if (feedEl) feedEl.hidden = false;
    void loadTab("posts", true);
}

// ===========================================================================
// Abas: Posts e Respostas
// ===========================================================================

type Tab = "posts" | "comments" | "saved";

let profileUserId = "";
let isOwnProfile = false;
let currentTab: Tab = "posts";
let currentPage = 0;
// Descarta respostas de uma aba que o usuário já deixou para trás.
let requestSeq = 0;

function itemMeta(communityId: string, communityName: string, createdAt: string): HTMLElement {
    const meta = document.createElement("p");
    meta.className = "pv-item-meta";
    const link = document.createElement("a");
    link.href = communityUrl(communityId);
    link.textContent = communityName;
    meta.append(link, ` · ${timeAgo(createdAt)}`);
    return meta;
}

function renderPostItem(post: ProfilePost): HTMLElement {
    const item = document.createElement("article");
    item.className = "pv-item r-edge";

    const title = document.createElement("a");
    title.className = "pv-item-title";
    title.href = postUrl(post.postId);
    title.textContent = post.title;

    const snippet = document.createElement("p");
    snippet.className = "pv-item-snip";
    snippet.textContent = post.nsfwHidden
        ? "Conteúdo para maiores de 18."
        : truncate(markdownToText(post.content), 220);

    const stats = document.createElement("p");
    stats.className = "pv-item-stats";
    stats.textContent = `${post.likesCount} ${post.likesCount === 1 ? "curtida" : "curtidas"} · ${post.commentsCount} ${post.commentsCount === 1 ? "comentário" : "comentários"}`;

    item.append(itemMeta(post.communityId, post.communityName, post.createdAt), title, snippet, stats);
    return item;
}

function renderCommentItem(comment: ProfileComment): HTMLElement {
    const item = document.createElement("article");
    item.className = "pv-item r-edge";

    const context = document.createElement("p");
    context.className = "pv-item-context";
    const postLink = document.createElement("a");
    postLink.href = postUrl(comment.postId, comment.commentId);
    postLink.textContent = comment.postTitle;
    context.append("Em resposta a ", postLink);

    const content = document.createElement("p");
    content.className = "pv-item-snip";
    content.textContent = truncate(markdownToText(comment.content), 300);

    item.append(itemMeta(comment.communityId, comment.communityName, comment.createdAt), context, content);
    return item;
}

function setStatus(text: string | null): void {
    if (!feedStatus) return;
    feedStatus.textContent = text ?? "";
    feedStatus.hidden = text === null;
}

function emptyMessage(tab: Tab): string {
    if (tab === "saved") {
        return "Nenhum post salvo ainda. Use o 🔖 Salvar nos posts para guardá-los aqui.";
    }
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
        feedList.replaceChildren(skeleton("post", 2, "Carregando..."));
        loadMoreBtn.hidden = true;
        setStatus(null);
    }
    loadMoreBtn.disabled = true;

    const nextPage = currentPage + 1;
    try {
        // Salvos têm o formato de post (o mesmo desenho da aba Posts).
        const query = { page: nextPage, limit: 10 };
        const result =
            tab === "comments"
                ? await api.users.comments(profileUserId, query)
                : await (tab === "saved" ? api.me.saved(query) : api.users.posts(profileUserId, query));
        if (seq !== requestSeq) return;

        if (currentPage === 0) feedList.replaceChildren(); // tira o esqueleto
        currentPage = nextPage;
        const nodes =
            tab === "comments"
                ? (result.data as ProfileComment[]).map(renderCommentItem)
                : (result.data as ProfilePost[]).map(renderPostItem);
        feedList.append(...nodes);

        setStatus(feedList.childElementCount === 0 ? emptyMessage(tab) : null);
        loadMoreBtn.hidden = currentPage >= result.pagination.totalPages;
    } catch (err) {
        if (seq !== requestSeq) return;
        if (currentPage === 0) feedList.replaceChildren();
        setStatus(err instanceof Error ? `Não foi possível carregar: ${err.message}` : "Não foi possível carregar.");
    } finally {
        if (seq === requestSeq) loadMoreBtn.disabled = false;
    }
}

tabsEl?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    const tab = button?.dataset.tab as Tab | undefined;
    if (!button || !tab || tab === currentTab) return;

    tabsEl.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
        const active = b === button;
        b.setAttribute("aria-selected", String(active));
    });
    void loadTab(tab, true);
});
bindTabKeys(tabsEl);

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
    if (!userId && requestedUsername) {
        try {
            const { user } = await api.users.byUsername(requestedUsername);
            userId = user.userId;
        } catch {
            showFatal(`Ninguém com o usuário @${requestedUsername}`);
            container?.removeAttribute("aria-busy");
            return;
        }
    }
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
        const { user } = await api.users.get(userId);
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
// Seguir (perfil de outra pessoa; visitante vai ao login ao clicar)
// ===========================================================================

function setupFollowButton(profile: PublicProfile): void {
    const message = document.getElementById("btnMessage") as HTMLButtonElement | null;
    if (message && !profile.isOwner && !message.dataset.ready) {
        message.dataset.ready = "true";
        message.hidden = false;
        message.addEventListener("click", () => openChatWith(profile.userId));
    }

    const button = document.getElementById("btnFollow") as HTMLButtonElement | null;
    if (!button || profile.isOwner || button.dataset.ready) return;
    button.dataset.ready = "true";
    button.hidden = false;
    bindFollowButton(button, profile.userId, profile.followedByMe ?? false, (state) =>
        updateFollowersCount(state.followersCount),
    );
}

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
        // O foco num item que vai sumir volta ao ⋯ (Bloquear abre uma confirmação).
        if (!open && menu.contains(document.activeElement)) button.focus();
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
    wrapper.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !menu.hidden) {
            setOpen(false);
            button.focus();
        }
    });
    report.addEventListener("click", () => {
        setOpen(false);
        void openReportDialog("user", profile.userId);
    });

    // Bloquear / desbloquear. Bloquear desfaz os follows entre os dois, então
    // o botão Seguir e o contador são recarregados com o perfil.
    const block = document.getElementById("btnBlockUser");
    let blocked = profile.blockedByMe ?? false;
    const name = profile.displayName ?? profile.username;
    const renderBlock = (): void => {
        if (block) block.textContent = blocked ? "Desbloquear" : "Bloquear";
    };
    renderBlock();
    block?.addEventListener("click", async () => {
        setOpen(false);
        if (!blocked) {
            const ok = await confirmDialog({
                title: `Bloquear ${name}?`,
                message:
                    "Vocês não poderão trocar mensagens nem se seguir, os posts e comentários dessa pessoa aparecem recolhidos para você e ela some das suas buscas. Ela não é avisada.",
                confirmLabel: "Bloquear",
                danger: true,
            });
            if (!ok) return;
        }
        try {
            await api.users.setBlocked(profile.userId, !blocked);
            blocked = !blocked;
            renderBlock();
            toast(blocked ? `${name} foi bloqueado(a).` : `${name} foi desbloqueado(a).`);
            if (blocked) window.setTimeout(() => window.location.reload(), 800);
        } catch (err) {
            toast(err instanceof Error ? err.message : "Não foi possível bloquear.", "error");
        }
    });
}
