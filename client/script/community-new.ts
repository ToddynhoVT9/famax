/**
 * FAMAX — Criação e edição de Comunidade
 *
 * ?edit=<id> abre a mesma página em modo edição (só para o dono), com a
 * exclusão da comunidade no fim.
 *
 * Diferenças em relação ao protótipo (_famax-tab/nova-comunidade.html):
 *  - o <select> de categoria vem de GET /api/categories (o protótipo tinha
 *    strings fixas, mas o banco exige um category_id que é FK);
 *  - o submit envia de verdade (o protótipo só fazia alert + redirect);
 *  - erros aparecem inline no formulário, não em alert();
 *  - o botão é travado durante o request — dois cliques criariam duas
 *    comunidades.
 *
 * Desenho: formulário de 760px a partir do topo, com a barra de ações que
 * gruda embaixo quando as ações passam da dobra (community-new.css). O erro
 * aparece no topo do formulário, e o campo com erro fica com aria-invalid.
 */
import { api, getMe } from "./shared/api.js";
import { requireLogin } from "./shared/auth-guard.js";
import { initLayout } from "./shared/layout.js";
import { communityUrl, pages } from "./shared/pages.js";
import { confirmDialog } from "./shared/dialog.js";
import { queryParam } from "./shared/dom.js";
import { followKeyboard } from "./shared/keyboard.js";

requireLogin();
initLayout();
// Celular: com o teclado aberto, o campo focado volta para a vista.
followKeyboard(document.getElementById("communityForm") ?? document);

const MAX_COVER_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

const form = document.getElementById("communityForm");
const nameInput = document.getElementById("communityName");
const categorySelect = document.getElementById("communityCategory");
const descriptionInput = document.getElementById("communityDescription");
const rulesInput = document.getElementById("communityRules");
const rulesField = document.getElementById("rulesField");
const coverInput = document.getElementById("communityCover");
const imagePreview = document.getElementById("imagePreview");
const cancelBtn = document.getElementById("cancelBtn");
const submitBtn = document.getElementById("submitBtn");
const formError = document.getElementById("formError");
const removeCoverField = document.getElementById("removeCoverField");
const removeCover = document.getElementById("removeCover") as HTMLInputElement | null;
const dangerZone = document.getElementById("dangerZone");
const deleteBtn = document.getElementById("deleteCommunityBtn") as HTMLButtonElement | null;

const editId = queryParam("edit");
const nsfwField = document.getElementById("nsfwField");
const nsfwInput = document.getElementById("communityNsfw") as HTMLInputElement | null;

// A opção +18 aparece para quem tem conteúdo adulto liberado (a API recusa
// os demais de qualquer jeito).
void getMe()
    .then((me) => {
        if (me.isAdult && nsfwField) nsfwField.hidden = false;
    })
    .catch(() => {});

