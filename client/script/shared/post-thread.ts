/**
 * FAMAX — Posts e comentários (Shared)
 *
 * O desenho de um post, os comentários em árvore e todas as ações sobre eles
 * (curtir, comentar, responder, editar, excluir, denunciar e, para dono e
 * moderadores, remover e banir), usados pelo feed da comunidade e pela
 * página individual do post.
 *
 *  - Delegação de eventos: um listener no container cobre todos os posts,
 *    inclusive os que chegam depois pelo "carregar mais".
 *  - Comentários sob demanda: só são buscados quando o post é aberto.
 *  - Todo dado de usuário passa por escapeHtml (ou entra por textContent). O
 *    protótipo montava o post com interpolação crua — um título com
 *    <img src=x onerror=...> executava para todos os visitantes. O conteúdo
 *    de posts e comentários é markdown: passa por renderMarkdown (marked +
 *    DOMPurify, shared/markdown.ts), e o texto original fica em data-content
 *    para a edição.
 *  - Classes do design system (fx-post, fx-comment..., no post.css) só
 *    desenham; o código acha as partes pelos data-* (data-post-id,
 *    data-comment-id, data-comment-list...).
 */
import { api, getCurrentUserId, getToken } from "./api.js";
import { goToLogin } from "./auth-guard.js";
import { communityUrl, pages, postUrl, profileUrl } from "./pages.js";
import { avatarColor, escapeHtml, initials, timeAgo } from "./dom.js";
import { confirmDialog, toast } from "./dialog.js";
import {
    canModerate,
    openBanDialog,
    openReportDialog,
    roleBadgeHtml,
    type CommunityRole,
} from "./moderation.js";
import {
    applyToCounts,
    isReactionType,
    nextReaction,
    reactionControlHtml,
    reactionEmoji,
    reactionLabel,
    reactionSummaryHtml,
    type ReactionCounts,
    type ReactionType,
} from "./reactions.js";
import { renderMarkdown } from "./markdown.js";
import { skeleton } from "./skeleton.js";
import "./char-counter.js";
import { imagesGridHtml, openLightbox, type PostImage } from "./post-images.js";
import { ICONS } from "./icons.js";
import { openSheet } from "./layout.js";
import type { Comment, Post } from "../../../shared/api-types.js";
export type { Comment, Post };

// ===========================================================================
// Tipos
// ===========================================================================

export interface PostThreadOptions {
    /** Página do post: conteúdo inteiro, título sem link, comentários abertos. */
    single?: boolean;
    /** Feed com posts de várias comunidades (aba Seguindo): mostra de onde é cada um. */
    showCommunity?: boolean;
    /** Autor pediu para editar; quem chama abre o editor e usa replace(). */
    onEditPost?: (post: Post) => void;
    /** Post excluído e já removido da tela. */
    onPostDeleted?: (postId: string) => void;
}

const COMMENTS_PER_PAGE = 20;

/** Abaixo de 1024px, o ⋯ do post aberto abre numa folha inferior. */
const SHEET_MEDIA = window.matchMedia("(max-width: 1023px)");
/** Abaixo de 600px, "Copiar link" fica no ⋯ (e sai da barra do topo). */
const PHONE_MEDIA = window.matchMedia("(max-width: 599px)");

// ===========================================================================
// Utilidades
// ===========================================================================

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

function authorName(item: { authorDisplayName: string | null; authorUsername: string | null }): string {
    return item.authorDisplayName?.trim() || item.authorUsername || "Usuário";
}

/** Exige sessão; sem ela manda para o login e devolve false. */
function ensureLoggedIn(): boolean {
    if (getToken()) return true;
    goToLogin();
    return false;
}

const cssId = (id: string) => CSS.escape(id);

/** Copia o endereço do post; sem permissão, mostra o link para copiar à mão. */
export async function copyPostLink(postId: string): Promise<void> {
    const link = new URL(postUrl(postId), window.location.origin).toString();
    try {
        await navigator.clipboard.writeText(link);
        toast("Link copiado.");
    } catch {
        // Sem permissão de área de transferência (ou contexto sem HTTPS).
        toast(`Copie o link: ${link}`);
    }
}

// ===========================================================================
// Render
// ===========================================================================

const menuItem = (action: string, label: string, danger = false, extra = "") =>
    `<button type="button" class="fx-menu-item${danger ? " fx-menu-item--danger" : ""}" role="menuitem" data-action="${action}"${extra}>${label}</button>`;

/**
 * Itens do "⋯": o autor edita e exclui; os outros denunciam; dono e
 * moderadores, acima do autor na hierarquia, também removem e banem.
 * Visitante não tem menu.
 */
function postMenuItems(post: Post): string {
    if (!getToken()) return "";
    // Fixar vale para qualquer post, inclusive os da própria moderação.
    const pinItem =
        post.viewerRole === "owner" || post.viewerRole === "moderator"
            ? post.pinnedAt
                ? menuItem("unpin-post", "Desafixar")
                : menuItem("pin-post", "Fixar no topo")
            : "";
    if (post.authorId === getCurrentUserId()) {
        return pinItem + menuItem("edit-post", "Editar") + menuItem("delete-post", "Excluir", true);
    }
    let items = pinItem + menuItem("report-post", "Denunciar");
    if (canModerate(post.viewerRole, post.authorRole)) {
        items += menuItem("mod-remove-post", "Remover", true) + menuItem("ban-post-author", "Banir autor", true);
    }
    return items;
}

/**
 * Post aberto, no celular: "Copiar link" sai da barra do topo e vai para o
 * ⋯ (o post-page.css esconde o botão da barra; o post.css só mostra este
 * item abaixo de 600px). Para o visitante, o ⋯ só existe no celular.
 */
const COPY_LINK_ITEM = menuItem("copy-link", `${ICONS.link}Copiar link`, false, " data-phone-only");

