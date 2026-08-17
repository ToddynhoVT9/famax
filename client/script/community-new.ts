/**
 * FAMAX — Criação de Comunidade
 *
 * Diferenças em relação ao protótipo (_famax-tab/nova-comunidade.html):
 *  - o <select> de categoria vem de GET /api/categories (o protótipo tinha
 *    strings fixas, mas o banco exige um category_id que é FK);
 *  - o submit envia de verdade (o protótipo só fazia alert + redirect);
 *  - erros aparecem inline no formulário, não em alert();
 *  - o botão é travado durante o request — dois cliques criariam duas
 *    comunidades.
 */
import { api, getToken } from "./shared/api.js";

const MAX_COVER_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

const form = document.getElementById("communityForm");
const nameInput = document.getElementById("communityName");
const categorySelect = document.getElementById("communityCategory");
const descriptionInput = document.getElementById("communityDescription");
const coverInput = document.getElementById("communityCover");
const imagePreview = document.getElementById("imagePreview");
const cancelBtn = document.getElementById("cancelBtn");
const submitBtn = document.getElementById("submitBtn");
const formError = document.getElementById("formError");

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
    if (!getToken()) {
        window.location.href = "../user-pages/login.html";
    }

    const showError = (message: string): void => {
        formError.textContent = message;
        formError.classList.add("show");
        formError.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    const clearError = (): void => {
        formError.textContent = "";
        formError.classList.remove("show");
    };

    // --- Categorias -------------------------------------------------------

    type Category = { category_id: string; name: string };

    const loadCategories = async (): Promise<void> => {
        try {
            const { data } = await api<{ data: Category[] }>("/categories");

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
                option.value = category.category_id;
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

    void loadCategories();

    // --- Preview da capa --------------------------------------------------
    // O FileReader continua sendo só preview local; o arquivo em si vai por
    // FormData, não como base64.

    const resetPreview = (message: string): void => {
        imagePreview.textContent = message;
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
            showError("A capa deve ser um arquivo PNG, JPEG ou WebP.");
            return;
        }

        if (file.size > MAX_COVER_BYTES) {
            coverInput.value = "";
            resetPreview("Nenhuma imagem selecionada");
            showError("A capa deve ter no máximo 2MB.");
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            imagePreview.textContent = "";
            const img = document.createElement("img");
            img.src = String(reader.result);
            img.alt = "Prévia da capa da comunidade";
            imagePreview.appendChild(img);
        };
        reader.onerror = () => {
            resetPreview("Não foi possível ler a imagem");
        };
        reader.readAsDataURL(file);
    });

    // --- Submit -----------------------------------------------------------

    cancelBtn.addEventListener("click", () => {
        window.location.href = "../home.html";
    });

    form.addEventListener("submit", async (event: SubmitEvent) => {
        event.preventDefault();
        clearError();

        const name = nameInput.value.trim();
        const categoryId = categorySelect.value;
        const description = descriptionInput.value.trim();
        const file = coverInput.files?.[0];

        if (name.length < 3) {
            showError("O nome da comunidade deve ter no mínimo 3 caracteres.");
            nameInput.focus();
            return;
        }
        if (!categoryId) {
            showError("Selecione uma categoria.");
            categorySelect.focus();
            return;
        }

        const body = new FormData();
        body.append("name", name);
        body.append("categoryId", categoryId);
        if (description) body.append("description", description);
        if (file) body.append("cover", file);

        submitBtn.disabled = true;
        submitBtn.textContent = "Criando...";

        try {
            const { community } = await api<{
                community: { communityId: string };
            }>("/communities", { method: "POST", body });

            // Leva direto para o que acabou de ser criado — o protótipo voltava
            // para a home, onde o usuário não via o resultado.
            window.location.href = `../community.html?id=${encodeURIComponent(community.communityId)}`;
        } catch (err) {
            showError(
                err instanceof Error ? err.message : "Erro ao criar comunidade.",
            );
            submitBtn.disabled = false;
            submitBtn.textContent = "Criar comunidade";
        }
    });
}

export {};