if (
    form instanceof HTMLFormElement &&
    nameInput instanceof HTMLInputElement &&
    categorySelect instanceof HTMLSelectElement &&
    descriptionInput instanceof HTMLTextAreaElement &&
    coverInput instanceof HTMLInputElement &&
    imagePreview instanceof HTMLElement &&
    cancelBtn instanceof HTMLButtonElement &&
    submitBtn instanceof HTMLButtonElement &&
    formError instanceof HTMLElement
) {
    /** field: o campo com erro, que fica com aria-invalid até ser alterado. */
    const showError = (message: string, field?: HTMLElement): void => {
        formError.textContent = message;
        formError.hidden = false;
        formError.scrollIntoView({ behavior: "smooth", block: "nearest" });
        if (field) {
            field.setAttribute("aria-invalid", "true");
            field.setAttribute("aria-describedby", formError.id);
        }
    };

    const clearError = (): void => {
        formError.textContent = "";
        formError.hidden = true;
        for (const field of form.querySelectorAll('[aria-invalid="true"]')) {
            field.removeAttribute("aria-invalid");
            if (field.getAttribute("aria-describedby") === formError.id) field.removeAttribute("aria-describedby");
        }
    };

    // Ao corrigir o campo, ele deixa de ser marcado com erro.
    form.addEventListener("input", (event) => {
        const field = event.target as HTMLElement;
        if (field.getAttribute("aria-invalid") === "true") field.removeAttribute("aria-invalid");
    });

    // --- Categorias -------------------------------------------------------

    const loadCategories = async (): Promise<void> => {
        try {
            const { data } = await api.categories.list();

            if (data.length === 0) {
                categorySelect.innerHTML =
                    '<option value="">Nenhuma categoria disponível</option>';
                showError(
                    "Não há categorias cadastradas. Rode server/sql/004_seed_categories.sql antes de criar comunidades.",
                );
                return;
            }

            categorySelect.innerHTML = '<option value="">Selecione a categoria</option>';
            for (const category of data) {
                const option = document.createElement("option");
                option.value = category.categoryId;
                // textContent, não innerHTML: o nome vem do banco.
                option.textContent = category.name;
                categorySelect.appendChild(option);
            }
            categorySelect.disabled = false;
        } catch (err) {
            categorySelect.innerHTML =
                '<option value="">Erro ao carregar categorias</option>';
            showError(
                err instanceof Error
                    ? `Não foi possível carregar as categorias: ${err.message}`
                    : "Não foi possível carregar as categorias.",
            );
        }
    };

    // O modo edição espera as opções existirem antes de selecionar a atual.
    const categoryReady = loadCategories();

    // --- Preview da capa --------------------------------------------------
    // O FileReader continua sendo só preview local; o arquivo em si vai por
    // FormData, não como base64.

    const resetPreview = (message: string): void => {
        imagePreview.classList.remove("has-image");
        imagePreview.textContent = message;
    };

    /** A prévia com a imagem, no recorte da capa. */
    const showPreview = (src: string, alt: string): void => {
        imagePreview.textContent = "";
        imagePreview.classList.add("has-image");
        const img = document.createElement("img");
        img.src = src;
        img.alt = alt;
        imagePreview.appendChild(img);
    };

    coverInput.addEventListener("change", () => {
        clearError();
        const file = coverInput.files?.[0];

        if (!file) {
            resetPreview("Nenhuma imagem selecionada");
            return;
        }

        if (!ALLOWED_TYPES.includes(file.type)) {
            coverInput.value = "";
            resetPreview("Nenhuma imagem selecionada");
            showError("A capa deve ser um arquivo PNG, JPEG ou WebP.", coverInput);
            return;
        }

        if (file.size > MAX_COVER_BYTES) {
            coverInput.value = "";
            resetPreview("Nenhuma imagem selecionada");
            showError("A capa deve ter no máximo 2MB.", coverInput);
            return;
        }

        const reader = new FileReader();
        reader.onload = () => showPreview(String(reader.result), "Prévia da capa da comunidade");
        reader.onerror = () => {
            resetPreview("Não foi possível ler a imagem");
        };
        reader.readAsDataURL(file);
    });

    // --- Modo edição (?edit=<id>) ----------------------------------------
    // A mesma página serve para editar: o dono chega aqui pelo botão
    // "Editar comunidade". Quem não é dono vê o erro e o formulário travado
    // (o backend recusaria de qualquer forma).

    const submitLabel = editId ? "Salvar alterações" : "Criar comunidade";
    let editingName = "";

    const showCurrentCover = (url: string): void => showPreview(url, "Capa atual da comunidade");

    const loadForEdit = async (): Promise<void> => {
        if (!editId) return;

        const title = document.getElementById("pageTitle");
        const subtitle = document.getElementById("pageSubtitle");
        if (title) title.textContent = "Editar comunidade";
        if (subtitle) subtitle.textContent = "Altere os dados da comunidade. Só o dono pode fazer isso.";
        submitBtn.textContent = submitLabel;
        document.title = "FAMAX - Editar Comunidade";

        try {
            const { community } = await api.communities.get(editId);
            if (community.myRole !== "owner") {
                showError("Só o dono pode editar esta comunidade.");
                submitBtn.disabled = true;
                return;
            }

            editingName = community.name;
            nameInput.value = community.name;
            if (nsfwInput) nsfwInput.checked = community.isNsfw;
            // Já marcada: o dono vê a opção mesmo sem conteúdo adulto, para
            // poder desmarcar.
            if (nsfwField && community.isNsfw) nsfwField.hidden = false;
            descriptionInput.value = community.description ?? "";
            if (rulesInput instanceof HTMLTextAreaElement) {
                rulesInput.value = community.rules ?? "";
                if (rulesField) rulesField.hidden = false;
            }
            categoryReady.then(() => {
                categorySelect.value = community.categoryId;
            });
            if (community.coverImageUrl) {
                showCurrentCover(community.coverImageUrl);
                if (removeCoverField) removeCoverField.hidden = false;
            }
            if (dangerZone) dangerZone.hidden = false;
        } catch (err) {
            showError(err instanceof Error ? err.message : "Comunidade não encontrada.");
            submitBtn.disabled = true;
        }
    };

    void loadForEdit();

    deleteBtn?.addEventListener("click", async () => {
        if (!editId || !editingName) return;
        const ok = await confirmDialog({
            title: "Excluir comunidade?",
            message: "Todos deixam de ver a comunidade e as discussões dela.",
            confirmLabel: "Excluir para sempre",
            danger: true,
            requireText: editingName,
        });
        if (!ok) return;

        deleteBtn.disabled = true;
        try {
            await api.communities.remove(editId, editingName);
            window.location.replace(pages.home);
        } catch (err) {
            showError(err instanceof Error ? err.message : "Não foi possível excluir.");
            deleteBtn.disabled = false;
        }
    });

    // --- Submit -----------------------------------------------------------

    cancelBtn.addEventListener("click", () => {
        window.location.href = editId ? communityUrl(editId) : pages.home;
    });

    form.addEventListener("submit", async (event: SubmitEvent) => {
        event.preventDefault();
        clearError();

        const name = nameInput.value.trim();
        const categoryId = categorySelect.value;
        const description = descriptionInput.value.trim();
        const file = coverInput.files?.[0];

        if (name.length < 3) {
            showError("O nome da comunidade deve ter no mínimo 3 caracteres.", nameInput);
            nameInput.focus();
            return;
        }
        if (!categoryId) {
            showError("Selecione uma categoria.", categorySelect);
            categorySelect.focus();
            return;
        }

        const body = new FormData();
        body.append("name", name);
        body.append("categoryId", categoryId);
        // Na edição a descrição vai sempre: vazia significa "apagar".
        if (description || editId) body.append("description", description);
        // Regras só existem no modo edição; vazio apaga.
        if (editId && rulesInput instanceof HTMLTextAreaElement) {
            body.append("rules", rulesInput.value.trim());
        }
        if (file) body.append("cover", file);
        else if (editId && removeCover?.checked) body.append("removeCover", "true");
        if (nsfwField && !nsfwField.hidden && nsfwInput) body.append("isNsfw", String(nsfwInput.checked));

        submitBtn.disabled = true;
        submitBtn.textContent = editId ? "Salvando..." : "Criando...";

        try {
            if (editId) {
                await api.communities.update(editId, body);
                window.location.href = communityUrl(editId);
                return;
            }

            const { community } = await api.communities.create(body);

            // Leva direto para o que acabou de ser criado — o protótipo voltava
            // para a home, onde o usuário não via o resultado.
            window.location.href = communityUrl(community.communityId);
        } catch (err) {
            showError(
                err instanceof Error ? err.message : "Erro ao salvar a comunidade.",
            );
            submitBtn.disabled = false;
            submitBtn.textContent = submitLabel;
        }
    });
}

export {};