function postMenuHtml(post: Post, single: boolean): string {
    const items = postMenuItems(post);
    if (!items && !single) return "";
    return `<div class="fx-post-menu${items ? "" : " fx-post-menu--phone"}" data-post-menu>
               <button type="button" class="fx-btn fx-btn--icon fx-btn--icon-paper" data-action="post-menu"
                       aria-haspopup="menu" aria-expanded="false" aria-label="Opções do post">${ICONS.dots}</button>
               <div class="fx-menu" role="menu" aria-label="Opções do post" hidden>${single ? COPY_LINK_ITEM : ""}${items}</div>
           </div>`;
}

/** Selos "Fixado" e "Resolvido" acima do título. */
function postBadges(post: Post): string {
    const badges = [
        post.pinnedAt ? '<span class="fx-badge fx-badge--warning">Fixado</span>' : "",
        post.resolvedCommentId ? '<span class="fx-badge fx-badge--success">✓ Resolvido</span>' : "",
        post.isNsfw ? '<span class="fx-badge fx-badge--danger-solid">+18</span>' : "",
    ].join("");
    return `<div class="fx-post-badges" data-post-badges${badges ? "" : " hidden"}>${badges}</div>`;
}

export function renderPost(post: Post, options: { single?: boolean; showCommunity?: boolean } = {}): string {
    const name = authorName(post);
    const id = escapeHtml(post.postId);
    const title = escapeHtml(post.title);
    const single = Boolean(options.single);

    // No feed o título leva à página do post; na própria página é só título.
    const heading = single
        ? `<h1 class="fx-post-title">${title}</h1>`
        : `<h3 class="fx-post-title"><a class="fx-post-title-link" href="${escapeHtml(postUrl(post.postId))}">${title}</a></h3>`;

    const meta = [
        `<strong data-author-id="${escapeHtml(post.authorId)}">${escapeHtml(name)}</strong>${roleBadgeHtml(post.authorRole)}`,
        options.showCommunity
            ? `em <a class="fx-post-community" href="${escapeHtml(communityUrl(post.communityId))}">${escapeHtml(post.communityName)}</a>`
            : "",
        post.categoryName ? `em ${escapeHtml(post.categoryName)}` : "",
        `${escapeHtml(timeAgo(post.createdAt))}${post.editedAt ? ' <span class="fx-post-edited">(editado)</span>' : ""}`,
    ]
        .filter(Boolean)
        .join(" · ");

    // Post aberto: o texto inteiro. Feed: o trecho, cortado em 4 linhas.
    const content = single
        ? `<div class="fx-md">${renderMarkdown(post.content)}</div>`
        : `<div class="fx-post-snippet fx-md" data-snippet>${renderMarkdown(post.content)}</div>
           <button type="button" class="fx-read-more" data-action="read-more" hidden>ler mais</button>`;

    // O campo de comentar fica logo abaixo das ações do post; a lista vem depois.
    return `
        <article class="fx-post${single ? " fx-post--single" : ""}${post.authorBlockedByMe ? " is-blocked" : ""}" data-post-id="${id}">
            ${post.authorBlockedByMe ? BLOCKED_NOTICE : ""}
            <span class="fx-avatar fx-avatar--md ${avatarColor(post.authorId)}" data-author-id="${escapeHtml(post.authorId)}" aria-hidden="true">${escapeHtml(initials(name))}</span>
            <div class="fx-post-body">
                <div class="fx-post-head">
                    <p class="fx-post-meta">${meta}</p>
                    ${postMenuHtml(post, single)}
                </div>
                ${postBadges(post)}
                ${heading}
                ${post.nsfwHidden ? nsfwNoticeHtml() : `${content}${imagesGridHtml(post.images, { scroll: single })}`}
                <div class="fx-post-stats"${post.nsfwHidden ? " hidden" : ""}>
                    ${reactionControlHtml(post.myReaction ?? null, post.likesCount, post.reactionCounts ?? {})}
                    <button type="button" class="fx-stat" data-action="toggle-comments"
                            aria-expanded="${single ? "true" : "false"}" aria-label="Comentários">
                        ${ICONS.comment}<span data-count="comments">${post.commentsCount}</span>
                    </button>
                    ${saveButtonHtml(post.savedByMe)}
                </div>
                <div class="fx-post-discussion" data-comments${single ? "" : " hidden"}>
                    <form class="fx-compose" data-form="comment">
                        <input type="text" class="fx-input fx-input--paper fx-input--pill" maxlength="2000" data-char-counter="near"
                               placeholder="Escreva um comentário... (**negrito**, @menção, ||spoiler||)" aria-label="Comentário" />
                        <button type="submit" class="fx-btn fx-btn--dark fx-btn--pill">Comentar</button>
                    </form>
                    <p class="fx-post-error" data-inline-error role="alert" hidden></p>
                    <section class="fx-post-comments" aria-label="Comentários">
                        <div class="fx-comments" data-comment-list></div>
                        <button type="button" class="fx-btn fx-btn--outline-ink fx-btn--sm fx-btn--pill" data-action="more-comments" hidden>Carregar mais comentários</button>
                    </section>
                </div>
            </div>
        </article>
    `;
}

function saveButtonHtml(saved: boolean): string {
    return `<button type="button" class="fx-stat fx-stat--save${saved ? " is-active" : ""}" data-action="save"
                    aria-pressed="${saved}" title="${saved ? "Tirar dos salvos" : "Salvar para ler depois"}">
                ${ICONS.bookmark}<span>${saved ? "Salvo" : "Salvar"}</span>
            </button>`;
}

/**
 * Conteúdo de quem a pessoa bloqueou: recolhido, com um "mostrar" que só
 * abre ali (não desbloqueia ninguém). O CSS esconde o resto enquanto o
 * item tem .is-blocked.
 */
