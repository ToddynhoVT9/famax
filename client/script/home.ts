/**
 * FAMAX — Home Page Script
 *
 * Monta o feed a partir de GET /api/communities, agrupando por categoria, com
 * chips para filtrar uma categoria só (?categoryId=, refletido na URL). Cada
 * card mostra a capa — ou um gradiente com a inicial —, membros e o começo
 * da descrição.
 */
import { api } from "./shared/api.js";
import { initLayout } from "./shared/layout.js";
import { communityUrl } from "./shared/pages.js";
import { avatarColor, escapeHtml, truncate } from "./shared/dom.js";

initLayout();

interface CommunityCard {
    community_id: string;
    name: string;
    description: string | null;
    cover_image_url: string | null;
    category_id: string | null;
    category_name: string | null;
    members_count: number;
}

interface Category {
    category_id: string;
    name: string;
}

const feed = document.getElementById("homeFeed");
const chipsEl = document.getElementById("homeChips");

let categoryFilter = new URLSearchParams(window.location.search).get("categoryId");
let feedSeq = 0;

function renderCard(community: CommunityCard): string {
    const href = escapeHtml(communityUrl(community.community_id));
    const members = `${community.members_count} ${community.members_count === 1 ? "membro" : "membros"}`;
    const description = community.description
        ? `<span class="card-description">${escapeHtml(truncate(community.description, 90))}</span>`
        : "";

    // A capa entra como background-image porque .card já define tamanho e
    // cantos. Sem capa: gradiente na cor estável da comunidade + a inicial.
    const cover = community.cover_image_url
        ? `<div class="card-cover" style="background-image:url('${escapeHtml(community.cover_image_url)}')"></div>`
        : `<div class="card-cover card-cover--placeholder ${avatarColor(community.community_id)}">
               <span class="card-initial" aria-hidden="true">${escapeHtml(community.name.trim().charAt(0).toUpperCase())}</span>
           </div>`;

    return `
        <a href="${href}" class="card">
            ${cover}
            <div class="card-footer">
                <span class="card-name">${escapeHtml(community.name)}</span>
                <span class="card-members">${escapeHtml(members)}</span>
                ${description}
            </div>
        </a>
    `;
}

function showStatus(message: string, isError = false): void {
    if (!feed) return;
    feed.innerHTML = `<div class="feed-status${isError ? " error" : ""}"></div>`;
    const el = feed.querySelector(".feed-status");
    if (el) el.textContent = message;
}

function syncUrl(): void {
    const url = new URL(window.location.href);
    if (categoryFilter) url.searchParams.set("categoryId", categoryFilter);
    else url.searchParams.delete("categoryId");
    history.replaceState(null, "", url);
}

async function loadFeed(): Promise<void> {
    if (!feed) return;
    const seq = ++feedSeq;
    showStatus("Carregando comunidades...");

    try {
        const params = new URLSearchParams({ limit: "50" });
        if (categoryFilter) params.set("categoryId", categoryFilter);
        const { data } = await api<{ data: CommunityCard[] }>(`/communities?${params}`);
        if (seq !== feedSeq) return;

        if (data.length === 0) {
            showStatus(
                categoryFilter
                    ? "Nenhuma comunidade nesta categoria ainda."
                    : "Nenhuma comunidade ainda. Crie a primeira!",
            );
            return;
        }

        // Agrupa preservando a ordem de chegada das categorias.
        const groups = new Map<string, CommunityCard[]>();
        for (const community of data) {
            const key = community.category_name ?? "Outros";
            const list = groups.get(key);
            if (list) list.push(community);
            else groups.set(key, [community]);
        }

        feed.innerHTML = Array.from(groups.entries())
            .map(
                ([categoryName, communities]) => `
                    <section class="category-section">
                        <h2 class="category-title">${escapeHtml(categoryName)}</h2>
                        <div class="cards-container">
                            ${communities.map(renderCard).join("")}
                        </div>
                    </section>
                `,
            )
            .join("");
    } catch (err) {
        if (seq !== feedSeq) return;
        showStatus(
            err instanceof Error
                ? `Não foi possível carregar as comunidades: ${err.message}`
                : "Não foi possível carregar as comunidades.",
            true,
        );
    }
}

function renderChips(categories: Category[]): void {
    if (!chipsEl) return;
    const chip = (label: string, value: string | null): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "home-chip";
        button.textContent = label;
        button.dataset.categoryId = value ?? "";
        button.setAttribute("aria-pressed", String(categoryFilter === value));
        return button;
    };
    chipsEl.replaceChildren(
        chip("Todas", null),
        ...categories.map((c) => chip(c.name, c.category_id)),
    );
}

async function loadCategories(): Promise<void> {
    try {
        const { data } = await api<{ data: Category[] }>("/categories");
        renderChips(data);
    } catch {
        // Sem chips a home continua funcionando, só sem o filtro.
        if (chipsEl) chipsEl.hidden = true;
    }
}

chipsEl?.addEventListener("click", (event) => {
    const chip = (event.target as Element).closest<HTMLButtonElement>(".home-chip");
    if (!chip) return;
    categoryFilter = chip.dataset.categoryId || null;
    chipsEl.querySelectorAll<HTMLButtonElement>(".home-chip").forEach((c) =>
        c.setAttribute("aria-pressed", String(c === chip)),
    );
    syncUrl();
    void loadFeed();
});

void loadCategories();
void loadFeed();

export {};
