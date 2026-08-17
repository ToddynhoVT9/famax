/**
 * FAMAX — Community Page Script
 *
 * Substitui o markup fixo do protótipo por render a partir da API.
 *
 * Duas escolhas que valem o registro:
 *  - Delegação de eventos. O protótipo fazia querySelectorAll(...).forEach(on)
 *    no load; qualquer post vindo da API depois disso ficava sem handler.
 *    Aqui há um listener só, na lista, e ele funciona para tudo que aparecer.
 *  - Comentários sob demanda. Carregar os comentários de todos os posts no
 *    load seria N+1 requests para conteúdo que quase sempre está fechado.
 */
import { api, getCurrentUserId, getToken } from "./shared/api.js";
import { initSidebar } from "./shared/sidebar.js";
import { initHeaderDropdowns } from "./shared/header-dropdowns.js";
import {
    avatarColor,
    escapeHtml,
    initials,
    queryParam,
    timeAgo,
} from "./shared/dom.js";

initSidebar();
initHeaderDropdowns();

// ===========================================================================
// Tipos
// ===========================================================================

interface Post {
    post_id: string;
    title: string;
    content: string;
    likes_count: number;
    comments_count: number;
    created_at: string;
    author_id: string;
    author_username: string;
    author_display_name: string | null;
    author_avatar_url: string | null;
    category_name: string | null;
    liked_by_me: boolean;
}

interface Comment {
    comment_id: string;
    content: string;
    created_at: string;
    author_id: string;
    author_username: string;
    author_display_name: string | null;
}

interface CommunityCategory {
    community_category_id: string;
    name: string;
}

interface Community {
    community_id: string;
    name: string;
    description: string | null;
    category_name: string | null;
    members_count: number;
}

// ===========================================================================
// Estado
// ===========================================================================

const communityId = queryParam("id");
const currentUserId = getCurrentUserId();

const postsList = document.getElementById("tfPostsList");
const feedStatus = document.getElementById("tfFeedStatus");
const communityNameEl = document.getElementById("communityName");
const communityMetaEl = document.getElementById("communityMeta");
const joinBtn = document.getElementById("btnJoinCommunity");
const myCommunitiesEl = document.getElementById("myCommunities");

/** Posts cujos comentários já foram buscados — evita refetch a cada toggle. */
const loadedComments = new Set<string>();

// ===========================================================================
// Render
// ===========================================================================

function authorName(post: Post | Comment): string {
    return post.author_display_name?.trim() || post.author_username;
}

/**
 * Todo dado de usuário passa por escapeHtml.
 *
 * O protótipo montava o post com innerHTML e interpolação crua — um título
 * contendo <img src=x onerror=...> executava para todos os visitantes.
 */
function renderPost(post: Post): string {
    const name = authorName(post);
    const category = post.category_name ?? "Discussões";

    return `
        <article class="tf-post" data-post-id="${escapeHtml(post.post_id)}">
            <div class="tf-post-avatar-container" data-author-name="${escapeHtml(name)}">
                <div class="tf-avatar ${avatarColor(post.author_id)}">${escapeHtml(initials(name))}</div>
            </div>
            <div class="tf-post-body">
                <div class="tf-post-meta">
                    <strong>${escapeHtml(name)}</strong> • Perguntado em ${escapeHtml(category)}
                </div>
                <h3 class="tf-post-title">${escapeHtml(post.title)}</h3>
                <div class="tf-post-snippet">${escapeHtml(post.content)}</div>
                <div class="tf-post-stats">
                    <button type="button" class="tf-stat tf-stat-like${post.liked_by_me ? " active" : ""}"
                            data-liked="${post.liked_by_me}" aria-pressed="${post.liked_by_me}">
                        👍 <span class="like-count">${post.likes_count}</span>
                    </button>
                    <button type="button" class="tf-stat tf-stat-comment-toggle" aria-expanded="false">
                        💬 <span class="comment-count">${post.comments_count}</span>
                    </button>
                    <span class="tf-stat-user">
                        <div class="tf-avatar-small">${escapeHtml(initials(name))}</div>
                        ${escapeHtml(timeAgo(post.created_at))}
                    </span>
                </div>
                <div class="tf-post-comments" hidden>
                    <div class="tf-comment-list"></div>
                    <form class="tf-comment-form">
                        <input type="text" class="tf-comment-input" maxlength="2000"
                               placeholder="Escreva um comentário..." aria-label="Comentário" />
                        <button type="submit">Enviar</button>
                    </form>
                </div>
            </div>
        </article>
    `;
}