const BLOCKED_NOTICE = `<p class="fx-notice">Conteúdo de usuário bloqueado —
    <button type="button" class="fx-link" data-action="show-blocked">mostrar</button></p>`;

/** No lugar do conteúdo +18, para quem não pode ver (o servidor nem o mandou). */
function nsfwNoticeHtml(): string {
    return `<p class="fx-banner fx-banner--neutral fx-post-nsfw">Conteúdo para maiores de 18. Para ver, ative “Conteúdo adulto” nas
        <a href="${escapeHtml(pages.settings)}">configurações</a> (exige 18 anos pela data de nascimento).</p>`;
}

/** "ler mais" só aparece onde o texto realmente foi cortado. */
export function markOverflow(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>("[data-snippet]:not(.is-expanded)").forEach((snippet) => {
        const button = snippet.nextElementSibling as HTMLElement | null;
        if (button?.dataset.action === "read-more") {
            button.hidden = snippet.scrollHeight <= snippet.clientHeight + 2;
        }
    });
}

/**
 * Contexto do post que muda o desenho de um comentário: o papel de quem vê
 * (pode moderar?), a resposta aceita e se quem vê é o autor do post (pode
 * marcar a resposta).
 */
interface CommentContext {
    viewerRole: CommunityRole | null;
    resolvedId: string | null;
    viewerIsPostAuthor: boolean;
}

function commentContext(post: Post | undefined): CommentContext {
    return {
        viewerRole: post?.viewerRole ?? null,
        resolvedId: post?.resolvedCommentId ?? null,
        viewerIsPostAuthor: Boolean(post && post.authorId === getCurrentUserId()),
    };
}

const NO_CONTEXT: CommentContext = { viewerRole: null, resolvedId: null, viewerIsPostAuthor: false };

function renderCommentMain(comment: Comment, context: CommentContext = NO_CONTEXT): string {
    const viewerRole = context.viewerRole;
    if (comment.isDeleted) {
        return `<div class="fx-comment-main" data-comment-main>
                    <p class="fx-comment-text is-removed">[comentário removido]</p>
                    <div class="fx-comment-foot"><span class="fx-comment-time">${escapeHtml(timeAgo(comment.createdAt))}</span></div>
                </div>`;
    }
    const mine = comment.authorId === getCurrentUserId();
    let actions = "";
    if (mine) {
        actions = `<button type="button" class="fx-comment-action" data-action="edit-comment">Editar</button>
                   <button type="button" class="fx-comment-action fx-comment-action--danger" data-action="delete-comment">Excluir</button>`;
    } else if (getToken()) {
        actions = `<button type="button" class="fx-comment-action" data-action="report-comment">Denunciar</button>`;
        if (canModerate(viewerRole, comment.authorRole)) {
            actions += `<button type="button" class="fx-comment-action fx-comment-action--danger" data-action="mod-remove-comment">Remover</button>
                        <button type="button" class="fx-comment-action fx-comment-action--danger" data-action="ban-comment-author">Banir</button>`;
        }
    }
    const accepted = comment.commentId === context.resolvedId;
    if (context.viewerIsPostAuthor) {
        actions += accepted
            ? '<button type="button" class="fx-comment-action" data-action="unaccept-answer">Desmarcar resposta</button>'
            : '<button type="button" class="fx-comment-action" data-action="accept-answer">Marcar como resposta</button>';
    }
    return `<div class="fx-comment-main" data-comment-main>
                <div class="fx-comment-head">
                    <strong class="fx-comment-author" data-author-id="${escapeHtml(comment.authorId ?? "")}">${escapeHtml(authorName(comment))}</strong>${roleBadgeHtml(comment.authorRole)}${accepted ? '<span class="fx-badge fx-badge--success-solid" data-accepted-badge>✓ Resposta aceita</span>' : ""}
                </div>
                <div class="fx-comment-text fx-md" data-comment-text data-content="${escapeHtml(comment.content ?? "")}">${renderMarkdown(comment.content ?? "")}</div>
                <div class="fx-comment-foot">
                    <span class="fx-comment-time">${escapeHtml(timeAgo(comment.createdAt))}${comment.editedAt ? " · editado" : ""}</span>
                    <button type="button" class="fx-comment-action" data-action="reply">Responder</button>
                    ${actions}
                </div>
            </div>`;
}

function renderComment(comment: Comment, depth: number, context: CommentContext): string {
    const accepted = !comment.isDeleted && comment.commentId === context.resolvedId;
    // id: âncora #comment-<id> dos links de notificação.
    return `<div class="fx-comment${comment.isDeleted ? " is-deleted" : ""}${accepted ? " is-accepted" : ""}${comment.authorBlockedByMe ? " is-blocked" : ""}"
                 id="comment-${escapeHtml(comment.commentId)}"
                 data-comment-id="${escapeHtml(comment.commentId)}" data-depth="${depth}"
                 data-created-at="${escapeHtml(comment.createdAt)}" data-edited="${comment.editedAt ? "true" : "false"}"
                 data-author-role="${escapeHtml(comment.authorRole ?? "")}">
                ${comment.authorBlockedByMe ? BLOCKED_NOTICE : ""}
                ${renderCommentMain(comment, context)}
                <div class="fx-replies" data-replies></div>
            </div>`;
}

/**
 * Comentários ficam só no DOM (a thread não guarda a lista). Para redesenhar
 * os botões de um comentário — ao marcar a resposta aceita — os dados voltam
 * dos data-* e do texto já na tela.
 */
