/**
 * FAMAX — Modal de criar/editar post (Shared)
 *
 * Usado pela página da comunidade (criar e editar) e pela página do post
 * (editar). A janela é a de formulário da R (shared/window.ts): o corpo rola
 * por dentro, e título e ações ficam à vista; no celular, tela cheia com
 * "Publicar" no topo. Os campos são Field e Button do components.css; o que
 * é só desta janela (.pe-*) está no post.css, que as duas páginas carregam.
 *
 * Imagens (até 4): escolhidas aqui, mas só enviadas DEPOIS que o post foi
 * salvo — POST /posts/:id/images precisa do post existindo, e assim um
 * cancelamento não deixa imagem órfã no Storage. Na edição, as imagens
 * marcadas para remover também só saem ao salvar.
 *
 * Post novo guarda rascunho (título, conteúdo, categoria, +18) no
 * localStorage, um por comunidade: fechar sem querer, recarregar ou cair a
 * conexão não perde o texto. Sai ao publicar ou em "Descartar rascunho".
 * Fechar com texto digitado pede confirmação.
 */
import { api, getMe } from "./api.js";
import { confirmDialog, toast } from "./dialog.js";
import { attachCharCounter } from "./char-counter.js";
import { createFormWindow } from "./window.js";
import { ICONS } from "./icons.js";
import type { Post } from "./post-thread.js";
import { MAX_POST_IMAGES, type PostImage } from "./post-images.js";
import type { PostCategory } from "../../../shared/api-types.js";
export type { PostCategory };

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

export interface PostEditorOptions {
    communityId: string;
    categories: PostCategory[];
    /** Post a editar; sem ele, cria um novo. */
    post?: Post;
    /** Nome da comunidade, no subtítulo da janela ("Em Hardware e montagem"). */
    communityName?: string;
}

interface PostDraft {
    title: string;
    content: string;
    categoryId: string;
    nsfw: boolean;
}

const draftKey = (communityId: string): string => `famax_post_draft:${communityId}`;

function readDraft(communityId: string): PostDraft | null {
    try {
        const raw = localStorage.getItem(draftKey(communityId));
        if (!raw) return null;
        const draft = JSON.parse(raw) as Partial<PostDraft>;
        return {
            title: typeof draft.title === "string" ? draft.title : "",
            content: typeof draft.content === "string" ? draft.content : "",
            categoryId: typeof draft.categoryId === "string" ? draft.categoryId : "",
            nsfw: draft.nsfw === true,
        };
    } catch {
        return null;
    }
}

