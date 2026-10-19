/**
 * FAMAX — Posts e comentários (Shared)
 *
 * O desenho de um post, os comentários em árvore e todas as ações sobre eles
 * (curtir, comentar, responder, editar, excluir), usados pelo feed da
 * comunidade e pela página individual do post.
 *
 *  - Delegação de eventos: um listener no container cobre todos os posts,
 *    inclusive os que chegam depois pelo "carregar mais".
 *  - Comentários sob demanda: só são buscados quando o post é aberto.
 *  - Todo dado de usuário passa por escapeHtml (ou entra por textContent). O
 *    protótipo montava o post com interpolação crua — um título com
 *    <img src=x onerror=...> executava para todos os visitantes.
 */
import { api, getCurrentUserId, getToken } from "./api.js";
import { goToLogin } from "./auth-guard.js";
import { postUrl, profileUrl } from "./pages.js";
import { avatarColor, escapeHtml, initials, timeAgo } from "./dom.js";
import { confirmDialog, toast } from "./dialog.js";

// ===========================================================================
// Tipos
// ===========================================================================

export interface Post {
    post_id: string;
    title: string;
    content: string;
    likes_count: number;
    comments_count: number;
    created_at: string;
    edited_at: string | null;
    community_category_id: string | null;
    community_id: string;
    community_name: string;
    author_id: string;
    author_username: string;
    author_display_name: string | null;
    author_avatar_url: string | null;
    category_name: string | null;
    liked_by_me: boolean;
}

/** Comentário apagado com respostas chega com is_deleted e sem autor/texto. */
export interface Comment {
    comment_id: string;
    parent_comment_id: string | null;
    content: string | null;
    created_at: string;
    edited_at: string | null;
    is_deleted: boolean;
    replies_count: number;
    author_id: string | null;
    author_username: string | null;
    author_display_name: string | null;
}

export interface PostThreadOptions {
    /** Página do post: conteúdo inteiro, título sem link, comentários abertos. */
    single?: boolean;
    /** Autor pediu para editar; quem chama abre o editor e usa replace(). */
    onEditPost?: (post: Post) => void;
    /** Post excluído e já removido da tela. */
    onPostDeleted?: (postId: string) => void;
}

const COMMENTS_PER_PAGE = 20;

// ===========================================================================
// Utilidades
// ===========================================================================

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

function authorName(item: { author_display_name: string | null; author_username: string | null }): string {
    return item.author_display_name?.trim() || item.author_username || "Usuário";
}

/** Exige sessão; sem ela manda para o login e devolve false. */
function ensureLoggedIn(): boolean {
    if (getToken()) return true;
    goToLogin();
    return false;
}

const cssId = (id: string) => CSS.escape(id);

// ===========================================================================
// Render
// ===========================================================================