function commentFromDom(item: HTMLElement, main: HTMLElement): Comment | null {
    const id = item.dataset.commentId;
    const author = main.querySelector<HTMLElement>("[data-author-id]");
    if (!id || !author) return null;
    return {
        commentId: id,
        parentCommentId: null,
        content: main.querySelector<HTMLElement>("[data-comment-text]")?.dataset.content ?? "",
        createdAt: item.dataset.createdAt ?? new Date().toISOString(),
        editedAt: item.dataset.edited === "true" ? item.dataset.createdAt ?? null : null,
        isDeleted: false,
        repliesCount: 0,
        authorId: author.dataset.authorId ?? null,
        authorUsername: null,
        authorDisplayName: author.textContent,
        authorRole: (item.dataset.authorRole || null) as CommunityRole | null,
    };
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
    /**
     * Rola até um comentário e o destaca, carregando mais páginas enquanto
     * ele não aparece. Devolve false se não achou (apagado, por exemplo).
     */
    revealComment(postId: string, commentId: string): Promise<boolean>;
}

export function createPostThread(container: HTMLElement, options: PostThreadOptions = {}): PostThread {
    const posts = new Map<string, Post>();
    /** Cursor da próxima página de comentários; ausente = ainda não carregou. */
    const commentCursors = new Map<string, string | null>();

    const postElement = (postId: string) =>
        container.querySelector<HTMLElement>(`[data-post-id="${cssId(postId)}"]`);

    // ----- Reagir ---------------------------------------------------------

    /** Reflete a reação no botão, no seletor, no resumo e no Post guardado. */
    function applyReaction(
        postEl: HTMLElement,
        reaction: ReactionType | null,
        total: number,
        counts: ReactionCounts,
    ): void {
        const button = postEl.querySelector<HTMLButtonElement>('[data-action="like"]');
        if (button) {
            button.dataset.reaction = reaction ?? "";
            button.setAttribute("aria-pressed", String(reaction !== null));
            button.setAttribute(
                "aria-label",
                reaction ? `Sua reação: ${reactionLabel(reaction)}. Clique para desfazer` : "Curtir",
            );
            button.classList.toggle("is-active", reaction !== null);
            const emoji = button.querySelector("[data-react-emoji]");
            if (emoji) emoji.textContent = reactionEmoji(reaction);
            const countEl = button.querySelector('[data-count="likes"]');
            if (countEl) countEl.textContent = String(total);
        }
        postEl.querySelectorAll<HTMLElement>('[data-action="react"]').forEach((option) => {
            option.classList.toggle("is-mine", option.dataset.type === reaction);
        });
        const summary = postEl.querySelector("[data-react-summary]");
        summary?.insertAdjacentHTML("afterend", reactionSummaryHtml(counts));
        summary?.remove();

        const post = posts.get(postEl.dataset.postId ?? "");
        if (post) {
            post.myReaction = reaction;
            post.likedByMe = reaction !== null;
            post.likesCount = total;
            post.reactionCounts = counts;
        }
    }

    /** requested null = botão principal (curtir / desfazer). */
    async function react(postEl: HTMLElement, requested: ReactionType | null): Promise<void> {
        const postId = postEl.dataset.postId;
        const post = postId ? posts.get(postId) : undefined;
        if (!postId || !post || !ensureLoggedIn()) return;

        // Uma reação por vez. aria-disabled, e não disabled: o botão
        // desativado perderia o foco de quem escolheu pelo teclado.
        const button = postEl.querySelector<HTMLButtonElement>('[data-action="like"]');
        if (button?.getAttribute("aria-disabled") === "true") return;
        button?.setAttribute("aria-disabled", "true");

        // Otimista: o clique responde na hora e volta atrás se a API recusar.
        const before = {
            reaction: post.myReaction ?? null,
            total: post.likesCount,
            counts: { ...(post.reactionCounts ?? {}) },
        };
        const guess = nextReaction(before.reaction, requested);
        const delta = (guess ? 1 : 0) - (before.reaction ? 1 : 0);
        applyReaction(postEl, guess, Math.max(0, before.total + delta), applyToCounts(before.counts, before.reaction, guess));

        try {
            const result = await api.posts.react(postId, requested);
            applyReaction(
                postEl,
                isReactionType(result.reaction) ? result.reaction : null,
                result.likesCount,
                result.reactionCounts,
            );
        } catch (err) {
            applyReaction(postEl, before.reaction, before.total, before.counts);
            toast(errorMessage(err, "Não foi possível reagir."), "error");
        } finally {
            button?.removeAttribute("aria-disabled");
        }
    }

    // Seletor: abre ao parar o mouse no botão, ao segurar (toque) ou com a
    // seta para cima; fecha ao sair, com Esc ou ao escolher.
    const pickerTimers = new WeakMap<HTMLElement, number>();
    /** Depois de um toque longo, o click que vem em seguida não conta. */
    let suppressNextClick = false;

    function setPicker(wrapper: HTMLElement, open: boolean, focusFirst = false): void {
        window.clearTimeout(pickerTimers.get(wrapper));
        const picker = wrapper.querySelector<HTMLElement>("[data-react-picker]");
        const button = wrapper.querySelector<HTMLElement>('[data-action="like"]');
        if (!picker || !button) return;
        if (open && !getToken()) return; // visitante: o clique leva ao login
        picker.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
        if (open && focusFirst) picker.querySelector<HTMLElement>('[data-action="react"]')?.focus();
    }

    function schedulePicker(wrapper: HTMLElement, open: boolean, delay: number): void {
        window.clearTimeout(pickerTimers.get(wrapper));
        pickerTimers.set(wrapper, window.setTimeout(() => setPicker(wrapper, open), delay));
    }

    container.addEventListener("mouseover", (event) => {
        const wrapper = (event.target as Element).closest<HTMLElement>("[data-react]");
        if (wrapper && !wrapper.contains(event.relatedTarget as Node | null)) schedulePicker(wrapper, true, 450);
    });
    container.addEventListener("mouseout", (event) => {
        const wrapper = (event.target as Element).closest<HTMLElement>("[data-react]");
        if (wrapper && !wrapper.contains(event.relatedTarget as Node | null)) schedulePicker(wrapper, false, 300);
    });
    container.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch") return;
        const button = (event.target as Element).closest<HTMLElement>('[data-action="like"]');
        const wrapper = button?.closest<HTMLElement>("[data-react]");
        if (!wrapper) return;
        pickerTimers.set(
            wrapper,
            window.setTimeout(() => {
                suppressNextClick = true;
                setPicker(wrapper, true);
            }, 500),
        );
    });
    container.addEventListener("pointerup", (event) => {
        const wrapper = (event.target as Element).closest<HTMLElement>("[data-react]");
        const picker = wrapper?.querySelector<HTMLElement>("[data-react-picker]");
        // Soltou antes de abrir: era um toque normal.
        if (wrapper && picker?.hidden) window.clearTimeout(pickerTimers.get(wrapper));
    });
    container.addEventListener("keydown", (event) => {
        const target = event.target as HTMLElement;
        const wrapper = target.closest<HTMLElement>("[data-react]");
        if (!wrapper) return;
        if (event.key === "ArrowUp" && target.dataset.action === "like") {
            event.preventDefault();
            setPicker(wrapper, true, true);
        } else if (event.key === "Escape") {
            setPicker(wrapper, false);
            wrapper.querySelector<HTMLElement>('[data-action="like"]')?.focus();
        } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && target.dataset.action === "react") {
            event.preventDefault();
            const sibling = event.key === "ArrowRight" ? target.nextElementSibling : target.previousElementSibling;
            (sibling as HTMLElement | null)?.focus();
        }
    });

    // ----- Excluir post ---------------------------------------------------

    /** asModerator: dono/moderador removendo o post de outra pessoa. */
    async function deletePost(article: HTMLElement, asModerator = false): Promise<void> {
        const postId = article.dataset.postId;
        if (!postId) return;

        const ok = await confirmDialog({
            title: asModerator ? "Remover discussão?" : "Excluir discussão?",
            message: asModerator
                ? "Você está removendo como moderação. A discussão some da comunidade para todos e as denúncias abertas sobre ela são encerradas."
                : "A discussão some da comunidade para todos. Esta ação não pode ser desfeita.",
            confirmLabel: asModerator ? "Remover" : "Excluir",
            danger: true,
        });
        if (!ok) return;

        try {
            await api.posts.remove(postId);
            article.remove();
            posts.delete(postId);
            toast(asModerator ? "Discussão removida." : "Discussão excluída.");
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
        const list = postEl.querySelector<HTMLElement>("[data-comment-list]");
        if (!list) return;
        list.querySelector("[data-comment-status]")?.remove();
        const context = commentContext(posts.get(postEl.dataset.postId ?? ""));

        for (const comment of comments) {
            const parent = comment.parentCommentId
                ? list.querySelector<HTMLElement>(`[data-comment-id="${cssId(comment.parentCommentId)}"]`)
                : null;
            const target = parent ? parent.querySelector<HTMLElement>(":scope > [data-replies]") : list;
            const depth = parent ? Number(parent.dataset.depth ?? "0") + 1 : 0;
            target?.insertAdjacentHTML("beforeend", renderComment(comment, depth, context));
        }
    }

    function setInlineError(postEl: HTMLElement, message: string | null): void {
        const el = postEl.querySelector<HTMLElement>("[data-inline-error]");
        if (!el) return;
        el.textContent = message ?? "";
        el.hidden = message === null;
    }

    async function loadComments(postEl: HTMLElement, more = false): Promise<void> {
        const postId = postEl.dataset.postId;
        const list = postEl.querySelector<HTMLElement>("[data-comment-list]");
        const moreBtn = postEl.querySelector<HTMLButtonElement>('[data-action="more-comments"]');
        if (!postId || !list || !moreBtn) return;

        const cursor = more ? commentCursors.get(postId) : null;
        if (!more) list.replaceChildren(skeleton("comment", 2, "Carregando comentários..."));
        moreBtn.disabled = true;

        try {
            const params = new URLSearchParams({ limit: String(COMMENTS_PER_PAGE) });
            if (cursor) params.set("cursor", cursor);
            const { data, nextCursor } = await api.posts.comments(postId, { limit: COMMENTS_PER_PAGE, cursor });

            commentCursors.set(postId, nextCursor);
            if (!more) list.innerHTML = "";
            insertComments(postEl, data);
            if (list.childElementCount === 0) {
                list.innerHTML = '<p class="fx-comment-status" data-comment-status>Nenhum comentário ainda.</p>';
            }
            moreBtn.hidden = !nextCursor;
        } catch (err) {
            if (!more) {
                commentCursors.delete(postId);
                list.innerHTML = '<p class="fx-comment-status" data-comment-status></p>';
                const status = list.querySelector("[data-comment-status]");
                if (status) status.textContent = errorMessage(err, "Erro ao carregar comentários.");
            } else {
                toast(errorMessage(err, "Erro ao carregar comentários."), "error");
            }
        } finally {
            moreBtn.disabled = false;
        }
    }

    function bumpCommentCount(postEl: HTMLElement, delta: number): void {
        const countEl = postEl.querySelector('[data-count="comments"]');
        if (countEl) countEl.textContent = String(Math.max(0, Number(countEl.textContent ?? "0") + delta));
        const post = posts.get(postEl.dataset.postId ?? "");
        if (post) post.commentsCount = Math.max(0, post.commentsCount + delta);
    }

    async function submitComment(form: HTMLFormElement, postEl: HTMLElement, parentId: string | null): Promise<void> {
        const postId = postEl.dataset.postId;
        const input = form.querySelector<HTMLInputElement>("input");
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (!postId || !input) return;

        const content = input.value.trim();
        if (!content || !ensureLoggedIn()) return;

        if (submit) submit.disabled = true;
        setInlineError(postEl, null);
        try {
            const { comment } = await api.posts.comment(postId, content, parentId);
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
        const existing = item.querySelector<HTMLFormElement>(':scope > form[data-form="reply"]');
        if (existing) {
            existing.querySelector<HTMLInputElement>("input")?.focus();
            return;
        }
        const name = item.querySelector(":scope > [data-comment-main] [data-author-id]")?.textContent ?? "";
        const form = document.createElement("form");
        form.className = "fx-compose fx-comment-reply";
        form.dataset.form = "reply";
        form.innerHTML = `
            <input type="text" class="fx-input fx-input--paper fx-input--pill" maxlength="2000" data-char-counter="near" aria-label="Resposta" />
            <button type="submit" class="fx-btn fx-btn--dark fx-btn--pill">Enviar</button>
            <button type="button" class="fx-comment-action" data-action="cancel-form">Cancelar</button>`;
        const input = form.querySelector<HTMLInputElement>("input");
        if (input) input.placeholder = `Responder a ${name}...`;
        item.querySelector(":scope > [data-comment-main]")?.after(form);
        input?.focus();
    }

    function openEditCommentForm(item: HTMLElement): void {
        const text = item.querySelector<HTMLElement>(":scope > [data-comment-main] [data-comment-text]");
        if (!text || item.querySelector(':scope > [data-comment-main] form[data-form="edit-comment"]')) return;

        const form = document.createElement("form");
        form.className = "fx-comment-edit";
        form.dataset.form = "edit-comment";
        form.innerHTML = `
            <textarea class="fx-input fx-input--paper" maxlength="2000" rows="3" data-char-counter="near" aria-label="Editar comentário"></textarea>
            <div class="fx-comment-edit-actions">
                <button type="button" class="fx-comment-action" data-action="cancel-form">Cancelar</button>
                <button type="submit" class="fx-btn fx-btn--dark fx-btn--sm">Salvar</button>
            </div>`;
        const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
        if (textarea) textarea.value = text.dataset.content ?? text.textContent ?? "";
        text.hidden = true;
        text.after(form);
        textarea?.focus();
    }

    async function saveCommentEdit(form: HTMLFormElement, item: HTMLElement): Promise<void> {
        const commentId = item.dataset.commentId;
        const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
        const save = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        const postEl = item.closest<HTMLElement>("[data-post-id]");
        if (!commentId || !textarea || !postEl) return;

        const content = textarea.value.trim();
        if (!content) return;

        if (save) save.disabled = true;
        try {
            const { comment } = await api.comments.update(commentId, content);
            item.dataset.edited = "true";
            const main = item.querySelector(":scope > [data-comment-main]");
            main?.insertAdjacentHTML(
                "afterend",
                renderCommentMain(comment, commentContext(posts.get(postEl.dataset.postId ?? ""))),
            );
            main?.remove();
        } catch (err) {
            setInlineError(postEl, errorMessage(err, "Não foi possível editar."));
            if (save) save.disabled = false;
        }
    }

    async function deleteComment(item: HTMLElement, asModerator = false): Promise<void> {
        const commentId = item.dataset.commentId;
        const postEl = item.closest<HTMLElement>("[data-post-id]");
        if (!commentId || !postEl) return;

        const ok = await confirmDialog({
            title: asModerator ? "Remover comentário?" : "Excluir comentário?",
            message: asModerator
                ? "Você está removendo como moderação. Se houver respostas, elas continuam visíveis e o comentário aparece como removido."
                : "Se houver respostas, elas continuam visíveis e o comentário aparece como removido.",
            confirmLabel: asModerator ? "Remover" : "Excluir",
            danger: true,
        });
        if (!ok) return;

        try {
            await api.comments.remove(commentId);
            const replies = item.querySelector(":scope > [data-replies]");
            if (replies && replies.childElementCount > 0) {
                // Mantém a conversa: o comentário vira "[comentário removido]".
                item.classList.add("is-deleted");
                const main = item.querySelector(":scope > [data-comment-main]");
                main?.insertAdjacentHTML(
                    "afterend",
                    renderCommentMain({
                        commentId: commentId,
                        parentCommentId: null,
                        content: null,
                        createdAt: new Date().toISOString(),
                        editedAt: null,
                        isDeleted: true,
                        repliesCount: replies.childElementCount,
                        authorId: null,
                        authorUsername: null,
                        authorDisplayName: null,
                    }),
                );
                main?.remove();
            } else {
                item.remove();
            }
            bumpCommentCount(postEl, -1);
            // A resposta aceita apagada reabre a pergunta (o servidor já fez).
            const post = posts.get(postEl.dataset.postId ?? "");
            if (post?.resolvedCommentId === commentId) applyResolution(postEl, null);
        } catch (err) {
            toast(errorMessage(err, "Não foi possível excluir."), "error");
        }
    }

    // ----- Salvar ------------------------------------------------------------

    function applySaved(postEl: HTMLElement, saved: boolean): void {
        const button = postEl.querySelector<HTMLElement>('[data-action="save"]');
        button?.insertAdjacentHTML("afterend", saveButtonHtml(saved));
        button?.remove();
        const post = posts.get(postEl.dataset.postId ?? "");
        if (post) post.savedByMe = saved;
    }

    async function toggleSave(postEl: HTMLElement): Promise<void> {
        const postId = postEl.dataset.postId;
        const post = postId ? posts.get(postId) : undefined;
        if (!postId || !post || !ensureLoggedIn()) return;
        const wasSaved = post.savedByMe;
        applySaved(postEl, !wasSaved); // otimista
        try {
            await api.posts.setSaved(postId, !wasSaved);
            toast(wasSaved ? "Removido dos salvos." : "Salvo! Veja seus salvos no seu perfil.");
        } catch (err) {
            applySaved(postEl, wasSaved);
            toast(errorMessage(err, "Não foi possível salvar."), "error");
        }
    }

    // ----- Fixar ------------------------------------------------------------

    async function setPinned(postEl: HTMLElement, pinned: boolean): Promise<void> {
        const postId = postEl.dataset.postId;
        if (!postId) return;
        try {
            const { post } = await api.posts.setPinned(postId, pinned);
            redraw(post);
            toast(pinned ? "Post fixado no topo da comunidade." : "Post desafixado.");
        } catch (err) {
            toast(errorMessage(err, "Não foi possível fixar."), "error");
        }
    }

    // ----- Resposta aceita -----------------------------------------------------

    /**
     * Reflete a resposta aceita na tela sem redesenhar a conversa: selo do
     * post, destaque e botões dos comentários.
     */
    function applyResolution(postEl: HTMLElement, commentId: string | null): void {
        const post = posts.get(postEl.dataset.postId ?? "");
        if (!post) return;
        post.resolvedCommentId = commentId;

        postEl.querySelector("[data-post-badges]")?.insertAdjacentHTML("afterend", postBadges(post));
        postEl.querySelector("[data-post-badges]")?.remove();

        const context = commentContext(post);
        postEl.querySelectorAll<HTMLElement>("[data-comment-id]:not(.is-deleted)").forEach((item) => {
            const id = item.dataset.commentId;
            const isAccepted = id === commentId;
            const wasAccepted = item.classList.contains("is-accepted");
            item.classList.toggle("is-accepted", isAccepted);
            if (isAccepted === wasAccepted && !context.viewerIsPostAuthor) return;
            const main = item.querySelector<HTMLElement>(":scope > [data-comment-main]");
            const comment = main && commentFromDom(item, main);
            if (!main || !comment) return;
            main.insertAdjacentHTML("afterend", renderCommentMain(comment, context));
            main.remove();
        });
    }

    async function setAnswer(postEl: HTMLElement, commentId: string | null): Promise<void> {
        const postId = postEl.dataset.postId;
        if (!postId) return;
        try {
            const { post } = await api.posts.setResolution(postId, commentId);
            applyResolution(postEl, post.resolvedCommentId);
            toast(commentId ? "Resposta marcada como aceita." : "Resposta desmarcada.");
        } catch (err) {
            toast(errorMessage(err, "Não foi possível marcar a resposta."), "error");
        }
    }

    // ----- Banir autor ------------------------------------------------------

    /**
     * Depois do ban a pessoa deixa de ser membro: os selos dela somem da tela.
     * Remover o que ela publicou é uma decisão separada (menu "Remover").
     */
    async function banAuthor(communityId: string, userId: string, name: string): Promise<void> {
        if (!(await openBanDialog(communityId, userId, name))) return;
        for (const post of posts.values()) {
            if (post.authorId === userId) post.authorRole = null;
        }
        container.querySelectorAll<HTMLElement>(`strong[data-author-id="${cssId(userId)}"]`).forEach((strong) => {
            const badge = strong.nextElementSibling;
            if (badge instanceof HTMLElement && badge.dataset.roleBadge !== undefined) badge.remove();
        });
    }

    // ----- Menus e delegação de eventos ------------------------------------

    function closeMenus(except?: Element): void {
        container.querySelectorAll<HTMLElement>('[data-post-menu] > [role="menu"]:not([hidden])').forEach((menu) => {
            if (except && menu.parentElement?.contains(except)) return;
            // O foco num item que vai sumir volta ao ⋯ (e a confirmação que o
            // item abrir devolve o foco a ele).
            const toggle = menu.previousElementSibling as HTMLElement | null;
            if (menu.contains(document.activeElement)) toggle?.focus();
            menu.hidden = true;
            toggle?.setAttribute("aria-expanded", "false");
        });
    }

    /**
     * Post aberto, no tablet e no celular: o ⋯ abre numa folha inferior. Os
     * itens da folha são cópias; o clique fecha a folha e repete o clique no
     * item original, que segue pela delegação abaixo como na lista.
     */
    function openMenuSheet(button: HTMLElement, menu: HTMLElement): void {
        const phone = PHONE_MEDIA.matches;
        const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .filter((original) => phone || original.dataset.phoneOnly === undefined)
            .map((original) => {
                const copy = original.cloneNode(true) as HTMLElement;
                copy.removeAttribute("data-action");
                copy.addEventListener("click", () => {
                    close();
                    original.click();
                });
                return copy;
            });
        if (items.length === 0) return;
        const title = document.createElement("span");
        title.className = "r-sheet-name";
        title.textContent = "Opções do post";
        const close = openSheet({ label: "Opções do post", menuLabel: "Opções do post", head: [title], items, opener: button });
    }

    document.addEventListener("click", (event) => closeMenus(event.target as Element));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeMenus();
    });

    container.addEventListener("click", (event) => {
        const target = event.target as Element;
        const actionEl = target.closest<HTMLElement>("[data-action]");
        const postEl = target.closest<HTMLElement>("[data-post-id]");
        const postId = postEl?.dataset.postId;

        if (actionEl && postEl && postId) {
            const item = actionEl.closest<HTMLElement>("[data-comment-id]");
            switch (actionEl.dataset.action) {
                case "like": {
                    if (suppressNextClick) {
                        suppressNextClick = false;
                        return;
                    }
                    const wrapper = actionEl.closest<HTMLElement>("[data-react]");
                    if (wrapper) setPicker(wrapper, false);
                    void react(postEl, null);
                    return;
                }
                case "react": {
                    const wrapper = actionEl.closest<HTMLElement>("[data-react]");
                    if (wrapper) setPicker(wrapper, false);
                    const type = actionEl.dataset.type;
                    if (isReactionType(type)) void react(postEl, type);
                    wrapper?.querySelector<HTMLElement>('[data-action="like"]')?.focus();
                    return;
                }
                case "toggle-comments": {
                    const panel = postEl.querySelector<HTMLElement>("[data-comments]");
                    if (!panel) return;
                    panel.hidden = !panel.hidden;
                    actionEl.setAttribute("aria-expanded", String(!panel.hidden));
                    if (!panel.hidden) {
                        if (!commentCursors.has(postId)) void loadComments(postEl);
                        panel.querySelector<HTMLInputElement>('[data-form="comment"] input')?.focus();
                    }
                    return;
                }
                case "more-comments":
                    void loadComments(postEl, true);
                    return;
                case "read-more": {
                    const snippet = postEl.querySelector<HTMLElement>("[data-snippet]");
                    const expanded = snippet?.classList.toggle("is-expanded") ?? false;
                    actionEl.textContent = expanded ? "ler menos" : "ler mais";
                    return;
                }
                case "post-menu": {
                    const menu = actionEl.nextElementSibling as HTMLElement | null;
                    if (!menu) return;
                    closeMenus(actionEl);
                    if (options.single && SHEET_MEDIA.matches) {
                        openMenuSheet(actionEl, menu);
                        return;
                    }
                    menu.hidden = !menu.hidden;
                    actionEl.setAttribute("aria-expanded", String(!menu.hidden));
                    return;
                }
                case "copy-link":
                    closeMenus();
                    void copyPostLink(postId);
                    return;
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
                case "report-post":
                    closeMenus();
                    void openReportDialog("post", postId);
                    return;
                case "mod-remove-post":
                    closeMenus();
                    void deletePost(postEl, true);
                    return;
                case "save":
                    void toggleSave(postEl);
                    return;
                case "show-blocked": {
                    // O item mais próximo recolhido: o comentário, ou o post.
                    const blocked = actionEl.closest<HTMLElement>(".is-blocked");
                    blocked?.classList.remove("is-blocked");
                    actionEl.closest(".fx-notice")?.remove();
                    if (blocked === postEl) markOverflow(postEl);
                    return;
                }
                case "open-image": {
                    const post = posts.get(postId);
                    if (post) openLightbox(post.images ?? [], Number(actionEl.dataset.index ?? "0"));
                    return;
                }
                case "pin-post":
                    closeMenus();
                    void setPinned(postEl, true);
                    return;
                case "unpin-post":
                    closeMenus();
                    void setPinned(postEl, false);
                    return;
                case "accept-answer":
                    if (item?.dataset.commentId) void setAnswer(postEl, item.dataset.commentId);
                    return;
                case "unaccept-answer":
                    void setAnswer(postEl, null);
                    return;
                case "ban-post-author": {
                    closeMenus();
                    const post = posts.get(postId);
                    if (post) void banAuthor(post.communityId, post.authorId, authorName(post));
                    return;
                }
                case "reply":
                    if (item) openReplyForm(item);
                    return;
                case "edit-comment":
                    if (item) openEditCommentForm(item);
                    return;
                case "delete-comment":
                    if (item) void deleteComment(item);
                    return;
                case "report-comment":
                    if (item?.dataset.commentId) void openReportDialog("comment", item.dataset.commentId);
                    return;
                case "mod-remove-comment":
                    if (item) void deleteComment(item, true);
                    return;
                case "ban-comment-author": {
                    const post = posts.get(postId);
                    const author = item?.querySelector<HTMLElement>(":scope > [data-comment-main] [data-author-id]");
                    if (post && author?.dataset.authorId) {
                        void banAuthor(post.communityId, author.dataset.authorId, author.textContent ?? "");
                    }
                    return;
                }
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
        const postEl = form?.closest<HTMLElement>("[data-post-id]");
        if (!form || !postEl) return;
        event.preventDefault();

        const item = form.closest<HTMLElement>("[data-comment-id]");
        if (form.dataset.form === "comment") void submitComment(form, postEl, null);
        else if (form.dataset.form === "reply" && item) void submitComment(form, postEl, item.dataset.commentId ?? null);
        else if (form.dataset.form === "edit-comment" && item) void saveCommentEdit(form, item);
    });

    /** Redesenha um post (edição, fixar/desafixar); os comentários recarregam se abertos. */
    function redraw(post: Post): void {
        posts.set(post.postId, post);
        const current = postElement(post.postId);
        if (!current) return;
        current.insertAdjacentHTML("afterend", renderPost(post, options));
        const replacement = current.nextElementSibling as HTMLElement;
        current.remove();
        commentCursors.delete(post.postId);
        markOverflow(replacement);
        if (options.single) void loadComments(replacement);
    }

    return {
        posts,
        add(list, position = "append") {
            for (const post of list) posts.set(post.postId, post);
            const html = list.map((post) => renderPost(post, options)).join("");
            container.insertAdjacentHTML(position === "append" ? "beforeend" : "afterbegin", html);
            markOverflow(container);
            // Régua da conferência (?conferir): um parágrafo do texto do post,
            // e não o bloco com listas. O atributo não muda nada fora dela.
            container
                .querySelector(".fx-post-snippet > p, .fx-post--single .fx-md > p")
                ?.setAttribute("data-conferir-cpl", "");
        },
        replace: redraw,
        clear() {
            posts.clear();
            commentCursors.clear();
        },
        async loadComments(postId) {
            const el = postElement(postId);
            if (el) await loadComments(el);
        },
        async revealComment(postId, commentId) {
            const postEl = postElement(postId);
            if (!postEl) return false;
            const find = () => postEl.querySelector<HTMLElement>(`[data-comment-id="${cssId(commentId)}"]`);
            // Limite de páginas: um link velho para um comentário apagado não
            // pode carregar a conversa inteira.
            for (let i = 0; i < 10 && !find() && commentCursors.get(postId); i++) {
                await loadComments(postEl, true);
            }
            const target = find();
            if (!target) return false;
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.classList.add("is-highlighted");
            window.setTimeout(() => target.classList.remove("is-highlighted"), 2500);
            return true;
        },
    };
}
