/**
 * FAMAX — Página individual do post (post.html?id=)
 *
 * O post inteiro, com os comentários abertos, o breadcrumb Comunidade › Post e
 * um link próprio para compartilhar. Desenho e ações vêm de
 * shared/post-thread.ts, os mesmos do feed da comunidade.
 */
import { api } from "./shared/api.js";
import { initLayout } from "./shared/layout.js";
import { communityUrl, pages, postUrl } from "./shared/pages.js";
import { queryParam, truncate } from "./shared/dom.js";
import { toast } from "./shared/dialog.js";
import { createPostThread, type Post } from "./shared/post-thread.js";
import { markdownToText } from "./shared/markdown.js";
import { openPostEditor, type PostCategory } from "./shared/post-editor.js";

initLayout();

const postId = queryParam("id");

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

const container = $("postContainer");
const copyBtn = $<HTMLButtonElement>("btnCopyLink");

let categories: PostCategory[] | null = null;

function showStatus(message: string, isError = false): void {
    if (!container) return;
    container.innerHTML = `<div class="tf-feed-status${isError ? " error" : ""}"></div>`;
    const el = container.querySelector(".tf-feed-status");
    if (el) el.textContent = message;
}

/** Título da aba e meta description refletem o post. */
function applyMeta(post: Post): void {
    document.title = `${post.title} · ${post.community_name} · FAMAX`;
    const heading = document.getElementById("postPageTitle");
    if (heading) heading.textContent = post.title;
    $("metaDescription")?.setAttribute("content", truncate(markdownToText(post.content), 160));

    const community = $<HTMLAnchorElement>("breadcrumbCommunity");
    if (community) {
        community.textContent = post.community_name;
        community.href = communityUrl(post.community_id);
    }
    const crumb = $("breadcrumbPost");
    if (crumb) crumb.textContent = truncate(post.title, 60);
}

const thread = container
    ? createPostThread(container, {
          single: true,
          onEditPost: async (post) => {
              // As subcategorias só são buscadas se o autor abrir o editor.
              if (!categories) {
                  try {
                      const result = await api<{ categories: PostCategory[] }>(
                          `/communities/${encodeURIComponent(post.community_id)}`,
                      );
                      categories = result.categories;
                  } catch {
                      categories = [];
                  }
              }
              const saved = await openPostEditor({
                  communityId: post.community_id,
                  categories,
                  post,
              });
              if (saved) {
                  thread?.replace(saved);
                  applyMeta(saved);
                  toast("Discussão atualizada.");
              }
          },
          // Sem post não há o que mostrar aqui: volta para a comunidade.
          onPostDeleted: () => {
              const post = currentPost;
              window.location.replace(post ? communityUrl(post.community_id) : pages.home);
          },
      })
    : null;

let currentPost: Post | null = null;

copyBtn?.addEventListener("click", async () => {
    if (!postId) return;
    const link = new URL(postUrl(postId), window.location.origin).toString();
    try {
        await navigator.clipboard.writeText(link);
        toast("Link copiado.");
    } catch {
        // Sem permissão de área de transferência (ou contexto sem HTTPS):
        // mostra o link para copiar à mão.
        toast(`Copie o link: ${link}`);
    }
});

async function init(): Promise<void> {
    if (!postId || !thread || !container) {
        showStatus("Nenhuma discussão selecionada.", true);
        return;
    }

    try {
        const { post } = await api<{ post: Post }>(`/posts/${encodeURIComponent(postId)}`);
        currentPost = post;
        applyMeta(post);
        container.innerHTML = "";
        thread.add([post]);
        if (copyBtn) copyBtn.disabled = false;
        await thread.loadComments(post.post_id);

        // Link de notificação: #comment-<id> rola até o comentário.
        const anchor = window.location.hash.match(/^#comment-([0-9a-f-]{36})$/i);
        if (anchor && !(await thread.revealComment(post.post_id, anchor[1]))) {
            toast("Esse comentário não está mais disponível.");
        }
    } catch (err) {
        showStatus(err instanceof Error ? err.message : "Não foi possível carregar a discussão.", true);
    }
}

void init();