function renderComment(comment: Comment): string {
    const name = authorName(comment);
    const isMine = comment.author_id === currentUserId;

    return `
        <div class="tf-comment-item" data-comment-id="${escapeHtml(comment.comment_id)}">
            <strong>${escapeHtml(name)}</strong>
            <p>${escapeHtml(comment.content)}</p>
            <span class="tf-comment-time">${escapeHtml(timeAgo(comment.created_at))}</span>
            ${isMine ? '<button type="button" class="tf-comment-delete" title="Excluir comentário">✕</button>' : ""}
        </div>
    `;
}

function showFeedStatus(message: string, isError = false): void {
    if (!postsList) return;
    postsList.innerHTML = `<div class="tf-feed-status${isError ? " error" : ""}"></div>`;
    const el = postsList.querySelector(".tf-feed-status");
    if (el) el.textContent = message;
}

// ===========================================================================
// Carregamento
// ===========================================================================

async function loadCommunity(): Promise<void> {
    if (!communityId) return;

    try {
        const { community, categories } = await api<{
            community: Community;
            categories: CommunityCategory[];
        }>(`/communities/${communityId}`);

        if (communityNameEl) communityNameEl.textContent = community.name;
        if (communityMetaEl) {
            const parts = [
                community.category_name,
                `${community.members_count} ${community.members_count === 1 ? "membro" : "membros"}`,
            ].filter(Boolean);
            communityMetaEl.textContent = parts.join(" • ");
        }

        document.title = `FAMAX - ${community.name}`;
        fillCategorySelect(categories);
    } catch (err) {
        if (communityNameEl) {
            communityNameEl.textContent =
                err instanceof Error ? err.message : "Comunidade não encontrada";
        }
    }
}

function fillCategorySelect(categories: CommunityCategory[]): void {
    const select = document.getElementById("newPostCategory");
    if (!(select instanceof HTMLSelectElement)) return;

    select.innerHTML = '<option value="">Selecione uma categoria...</option>';
    for (const category of categories) {
        const option = document.createElement("option");
        option.value = category.community_category_id;
        option.textContent = category.name;
        select.appendChild(option);
    }
}

async function loadPosts(): Promise<void> {
    if (!communityId || !postsList) return;

    try {
        const { data } = await api<{ data: Post[] }>(
            `/communities/${communityId}/posts?limit=20`,
        );

        if (data.length === 0) {
            showFeedStatus("Nenhuma discussão ainda. Seja o primeiro a publicar!");
            return;
        }

        postsList.innerHTML = data.map(renderPost).join("");
    } catch (err) {
        showFeedStatus(
            err instanceof Error
                ? `Não foi possível carregar as discussões: ${err.message}`
                : "Não foi possível carregar as discussões.",
            true,
        );
    }
}

async function loadMembership(): Promise<void> {
    if (!communityId || !getToken() || !(joinBtn instanceof HTMLButtonElement)) {
        return;
    }

    try {
        const { isMember } = await api<{ isMember: boolean }>(
            `/communities/${communityId}/membership`,
        );
        joinBtn.hidden = isMember;
    } catch {
        // Falha aqui só significa não saber o estado; o botão fica escondido e
        // o backend continua rejeitando escrita de não-membro.
    }
}

async function loadMyCommunities(): Promise<void> {
    if (!myCommunitiesEl || !getToken()) return;

    try {
        const { data } = await api<{
            data: Array<{ community_id: string; name: string }>;
        }>("/me/communities");

        myCommunitiesEl.innerHTML = "";
        for (const community of data) {
            const link = document.createElement("a");
            link.className = "sidebar-link";
            link.href = `community.html?id=${encodeURIComponent(community.community_id)}`;
            link.textContent = community.name;
            myCommunitiesEl.appendChild(link);
        }
    } catch {
        // Sidebar é acessório; falha silenciosa não impede usar a página.
    }
}