function writeDraft(communityId: string, draft: PostDraft | null): void {
    try {
        if (!draft || (!draft.title.trim() && !draft.content.trim())) {
            localStorage.removeItem(draftKey(communityId));
        } else {
            localStorage.setItem(draftKey(communityId), JSON.stringify(draft));
        }
    } catch {
        // Sem armazenamento (modo privado, cota): segue sem rascunho.
    }
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
        const win = createFormWindow({
            title: post ? "Editar discussão" : "Criar nova discussão",
            subtitle: options.communityName ? `Em ${options.communityName}` : undefined,
            onRequestClose: () => void requestClose(),
        });
        const form = win.form;

        const error = el("div", "fx-banner fx-banner--danger");
        error.setAttribute("role", "alert");
        error.hidden = true;

        const titleLabel = el("label", "fx-label", "Título");
        const titleInput = el("input", "fx-input");
        titleInput.maxLength = 200;
        titleInput.placeholder = "Sobre o que você quer falar?";
        titleInput.value = post?.title ?? "";
        titleInput.id = "postEditorTitleInput";
        titleLabel.htmlFor = titleInput.id;

        const categoryLabel = el("label", "fx-label", "Categoria");
        const categorySelect = el("select", "fx-input");
        categorySelect.id = "postEditorCategory";
        categoryLabel.htmlFor = categorySelect.id;
        categorySelect.append(new Option("Sem categoria", ""));
        for (const category of options.categories) {
            categorySelect.append(new Option(category.name, category.communityCategoryId));
        }
        categorySelect.value = post?.communityCategoryId ?? "";

        const contentLabel = el("label", "fx-label", "Conteúdo");
        const contentInput = el("textarea", "fx-input pe-content");
        contentInput.id = "postEditorContent";
        contentLabel.htmlFor = contentInput.id;
        contentInput.maxLength = 10_000;
        contentInput.placeholder = "Escreva os detalhes da sua discussão aqui...";
        contentInput.value = post?.content ?? "";
        const contentHint = el(
            "p",
            "fx-hint",
            "Aceita markdown: **negrito**, *itálico*, [link](https://...), listas, `código`, > citação, ||spoiler|| e @menções.",
        );

        // ----- +18 (só para quem tem conteúdo adulto liberado) -----
        const nsfwLabel = el("label", "fx-check");
        const nsfwInput = el("input");
        nsfwInput.type = "checkbox";
        nsfwInput.checked = post?.postIsNsfw ?? false;
        nsfwLabel.append(nsfwInput, "Conteúdo adulto (+18): só quem tem conteúdo adulto liberado vê");
        nsfwLabel.hidden = !post?.postIsNsfw;
        void getMe()
            .then((me) => {
                if (me.isAdult) nsfwLabel.hidden = false;
            })
            .catch(() => {});

        // ----- Imagens -----
        const imagesLabel = el("span", "fx-label", `Imagens (até ${MAX_POST_IMAGES})`);
        const imagesList = el("div", "pe-images");
        imagesList.hidden = true;
        const fileInput = el("input", "visually-hidden");
        fileInput.type = "file";
        fileInput.accept = IMAGE_TYPES.join(",");
        fileInput.multiple = true;
        fileInput.id = "postEditorImages";
        const addImages = el("label", "fx-btn fx-btn--secondary pe-add", "Adicionar imagens");
        addImages.htmlFor = fileInput.id;
        addImages.tabIndex = 0;
        addImages.setAttribute("role", "button");

        const existing: PostImage[] = [...(post?.images ?? [])];
        const removed = new Set<string>();
        const added: Array<{ file: File; preview: string }> = [];
        const total = (): number => existing.length - removed.size + added.length;

        const thumb = (src: string, onRemove: () => void): HTMLElement => {
            const item = el("div", "pe-image");
            const img = el("img");
            img.src = src;
            img.alt = "";
            // O ✕ no canto: alvo da faixa, com o círculo escuro de 22px dentro.
            const remove = el("button", "pe-image-rm");
            remove.type = "button";
            remove.innerHTML = ICONS.close; // ícone fixo, sem dado
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
                ...existing.filter((image) => !removed.has(image.imageId)).map((image) =>
                    thumb(image.url, () => removed.add(image.imageId)),
                ),
                ...added.map((entry, index) =>
                    thumb(entry.preview, () => {
                        URL.revokeObjectURL(entry.preview);
                        added.splice(index, 1);
                    }),
                ),
            );
            addImages.hidden = total() >= MAX_POST_IMAGES;
            imagesList.hidden = imagesList.childElementCount === 0;
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

        const cancel = el("button", "fx-btn fx-btn--secondary", "Cancelar");
        cancel.type = "button";
        const submit = el("button", "fx-btn fx-btn--primary", post ? "Salvar alterações" : "Publicar");
        submit.type = "submit";
        submit.dataset.conferirAcao = submit.textContent ?? "";

        // ----- Rascunho (só post novo) -----
        const draftBar = el("div", "fx-banner fx-banner--warning");
        draftBar.hidden = true;
        draftBar.setAttribute("role", "status");
        const discardDraft = el("button", "fx-banner-link", "Descartar rascunho");
        discardDraft.type = "button";
        draftBar.append(el("span", "fx-banner-text", "Rascunho restaurado."), discardDraft);

        const draft = post ? null : readDraft(options.communityId);
        if (draft) {
            titleInput.value = draft.title;
            contentInput.value = draft.content;
            if (options.categories.some((c) => c.communityCategoryId === draft.categoryId)) {
                categorySelect.value = draft.categoryId;
            }
            nsfwInput.checked = draft.nsfw;
            draftBar.hidden = false;
        }
        const initial = { title: titleInput.value, content: contentInput.value };

        const saveDraft = (): void => {
            if (post) return;
            writeDraft(options.communityId, {
                title: titleInput.value,
                content: contentInput.value,
                categoryId: categorySelect.value,
                nsfw: nsfwInput.checked,
            });
        };
        titleInput.addEventListener("input", saveDraft);
        contentInput.addEventListener("input", saveDraft);
        categorySelect.addEventListener("change", saveDraft);
        nsfwInput.addEventListener("change", saveDraft);

        // Field: rótulo em cima, campo embaixo (o contador entra logo depois do campo).
        const field = (...children: HTMLElement[]): HTMLDivElement => {
            const wrap = el("div", "fx-field");
            wrap.append(...children);
            return wrap;
        };

        // Rascunho e erro no topo do corpo; as ações vão para o rodapé (ou o topo, no celular).
        win.body.append(
            draftBar,
            error,
            field(titleLabel, titleInput),
            field(categoryLabel, categorySelect),
            field(contentLabel, contentInput, contentHint),
            nsfwLabel,
            field(imagesLabel, imagesList, fileInput, addImages),
        );

        const updateTitleCounter = attachCharCounter(titleInput);
        const updateContentCounter = attachCharCounter(contentInput);
        discardDraft.addEventListener("click", () => {
            writeDraft(options.communityId, null);
            titleInput.value = "";
            contentInput.value = "";
            categorySelect.value = "";
            nsfwInput.checked = false;
            initial.title = "";
            initial.content = "";
            updateTitleCounter();
            updateContentCounter();
            draftBar.hidden = true;
            titleInput.focus();
        });

        const showError = (message: string | null): void => {
            error.textContent = message ?? "";
            error.hidden = message === null;
        };

        const finish = (result: Post | null): void => {
            for (const entry of added) URL.revokeObjectURL(entry.preview);
            win.close();
            resolve(result);
        };

        /** Fechar sem salvar: com texto novo digitado, pergunta antes. */
        let asking = false;
        const requestClose = async (): Promise<void> => {
            if (asking) return;
            const typed =
                titleInput.value !== initial.title || contentInput.value !== initial.content || added.length > 0;
            if (typed) {
                asking = true;
                const ok = await confirmDialog({
                    title: post ? "Descartar alterações?" : "Fechar sem publicar?",
                    message: post
                        ? "As alterações nesta discussão ainda não foram salvas e serão perdidas."
                        : "O texto fica guardado como rascunho nesta comunidade (as imagens escolhidas, não).",
                    confirmLabel: post ? "Descartar" : "Fechar",
                    cancelLabel: "Continuar escrevendo",
                    danger: Boolean(post),
                });
                asking = false;
                if (!ok) return;
            }
            finish(null);
        };

        win.open({ primary: submit, secondary: [cancel], initialFocus: titleInput });
        cancel.addEventListener("click", () => void requestClose());

        /**
         * Depois do post salvo: tira as imagens marcadas e envia as novas.
         * Falha aqui não desfaz o post (ele já existe) — avisa e segue.
         */
        async function syncImages(saved: Post): Promise<Post> {
            let current = saved;
            try {
                for (const imageId of removed) {
                    const result = await api.posts.removeImage(saved.postId, imageId);
                    current = result.post;
                }
                if (added.length > 0) {
                    const body = new FormData();
                    for (const entry of added) body.append("images", entry.file);
                    const result = await api.posts.addImages(saved.postId, body);
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
                    ? await api.posts.update(post.postId, { title: titleValue, content, communityCategoryId: categoryId, ...(nsfwLabel.hidden ? {} : { isNsfw: nsfwInput.checked }) })
                    : await api.posts.create({ communityId: options.communityId, communityCategoryId: categoryId, title: titleValue, content, isNsfw: !nsfwLabel.hidden && nsfwInput.checked });
                if (!post) writeDraft(options.communityId, null);
                finish(await syncImages(result.post));
            } catch (err) {
                showError(err instanceof Error ? err.message : "Não foi possível salvar.");
                submit.disabled = false;
            }
        });
    });
}
