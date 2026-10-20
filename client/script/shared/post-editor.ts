/**
 * FAMAX — Modal de criar/editar post (Shared)
 *
 * Usado pela página da comunidade (criar e editar) e pela página do post
 * (editar). O modal é montado aqui, não copiado em cada HTML; os estilos
 * (.modal-*) estão em community.css, que as duas páginas carregam.
 *
 * Imagens (até 4): escolhidas aqui, mas só enviadas DEPOIS que o post foi
 * salvo — POST /posts/:id/images precisa do post existindo, e assim um
 * cancelamento não deixa imagem órfã no Storage. Na edição, as imagens
 * marcadas para remover também só saem ao salvar.
 */
import { api, getMe } from "./api.js";
import { toast } from "./dialog.js";
import type { Post } from "./post-thread.js";
import { MAX_POST_IMAGES, type PostImage } from "./post-images.js";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

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
        const contentHint = el(
            "p",
            "modal-hint",
            "Aceita markdown: **negrito**, *itálico*, [link](https://...), listas, `código`, > citação, ||spoiler|| e @menções.",
        );

        // ----- +18 (só para quem tem conteúdo adulto liberado) -----
        const nsfwLabel = el("label", "modal-checkbox");
        const nsfwInput = el("input");
        nsfwInput.type = "checkbox";
        nsfwInput.checked = post?.post_is_nsfw ?? false;
        nsfwLabel.append(nsfwInput, " Conteúdo adulto (+18): só quem tem conteúdo adulto liberado vê");
        nsfwLabel.hidden = !post?.post_is_nsfw;
        void getMe()
            .then((me) => {
                if (me.isAdult) nsfwLabel.hidden = false;
            })
            .catch(() => {});

        // ----- Imagens -----
        const imagesLabel = el("span", "modal-label modal-label--spaced", `Imagens (até ${MAX_POST_IMAGES})`);
        const imagesList = el("div", "modal-images");
        const fileInput = el("input", "visually-hidden");
        fileInput.type = "file";
        fileInput.accept = IMAGE_TYPES.join(",");
        fileInput.multiple = true;
        fileInput.id = "postEditorImages";
        const addImages = el("label", "modal-btn-secondary modal-add-images", "Adicionar imagens");
        addImages.htmlFor = fileInput.id;
        addImages.tabIndex = 0;
        addImages.setAttribute("role", "button");

        const existing: PostImage[] = [...(post?.images ?? [])];
        const removed = new Set<string>();
        const added: Array<{ file: File; preview: string }> = [];
        const total = (): number => existing.length - removed.size + added.length;

        const thumb = (src: string, onRemove: () => void): HTMLElement => {
            const item = el("div", "modal-image");
            const img = el("img");
            img.src = src;
            img.alt = "";
            const remove = el("button", "modal-image-remove", "×");
            remove.type = "button";
            remove.setAttribute("aria-label", "Remover imagem");
            remove.addEventListener("click", () => {
                onRemove();
                renderImages();
            });
            item.append(img, remove);
            return item;
        };

        function renderImages(): void {
            imagesList.replaceChildren(
                ...existing.filter((image) => !removed.has(image.image_id)).map((image) =>
                    thumb(image.url, () => removed.add(image.image_id)),
                ),
                ...added.map((entry, index) =>
                    thumb(entry.preview, () => {
                        URL.revokeObjectURL(entry.preview);
                        added.splice(index, 1);
                    }),
                ),
            );
            addImages.hidden = total() >= MAX_POST_IMAGES;
        }

        fileInput.addEventListener("change", () => {
            const files = Array.from(fileInput.files ?? []);
            fileInput.value = "";
            for (const file of files) {
                if (total() >= MAX_POST_IMAGES) {
                    showError(`Cada post pode ter no máximo ${MAX_POST_IMAGES} imagens.`);
                    break;
                }
                if (!IMAGE_TYPES.includes(file.type)) {
                    showError(`"${file.name}" não é PNG, JPEG ou WebP.`);
                    continue;
                }
                if (file.size > MAX_IMAGE_BYTES) {
                    showError(`"${file.name}" passa de 2MB.`);
                    continue;
                }
                added.push({ file, preview: URL.createObjectURL(file) });
            }
            renderImages();
        });
        addImages.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                fileInput.click();
            }
        });
        renderImages();

        const actions = el("div", "modal-actions");
        const cancel = el("button", "modal-btn-secondary", "Cancelar");
        cancel.type = "button";
        const submit = el("button", "modal-btn-primary", post ? "Salvar alterações" : "Publicar Post");
        submit.type = "submit";
        actions.append(cancel, submit);

        form.append(
            header,
            error,
            titleLabel,
            titleInput,
            categoryLabel,
            categorySelect,
            contentLabel,
            contentInput,
            contentHint,
            nsfwLabel,
            imagesLabel,
            imagesList,
            fileInput,
            addImages,
            actions,
        );
        overlay.append(form);
        document.body.append(overlay);
        window.setTimeout(() => titleInput.focus(), 30);

        const showError = (message: string | null): void => {
            error.textContent = message ?? "";
            error.classList.toggle("show", message !== null);
        };

        const finish = (result: Post | null): void => {
            for (const entry of added) URL.revokeObjectURL(entry.preview);
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

        /**
         * Depois do post salvo: tira as imagens marcadas e envia as novas.
         * Falha aqui não desfaz o post (ele já existe) — avisa e segue.
         */
        async function syncImages(saved: Post): Promise<Post> {
            let current = saved;
            try {
                for (const imageId of removed) {
                    const result = await api<{ post: Post }>(
                        `/posts/${encodeURIComponent(saved.post_id)}/images/${encodeURIComponent(imageId)}`,
                        { method: "DELETE" },
                    );
                    current = result.post;
                }
                if (added.length > 0) {
                    const body = new FormData();
                    for (const entry of added) body.append("images", entry.file);
                    const result = await api<{ post: Post }>(`/posts/${encodeURIComponent(saved.post_id)}/images`, {
                        method: "POST",
                        body,
                    });
                    current = result.post;
                }
            } catch (err) {
                toast(
                    `Discussão salva, mas as imagens não foram atualizadas: ${err instanceof Error ? err.message : "erro"}`,
                    "error",
                );
            }
            return current;
        }

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
                          body: JSON.stringify({
                              title: titleValue,
                              content,
                              communityCategoryId: categoryId,
                              ...(nsfwLabel.hidden ? {} : { isNsfw: nsfwInput.checked }),
                          }),
                      })
                    : await api<{ post: Post }>("/posts", {
                          method: "POST",
                          body: JSON.stringify({
                              communityId: options.communityId,
                              communityCategoryId: categoryId,
                              title: titleValue,
                              content,
                              isNsfw: !nsfwLabel.hidden && nsfwInput.checked,
                          }),
                      });
                finish(await syncImages(result.post));
            } catch (err) {
                showError(err instanceof Error ? err.message : "Não foi possível salvar.");
                submit.disabled = false;
            }
        });
    });
}