async function loadComments(post: HTMLElement): Promise<void> {
    const postId = post.dataset.postId;
    const list = post.querySelector<HTMLElement>(".tf-comment-list");
    if (!postId || !list) return;

    list.innerHTML = '<div class="tf-comment-status">Carregando comentários...</div>';

    try {
        const { data } = await api<{ data: Comment[] }>(
            `/posts/${postId}/comments?limit=100`,
        );

        loadedComments.add(postId);
        list.innerHTML =
            data.length > 0
                ? data.map(renderComment).join("")
                : '<div class="tf-comment-status">Nenhum comentário ainda.</div>';
    } catch (err) {
        loadedComments.delete(postId);
        list.innerHTML = '<div class="tf-comment-status"></div>';
        const status = list.querySelector(".tf-comment-status");
        if (status) {
            status.textContent =
                err instanceof Error ? err.message : "Erro ao carregar comentários.";
        }
    }
}

// ===========================================================================
// Ações (delegação de eventos)
// ===========================================================================

async function toggleLike(button: HTMLButtonElement): Promise<void> {
    const post = button.closest<HTMLElement>(".tf-post");
    const postId = post?.dataset.postId;
    const countEl = button.querySelector<HTMLElement>(".like-count");
    if (!postId || !countEl) return;

    if (!getToken()) {
        window.location.href = "user-pages/login.html";
        return;
    }

    // Atualiza otimista e reverte se a API recusar — o clique responde na hora
    // mesmo com a rede lenta.
    const wasLiked = button.dataset.liked === "true";
    const previousCount = Number(countEl.textContent ?? "0");

    const optimisticLiked = !wasLiked;
    const optimisticCount = Math.max(0, previousCount + (optimisticLiked ? 1 : -1));
    applyLikeState(button, countEl, optimisticLiked, optimisticCount);

    button.disabled = true;
    try {
        const { liked, likesCount } = await api<{
            liked: boolean;
            likesCount: number;
        }>(`/posts/${postId}/reactions`, { method: "POST" });

        applyLikeState(button, countEl, liked, likesCount);
    } catch {
        applyLikeState(button, countEl, wasLiked, previousCount);
    } finally {
        button.disabled = false;
    }
}

function applyLikeState(
    button: HTMLButtonElement,
    countEl: HTMLElement,
    liked: boolean,
    count: number,
): void {
    button.dataset.liked = String(liked);
    button.setAttribute("aria-pressed", String(liked));
    button.classList.toggle("active", liked);
    countEl.textContent = String(count);
}

async function submitComment(form: HTMLFormElement): Promise<void> {
    const post = form.closest<HTMLElement>(".tf-post");
    const postId = post?.dataset.postId;
    const input = form.querySelector<HTMLInputElement>(".tf-comment-input");
    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!post || !postId || !input) return;

    const content = input.value.trim();
    if (!content) return;

    if (!getToken()) {
        window.location.href = "user-pages/login.html";
        return;
    }

    if (submitButton) submitButton.disabled = true;

    try {
        const { comment } = await api<{ comment: Comment }>(
            `/posts/${postId}/comments`,
            { method: "POST", body: JSON.stringify({ content }) },
        );

        const list = post.querySelector<HTMLElement>(".tf-comment-list");
        if (list) {
            // Remove o "nenhum comentário ainda" antes de inserir o primeiro.
            list.querySelector(".tf-comment-status")?.remove();
            list.insertAdjacentHTML("beforeend", renderComment(comment));
        }

        const countEl = post.querySelector<HTMLElement>(".comment-count");
        if (countEl) {
            countEl.textContent = String(Number(countEl.textContent ?? "0") + 1);
        }

        input.value = "";
    } catch (err) {
        window.alert(
            err instanceof Error ? err.message : "Não foi possível comentar.",
        );
    } finally {
        if (submitButton) submitButton.disabled = false;
    }
}

