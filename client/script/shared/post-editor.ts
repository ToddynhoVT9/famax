/**
 * FAMAX — Modal de criar/editar post (Shared)
 *
 * Usado pela página da comunidade (criar e editar) e pela página do post
 * (editar). O modal é montado aqui, não copiado em cada HTML; os estilos
 * (.modal-*) estão em community.css, que as duas páginas carregam.
 */
import { api } from "./api.js";
import type { Post } from "./post-thread.js";

export interface PostCategory {
    community_category_id: string;
    name: string;
}

export interface PostEditorOptions {
    communityId: string;
    categories: PostCategory[];
    /** Post a editar; sem ele, cria um novo. */
    post?: Post;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Abre o modal e resolve com o post salvo (já no formato do feed), ou null
 * se a pessoa cancelar. Erros da API aparecem dentro do modal.
 */
export function openPostEditor(options: PostEditorOptions): Promise<Post | null> {
    const { post } = options;

    return new Promise((resolve) => {
        const previousFocus = document.activeElement as HTMLElement | null;

        const overlay = el("div", "modal-overlay show");
        const form = el("form", "modal-box");
        form.noValidate = true;
        form.setAttribute("role", "dialog");
        form.setAttribute("aria-modal", "true");
        form.setAttribute("aria-labelledby", "postEditorTitle");

        const header = el("div", "modal-header");
        const title = el("h2", "modal-title", post ? "Editar discussão" : "Criar nova discussão");
        title.id = "postEditorTitle";
        const close = el("button", "modal-close", "×");
        close.type = "button";
        close.setAttribute("aria-label", "Fechar");
        header.append(title, close);

        const error = el("div", "modal-error");
        error.setAttribute("role", "alert");

        const titleLabel = el("label", "modal-label", "Título do Post");
        const titleInput = el("input", "modal-input");
        titleInput.maxLength = 200;
        titleInput.placeholder = "Sobre o que você quer falar?";
        titleInput.value = post?.title ?? "";
        titleInput.id = "postEditorTitleInput";
        titleLabel.htmlFor = titleInput.id;

        const categoryLabel = el("label", "modal-label modal-label--spaced", "Categoria");
        const categorySelect = el("select", "modal-input modal-select");
        categorySelect.id = "postEditorCategory";
        categoryLabel.htmlFor = categorySelect.id;
        categorySelect.append(new Option("Sem categoria", ""));
        for (const category of options.categories) {
            categorySelect.append(new Option(category.name, category.community_category_id));
        }
        categorySelect.value = post?.community_category_id ?? "";

        const contentLabel = el("label", "modal-label modal-label--spaced", "Conteúdo");
        const contentInput = el("textarea", "modal-textarea");
        contentInput.id = "postEditorContent";
        contentLabel.htmlFor = contentInput.id;
        contentInput.maxLength = 10_000;
        contentInput.placeholder = "Escreva os detalhes da sua discussão aqui...";
        contentInput.value = post?.content ?? "";

        const actions = el("div", "modal-actions");
        const cancel = el("button", "modal-btn-secondary", "Cancelar");
        cancel.type = "button";
        const submit = el("button", "modal-btn-primary", post ? "Salvar alterações" : "Publicar Post");
        submit.type = "submit";
        actions.append(cancel, submit);

        form.append(header, error, titleLabel, titleInput, categoryLabel, categorySelect, contentLabel, contentInput, actions);
        overlay.append(form);
        document.body.append(overlay);
        window.setTimeout(() => titleInput.focus(), 30);

        const showError = (message: string | null): void => {
            error.textContent = message ?? "";
            error.classList.toggle("show", message !== null);
        };

        const finish = (result: Post | null): void => {
            document.removeEventListener("keydown", onKey);
            overlay.remove();
            previousFocus?.focus();
            resolve(result);
        };

        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") finish(null);
        };

        close.addEventListener("click", () => finish(null));
        cancel.addEventListener("click", () => finish(null));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) finish(null);
        });
        document.addEventListener("keydown", onKey);

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const titleValue = titleInput.value.trim();
            const content = contentInput.value.trim();
            const categoryId = categorySelect.value || null;

            if (titleValue.length < 3) return showError("O título deve ter no mínimo 3 caracteres.");
            if (!content) return showError("Escreva o conteúdo da discussão.");

            submit.disabled = true;
            showError(null);
            try {
                const result = post
                    ? await api<{ post: Post }>(`/posts/${encodeURIComponent(post.post_id)}`, {
                          method: "PATCH",
                          body: JSON.stringify({ title: titleValue, content, communityCategoryId: categoryId }),
                      })
                    : await api<{ post: Post }>("/posts", {
                          method: "POST",
                          body: JSON.stringify({
                              communityId: options.communityId,
                              communityCategoryId: categoryId,
                              title: titleValue,
                              content,
                          }),
                      });
                finish(result.post);
            } catch (err) {
                showError(err instanceof Error ? err.message : "Não foi possível salvar.");
                submit.disabled = false;
            }
        });
    });
}