export function renderPost(post: Post, options: { single?: boolean } = {}): string {
    const name = authorName(post);
    const mine = post.author_id === getCurrentUserId();
    const id = escapeHtml(post.post_id);
    const title = escapeHtml(post.title);

    const menu = mine
        ? `<div class="tf-post-menu">
               <button type="button" class="tf-post-menu-btn" data-action="post-menu"
                       aria-haspopup="menu" aria-expanded="false" aria-label="Opções do post">⋯</button>
               <div class="tf-menu-list" role="menu" hidden>
                   <button type="button" class="tf-menu-item" role="menuitem" data-action="edit-post">Editar</button>
                   <button type="button" class="tf-menu-item tf-menu-item--danger" role="menuitem" data-action="delete-post">Excluir</button>
               </div>
           </div>`
        : "";

    // No feed o título leva à página do post; na própria página é só título.
    const heading = options.single
        ? `<h1 class="tf-post-title">${title}</h1>`
        : `<h3 class="tf-post-title"><a class="tf-post-title-link" href="${escapeHtml(postUrl(post.post_id))}">${title}</a></h3>`;

    return `
        <article class="tf-post${options.single ? " tf-post--single" : ""}" data-post-id="${id}">
            <div class="tf-post-avatar-container" data-author-id="${escapeHtml(post.author_id)}">
                <div class="tf-avatar ${avatarColor(post.author_id)}">${escapeHtml(initials(name))}</div>
            </div>
            <div class="tf-post-body">
                <div class="tf-post-meta">
                    <span>
                        <strong data-author-id="${escapeHtml(post.author_id)}">${escapeHtml(name)}</strong>
                        • ${post.category_name ? `em ${escapeHtml(post.category_name)} • ` : ""}${escapeHtml(timeAgo(post.created_at))}${post.edited_at ? ' <span class="tf-edited">(editado)</span>' : ""}
                    </span>
                    ${menu}
                </div>
                ${heading}
                <div class="tf-post-snippet${options.single ? " expanded" : ""}">${escapeHtml(post.content)}</div>
                <button type="button" class="tf-read-more" data-action="read-more" hidden>ler mais</button>
                <div class="tf-post-stats">
                    <button type="button" class="tf-stat tf-stat-like${post.liked_by_me ? " active" : ""}"
                            data-action="like" data-liked="${post.liked_by_me}" aria-pressed="${post.liked_by_me}"
                            aria-label="Curtir">
                        👍 <span class="like-count">${post.likes_count}</span>
                    </button>
                    <button type="button" class="tf-stat" data-action="toggle-comments"
                            aria-expanded="${options.single ? "true" : "false"}" aria-label="Comentários">
                        💬 <span class="comment-count">${post.comments_count}</span>
                    </button>
                </div>
                <div class="tf-post-comments"${options.single ? "" : " hidden"}>
                    <div class="tf-comment-list"></div>
                    <button type="button" class="tf-comments-more" data-action="more-comments" hidden>Carregar mais comentários</button>
                    <form class="tf-comment-form" data-form="comment">
                        <input type="text" class="tf-comment-input" maxlength="2000"
                               placeholder="Escreva um comentário..." aria-label="Comentário" />
                        <button type="submit">Enviar</button>
                    </form>
                    <div class="tf-inline-error" role="alert" hidden></div>
                </div>
            </div>
        </article>
    `;
}

/** "ler mais" só aparece onde o texto realmente foi cortado. */
export function markOverflow(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>(".tf-post-snippet:not(.expanded)").forEach((snippet) => {
        const button = snippet.nextElementSibling as HTMLElement | null;
        if (button?.dataset.action === "read-more") {
            button.hidden = snippet.scrollHeight <= snippet.clientHeight + 2;
        }
    });
}

function renderCommentMain(comment: Comment): string {
    if (comment.is_deleted) {
        return `<div class="tf-comment-main">
                    <p class="tf-comment-removed">[comentário removido]</p>
                    <span class="tf-comment-time">${escapeHtml(timeAgo(comment.created_at))}</span>
                </div>`;
    }
    const mine = comment.author_id === getCurrentUserId();
    return `<div class="tf-comment-main">
                <strong data-author-id="${escapeHtml(comment.author_id ?? "")}">${escapeHtml(authorName(comment))}</strong>
                <p class="tf-comment-text">${escapeHtml(comment.content ?? "")}</p>
                <div class="tf-comment-footer">
                    <span class="tf-comment-time">${escapeHtml(timeAgo(comment.created_at))}${comment.edited_at ? " · editado" : ""}</span>
                    <button type="button" class="tf-comment-action" data-action="reply">Responder</button>
                    ${
                        mine
                            ? `<button type="button" class="tf-comment-action" data-action="edit-comment">Editar</button>
                               <button type="button" class="tf-comment-action tf-comment-action--danger" data-action="delete-comment">Excluir</button>`
                            : ""
                    }
                </div>
            </div>`;
}

function renderComment(comment: Comment, depth: number): string {
    return `<div class="tf-comment-item${comment.is_deleted ? " is-deleted" : ""}"
                 data-comment-id="${escapeHtml(comment.comment_id)}" data-depth="${depth}">
                ${renderCommentMain(comment)}
                <div class="tf-comment-replies"></div>
            </div>`;
}

// ===========================================================================
// Thread: estado + ações sobre um container de posts
// ===========================================================================