async function deleteComment(button: HTMLButtonElement): Promise<void> {
    const item = button.closest<HTMLElement>(".tf-comment-item");
    const post = button.closest<HTMLElement>(".tf-post");
    const commentId = item?.dataset.commentId;
    if (!item || !post || !commentId) return;

    if (!window.confirm("Excluir este comentário?")) return;

    button.disabled = true;
    try {
        await api(`/comments/${commentId}`, { method: "DELETE" });
        item.remove();

        const countEl = post.querySelector<HTMLElement>(".comment-count");
        if (countEl) {
            countEl.textContent = String(
                Math.max(0, Number(countEl.textContent ?? "0") - 1),
            );
        }
    } catch (err) {
        button.disabled = false;
        window.alert(
            err instanceof Error ? err.message : "Não foi possível excluir.",
        );
    }
}

if (postsList) {
    postsList.addEventListener("click", (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const likeBtn = target.closest<HTMLButtonElement>(".tf-stat-like");
        if (likeBtn) {
            void toggleLike(likeBtn);
            return;
        }

        const commentToggle = target.closest<HTMLButtonElement>(
            ".tf-stat-comment-toggle",
        );
        if (commentToggle) {
            const post = commentToggle.closest<HTMLElement>(".tf-post");
            const comments = post?.querySelector<HTMLElement>(".tf-post-comments");
            if (!post || !comments) return;

            comments.hidden = !comments.hidden;
            commentToggle.setAttribute("aria-expanded", String(!comments.hidden));

            if (!comments.hidden) {
                const postId = post.dataset.postId;
                if (postId && !loadedComments.has(postId)) {
                    void loadComments(post);
                }
                post.querySelector<HTMLInputElement>(".tf-comment-input")?.focus();
            }
            return;
        }

        const deleteBtn = target.closest<HTMLButtonElement>(".tf-comment-delete");
        if (deleteBtn) {
            void deleteComment(deleteBtn);
            return;
        }

        const authorRef =
            target.closest<HTMLElement>(".tf-post-avatar-container") ??
            (target.closest(".tf-post-meta") ? target.closest<HTMLElement>("strong") : null);

        if (authorRef) {
            const post = authorRef.closest<HTMLElement>(".tf-post");
            const name =
                post?.querySelector<HTMLElement>(".tf-post-meta strong")?.textContent ??
                "Usuário";
            window.location.href = `user-pages/profile-view.html?view=other&name=${encodeURIComponent(name)}`;
        }
    });

    // submit borbulha, então um listener na lista cobre todos os formulários.
    postsList.addEventListener("submit", (event: SubmitEvent) => {
        const form = (event.target as Element | null)?.closest<HTMLFormElement>(
            ".tf-comment-form",
        );
        if (!form) return;
        event.preventDefault();
        void submitComment(form);
    });
}

// ===========================================================================
// Participar da comunidade
// ===========================================================================

if (joinBtn instanceof HTMLButtonElement) {
    joinBtn.addEventListener("click", async () => {
        if (!communityId) return;
        if (!getToken()) {
            window.location.href = "user-pages/login.html";
            return;
        }

        joinBtn.disabled = true;
        try {
            await api(`/communities/${communityId}/join`, { method: "POST" });
            joinBtn.hidden = true;
            void loadMyCommunities();
        } catch (err) {
            window.alert(
                err instanceof Error ? err.message : "Não foi possível participar.",
            );
        } finally {
            joinBtn.disabled = false;
        }
    });
}

// ===========================================================================
// Modal de criação de post
// ===========================================================================

const btnCreatePost = document.getElementById("btnCreatePost");
const createPostModal = document.getElementById("createPostModal");
const closePostModal = document.getElementById("closePostModal");
const cancelPostModal = document.getElementById("cancelPostModal");
const publishPostBtn = document.getElementById("publishPostBtn");
const newPostTitle = document.getElementById("newPostTitle");
const newPostCategory = document.getElementById("newPostCategory");
const newPostContent = document.getElementById("newPostContent");
const postModalError = document.getElementById("postModalError");

const openModal = (): void => createPostModal?.classList.add("show");
const closeModal = (): void => createPostModal?.classList.remove("show");

const showModalError = (message: string): void => {
    if (!postModalError) return;
    postModalError.textContent = message;
    postModalError.classList.add("show");
};

const clearModalError = (): void => {
    if (!postModalError) return;
    postModalError.textContent = "";
    postModalError.classList.remove("show");
};

async function publishPost(): Promise<void> {
    if (
        !(newPostTitle instanceof HTMLInputElement) ||
        !(newPostContent instanceof HTMLTextAreaElement) ||
        !(publishPostBtn instanceof HTMLButtonElement) ||
        !communityId
    ) {
        return;
    }

    clearModalError();

    const title = newPostTitle.value.trim();
    const content = newPostContent.value.trim();
    const categoryId =
        newPostCategory instanceof HTMLSelectElement ? newPostCategory.value : "";

    if (title.length < 3) {
        showModalError("O título deve ter no mínimo 3 caracteres.");
        return;
    }
    if (!content) {
        showModalError("Escreva o conteúdo da discussão.");
        return;
    }

    publishPostBtn.disabled = true;
    publishPostBtn.textContent = "Publicando...";

    try {
        const { post } = await api<{ post: Post }>("/posts", {
            method: "POST",
            body: JSON.stringify({
                communityId,
                communityCategoryId: categoryId || null,
                title,
                content,
            }),
        });

        // Insere no topo: a listagem é ORDER BY created_at DESC.
        if (postsList) {
            postsList.querySelector(".tf-feed-status")?.remove();
            postsList.insertAdjacentHTML("afterbegin", renderPost(post));
        }

        newPostTitle.value = "";
        newPostContent.value = "";
        if (newPostCategory instanceof HTMLSelectElement) newPostCategory.value = "";
        closeModal();
    } catch (err) {
        showModalError(
            err instanceof Error ? err.message : "Não foi possível publicar.",
        );
    } finally {
        publishPostBtn.disabled = false;
        publishPostBtn.textContent = "Publicar Post";
    }
}

btnCreatePost?.addEventListener("click", () => {
    if (!getToken()) {
        window.location.href = "user-pages/login.html";
        return;
    }
    clearModalError();
    openModal();
});
closePostModal?.addEventListener("click", closeModal);
cancelPostModal?.addEventListener("click", closeModal);
publishPostBtn?.addEventListener("click", () => void publishPost());

createPostModal?.addEventListener("click", (event: MouseEvent) => {
    if (event.target === createPostModal) closeModal();
});

document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") closeModal();
});

// ===========================================================================
// Tabs (indicador deslizante — comportamento visual preservado do protótipo)
// ===========================================================================

function updateIndicator(): void {
    const activeTab = document.querySelector<HTMLElement>(".tf-tab.active");
    const indicator = document.getElementById("tfTabIndicator");
    const container = document.getElementById("tfTabsContainer");

    if (activeTab && indicator && container) {
        const containerRect = container.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();
        indicator.style.width = `${tabRect.width}px`;
        indicator.style.transform = `translateX(${tabRect.left - containerRect.left}px)`;
    }
}

function updateWidgetIndicator(): void {
    const activeTab = document.querySelector<HTMLElement>(".tf-w-tab.active");
    const indicator = document.getElementById("tfWidgetTabIndicator");
    const container = document.getElementById("tfWidgetTabsContainer");

    if (activeTab && indicator && container) {
        const containerRect = container.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();
        indicator.style.width = `${tabRect.width}px`;
        indicator.style.transform = `translateX(${tabRect.left - containerRect.left}px)`;
    }
}

document.querySelectorAll<HTMLElement>(".tf-tab").forEach((tab) => {
    tab.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        document
            .querySelectorAll<HTMLElement>(".tf-tab")
            .forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        updateIndicator();
    });
});

document.querySelectorAll<HTMLElement>(".tf-w-tab").forEach((tab) => {
    tab.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        document
            .querySelectorAll<HTMLElement>(".tf-w-tab")
            .forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        updateWidgetIndicator();
    });
});

window.addEventListener("load", () => {
    setTimeout(updateIndicator, 50);
    setTimeout(updateWidgetIndicator, 50);
});

window.addEventListener("resize", () => {
    updateIndicator();
    updateWidgetIndicator();
});

// ===========================================================================
// Boot
// ===========================================================================

if (!communityId) {
    showFeedStatus(
        "Nenhuma comunidade selecionada. Volte para a home e escolha uma.",
        true,
    );
    if (communityNameEl) communityNameEl.textContent = "Comunidade";
} else {
    void loadCommunity();
    void loadPosts();
    void loadMembership();
    void loadMyCommunities();
}

export {};