export interface PostThread {
    /** Posts na tela, por id (o editor e o "ler mais" leem daqui). */
    posts: Map<string, Post>;
    /** Acrescenta posts no fim (ou no início, com prepend). */
    add(list: Post[], position?: "append" | "prepend"): void;
    /** Redesenha um post depois de editado. */
    replace(post: Post): void;
    /** Esquece tudo (troca de aba/filtro). */
    clear(): void;
    /** Busca a primeira página de comentários de um post na tela. */
    loadComments(postId: string): Promise<void>;
}

export function createPostThread(container: HTMLElement, options: PostThreadOptions = {}): PostThread {
    const posts = new Map<string, Post>();
    /** Cursor da próxima página de comentários; ausente = ainda não carregou. */
    const commentCursors = new Map<string, string | null>();

    const postElement = (postId: string) =>
        container.querySelector<HTMLElement>(`.tf-post[data-post-id="${cssId(postId)}"]`);

    // ----- Curtir ---------------------------------------------------------

    function applyLikeState(button: HTMLButtonElement, liked: boolean, count: number): void {
        button.dataset.liked = String(liked);
        button.setAttribute("aria-pressed", String(liked));
        button.classList.toggle("active", liked);
        const countEl = button.querySelector(".like-count");
        if (countEl) countEl.textContent = String(count);
        const post = posts.get(button.closest<HTMLElement>(".tf-post")?.dataset.postId ?? "");
        if (post) {
            post.liked_by_me = liked;
            post.likes_count = count;
        }
    }

    async function toggleLike(button: HTMLButtonElement, postId: string): Promise<void> {
        if (!ensureLoggedIn()) return;

        // Otimista: o clique responde na hora e volta atrás se a API recusar.
        const wasLiked = button.dataset.liked === "true";
        const previous = Number(button.querySelector(".like-count")?.textContent ?? "0");
        applyLikeState(button, !wasLiked, Math.max(0, previous + (wasLiked ? -1 : 1)));

        button.disabled = true;
        try {
            const { liked, likesCount } = await api<{ liked: boolean; likesCount: number }>(
                `/posts/${encodeURIComponent(postId)}/reactions`,
                { method: "POST" },
            );
            applyLikeState(button, liked, likesCount);
        } catch (err) {
            applyLikeState(button, wasLiked, previous);
            toast(errorMessage(err, "Não foi possível curtir."), "error");
        } finally {
            button.disabled = false;
        }
    }

    // ----- Excluir post ---------------------------------------------------

    async function deletePost(article: HTMLElement): Promise<void> {
        const postId = article.dataset.postId;
        if (!postId) return;

        const ok = await confirmDialog({
            title: "Excluir discussão?",
            message: "A discussão some da comunidade para todos. Esta ação não pode ser desfeita.",
            confirmLabel: "Excluir",
            danger: true,
        });
        if (!ok) return;

        try {
            await api(`/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
            article.remove();
            posts.delete(postId);
            toast("Discussão excluída.");
            options.onPostDeleted?.(postId);
        } catch (err) {
            toast(errorMessage(err, "Não foi possível excluir."), "error");
        }
    }

    // ----- Comentários ----------------------------------------------------

    /**
     * Insere comentários da lista plana na árvore. A API manda em ordem de
     * criação, então o pai de uma resposta sempre já está na tela.
     */
    function insertComments(postEl: HTMLElement, comments: Comment[]): void {
        const list = postEl.querySelector<HTMLElement>(".tf-comment-list");
        if (!list) return;
        list.querySelector(".tf-comment-status")?.remove();

        for (const comment of comments) {
            const parent = comment.parent_comment_id
                ? list.querySelector<HTMLElement>(`.tf-comment-item[data-comment-id="${cssId(comment.parent_comment_id)}"]`)
                : null;
            const target = parent ? parent.querySelector<HTMLElement>(":scope > .tf-comment-replies") : list;
            const depth = parent ? Number(parent.dataset.depth ?? "0") + 1 : 0;
            target?.insertAdjacentHTML("beforeend", renderComment(comment, depth));
        }
    }

    function setInlineError(postEl: HTMLElement, message: string | null): void {
        const el = postEl.querySelector<HTMLElement>(".tf-inline-error");
        if (!el) return;
        el.textContent = message ?? "";
        el.hidden = message === null;
    }

    async function loadComments(postEl: HTMLElement, more = false): Promise<void> {
        const postId = postEl.dataset.postId;
        const list = postEl.querySelector<HTMLElement>(".tf-comment-list");
        const moreBtn = postEl.querySelector<HTMLButtonElement>(".tf-comments-more");
        if (!postId || !list || !moreBtn) return;

        const cursor = more ? commentCursors.get(postId) : null;
        if (!more) list.innerHTML = '<div class="tf-comment-status">Carregando comentários...</div>';
        moreBtn.disabled = true;

        try {
            const params = new URLSearchParams({ limit: String(COMMENTS_PER_PAGE) });
            if (cursor) params.set("cursor", cursor);
            const { data, nextCursor } = await api<{ data: Comment[]; nextCursor: string | null }>(
                `/posts/${encodeURIComponent(postId)}/comments?${params}`,
            );

            commentCursors.set(postId, nextCursor);
            if (!more) list.innerHTML = "";
            insertComments(postEl, data);
            if (list.childElementCount === 0) {
                list.innerHTML = '<div class="tf-comment-status">Nenhum comentário ainda.</div>';
            }
            moreBtn.hidden = !nextCursor;
        } catch (err) {
            if (!more) {
                commentCursors.delete(postId);
                list.innerHTML = '<div class="tf-comment-status"></div>';
                const status = list.querySelector(".tf-comment-status");
                if (status) status.textContent = errorMessage(err, "Erro ao carregar comentários.");
            } else {
                toast(errorMessage(err, "Erro ao carregar comentários."), "error");
            }
        } finally {
            moreBtn.disabled = false;
        }
    }

    function bumpCommentCount(postEl: HTMLElement, delta: number): void {
        const countEl = postEl.querySelector(".comment-count");
        if (countEl) countEl.textContent = String(Math.max(0, Number(countEl.textContent ?? "0") + delta));
        const post = posts.get(postEl.dataset.postId ?? "");
        if (post) post.comments_count = Math.max(0, post.comments_count + delta);
    }

    async function submitComment(form: HTMLFormElement, postEl: HTMLElement, parentId: string | null): Promise<void> {
        const postId = postEl.dataset.postId;
        const input = form.querySelector<HTMLInputElement>(".tf-comment-input");
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (!postId || !input) return;

        const content = input.value.trim();
        if (!content || !ensureLoggedIn()) return;

        if (submit) submit.disabled = true;
        setInlineError(postEl, null);
        try {
            const { comment } = await api<{ comment: Comment }>(
                `/posts/${encodeURIComponent(postId)}/comments`,
                { method: "POST", body: JSON.stringify({ content, parentCommentId: parentId }) },
            );
            insertComments(postEl, [comment]);
            bumpCommentCount(postEl, 1);
            input.value = "";
            if (parentId) form.remove(); // formulário de resposta fecha depois de enviar
        } catch (err) {
            setInlineError(postEl, errorMessage(err, "Não foi possível comentar."));
        } finally {
            if (submit) submit.disabled = false;
        }
    }

    function openReplyForm(item: HTMLElement): void {
        if (!ensureLoggedIn()) return;
        const existing = item.querySelector<HTMLFormElement>(":scope > .tf-reply-form");
        if (existing) {
            existing.querySelector<HTMLInputElement>("input")?.focus();
            return;
        }
        const name = item.querySelector(":scope > .tf-comment-main strong")?.textContent ?? "";
        const form = document.createElement("form");
        form.className = "tf-comment-form tf-reply-form";
        form.dataset.form = "reply";
        form.innerHTML = `
            <input type="text" class="tf-comment-input" maxlength="2000" aria-label="Resposta" />
            <button type="submit">Enviar</button>
            <button type="button" class="tf-comment-action" data-action="cancel-form">Cancelar</button>`;
        const input = form.querySelector<HTMLInputElement>("input");
        if (input) input.placeholder = `Responder a ${name}...`;
        item.querySelector(":scope > .tf-comment-main")?.after(form);
        input?.focus();
    }

    function openEditCommentForm(item: HTMLElement): void {
        const text = item.querySelector<HTMLElement>(":scope > .tf-comment-main .tf-comment-text");
        if (!text || item.querySelector(":scope > .tf-comment-main .tf-edit-form")) return;

        const form = document.createElement("form");
        form.className = "tf-edit-form";
        form.dataset.form = "edit-comment";
        form.innerHTML = `
            <textarea class="tf-edit-input" maxlength="2000" rows="3" aria-label="Editar comentário"></textarea>
            <div class="tf-edit-actions">
                <button type="button" class="tf-comment-action" data-action="cancel-form">Cancelar</button>
                <button type="submit" class="tf-edit-save">Salvar</button>
            </div>`;
        const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
        if (textarea) textarea.value = text.textContent ?? "";
        text.hidden = true;
        text.after(form);
        textarea?.focus();
    }

    async function saveCommentEdit(form: HTMLFormElement, item: HTMLElement): Promise<void> {
        const commentId = item.dataset.commentId;
        const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
        const save = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        const postEl = item.closest<HTMLElement>(".tf-post");
        if (!commentId || !textarea || !postEl) return;

        const content = textarea.value.trim();
        if (!content) return;

        if (save) save.disabled = true;
        try {
            const { comment } = await api<{ comment: Comment }>(`/comments/${encodeURIComponent(commentId)}`, {
                method: "PATCH",
                body: JSON.stringify({ content }),
            });
            const main = item.querySelector(":scope > .tf-comment-main");
            main?.insertAdjacentHTML("afterend", renderCommentMain(comment));
            main?.remove();
        } catch (err) {
            setInlineError(postEl, errorMessage(err, "Não foi possível editar."));
            if (save) save.disabled = false;
        }
    }

    async function deleteComment(item: HTMLElement): Promise<void> {
        const commentId = item.dataset.commentId;
        const postEl = item.closest<HTMLElement>(".tf-post");
        if (!commentId || !postEl) return;

        const ok = await confirmDialog({
            title: "Excluir comentário?",
            message: "Se houver respostas, elas continuam visíveis e o comentário aparece como removido.",
            confirmLabel: "Excluir",
            danger: true,
        });
        if (!ok) return;

        try {
            await api(`/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
            const replies = item.querySelector(":scope > .tf-comment-replies");
            if (replies && replies.childElementCount > 0) {
                // Mantém a conversa: o comentário vira "[comentário removido]".
                item.classList.add("is-deleted");
                const main = item.querySelector(":scope > .tf-comment-main");
                main?.insertAdjacentHTML(
                    "afterend",
                    renderCommentMain({
                        comment_id: commentId,
                        parent_comment_id: null,
                        content: null,
                        created_at: new Date().toISOString(),
                        edited_at: null,
                        is_deleted: true,
                        replies_count: replies.childElementCount,
                        author_id: null,
                        author_username: null,
                        author_display_name: null,
                    }),
                );
                main?.remove();
            } else {
                item.remove();
            }
            bumpCommentCount(postEl, -1);
        } catch (err) {
            toast(errorMessage(err, "Não foi possível excluir."), "error");
        }
    }

    // ----- Menus e delegação de eventos ------------------------------------

    function closeMenus(except?: Element): void {
        container.querySelectorAll<HTMLElement>(".tf-menu-list:not([hidden])").forEach((menu) => {
            if (except && menu.parentElement?.contains(except)) return;
            menu.hidden = true;
            menu.previousElementSibling?.setAttribute("aria-expanded", "false");
        });
    }

    document.addEventListener("click", (event) => closeMenus(event.target as Element));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeMenus();
    });

    container.addEventListener("click", (event) => {
        const target = event.target as Element;
        const actionEl = target.closest<HTMLElement>("[data-action]");
        const postEl = target.closest<HTMLElement>(".tf-post");
        const postId = postEl?.dataset.postId;

        if (actionEl && postEl && postId) {
            const item = actionEl.closest<HTMLElement>(".tf-comment-item");
            switch (actionEl.dataset.action) {
                case "like":
                    void toggleLike(actionEl as HTMLButtonElement, postId);
                    return;
                case "toggle-comments": {
                    const panel = postEl.querySelector<HTMLElement>(".tf-post-comments");
                    if (!panel) return;
                    panel.hidden = !panel.hidden;
                    actionEl.setAttribute("aria-expanded", String(!panel.hidden));
                    if (!panel.hidden) {
                        if (!commentCursors.has(postId)) void loadComments(postEl);
                        panel.querySelector<HTMLInputElement>(".tf-comment-input")?.focus();
                    }
                    return;
                }
                case "more-comments":
                    void loadComments(postEl, true);
                    return;
                case "read-more": {
                    const snippet = postEl.querySelector<HTMLElement>(".tf-post-snippet");
                    const expanded = snippet?.classList.toggle("expanded") ?? false;
                    actionEl.textContent = expanded ? "ler menos" : "ler mais";
                    return;
                }
                case "post-menu": {
                    const menu = actionEl.nextElementSibling as HTMLElement | null;
                    if (!menu) return;
                    closeMenus(actionEl);
                    menu.hidden = !menu.hidden;
                    actionEl.setAttribute("aria-expanded", String(!menu.hidden));
                    return;
                }
                case "edit-post": {
                    closeMenus();
                    const post = posts.get(postId);
                    if (post) options.onEditPost?.(post);
                    return;
                }
                case "delete-post":
                    closeMenus();
                    void deletePost(postEl);
                    return;
                case "reply":
                    if (item) openReplyForm(item);
                    return;
                case "edit-comment":
                    if (item) openEditCommentForm(item);
                    return;
                case "delete-comment":
                    if (item) void deleteComment(item);
                    return;
                case "cancel-form": {
                    const form = actionEl.closest<HTMLFormElement>("form");
                    if (form?.dataset.form === "edit-comment") {
                        form.previousElementSibling?.removeAttribute("hidden");
                    }
                    form?.remove();
                    return;
                }
            }
        }

        // Autor: pelo id, não pelo nome — nomes de exibição se repetem e mudam.
        const authorId = target.closest<HTMLElement>("[data-author-id]")?.dataset.authorId;
        if (authorId) window.location.href = profileUrl(authorId);
    });

    // submit borbulha: um listener cobre comentário, resposta e edição.
    container.addEventListener("submit", (event) => {
        const form = (event.target as Element).closest<HTMLFormElement>("form[data-form]");
        const postEl = form?.closest<HTMLElement>(".tf-post");
        if (!form || !postEl) return;
        event.preventDefault();

        const item = form.closest<HTMLElement>(".tf-comment-item");
        if (form.dataset.form === "comment") void submitComment(form, postEl, null);
        else if (form.dataset.form === "reply" && item) void submitComment(form, postEl, item.dataset.commentId ?? null);
        else if (form.dataset.form === "edit-comment" && item) void saveCommentEdit(form, item);
    });

    return {
        posts,
        add(list, position = "append") {
            for (const post of list) posts.set(post.post_id, post);
            const html = list.map((post) => renderPost(post, options)).join("");
            container.insertAdjacentHTML(position === "append" ? "beforeend" : "afterbegin", html);
            markOverflow(container);
        },
        replace(post) {
            posts.set(post.post_id, post);
            const current = postElement(post.post_id);
            if (!current) return;
            current.insertAdjacentHTML("afterend", renderPost(post, options));
            const replacement = current.nextElementSibling as HTMLElement;
            current.remove();
            commentCursors.delete(post.post_id);
            markOverflow(replacement);
            if (options.single) void loadComments(replacement);
        },
        clear() {
            posts.clear();
            commentCursors.clear();
        },
        async loadComments(postId) {
            const el = postElement(postId);
            if (el) await loadComments(el);
        },
    };
}
