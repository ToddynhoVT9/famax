/**
 * FAMAX — Home Page Script
 *
 * Monta o feed a partir de GET /api/communities, agrupando por categoria.
 * Antes a home tinha um card fixo apontando para community.html sem ?id=, o
 * que agora levaria a uma página sem comunidade selecionada.
 */
import { api, getToken } from "./shared/api.js";
import { initSidebar } from "./shared/sidebar.js";
import { initHeaderDropdowns } from "./shared/header-dropdowns.js";
import { escapeHtml } from "./shared/dom.js";

initSidebar();
initHeaderDropdowns();

interface CommunityCard {
    community_id: string;
    name: string;
    cover_image_url: string | null;
    category_id: string | null;
    category_name: string | null;
    members_count: number;
}

const mainContent = document.getElementById("main-content");
const myCommunitiesEl = document.getElementById("myCommunities");

function renderCard(community: CommunityCard): string {
    const href = `community.html?id=${encodeURIComponent(community.community_id)}`;

    // A capa entra como background-image porque .card já define tamanho e
    // cantos; uma <img> exigiria reescrever o layout do card.
    const cover = community.cover_image_url
        ? `style="background-image:url('${escapeHtml(community.cover_image_url)}');background-size:cover;background-position:center"`
        : "";

    const content = community.cover_image_url
        ? ""
        : '<div class="card-content">Imagem/<br>Capa</div>';

    return `
        <a href="${href}" class="card" ${cover}>
            ${content}
            <div class="card-footer">${escapeHtml(community.name)}</div>
        </a>
    `;
}

function showStatus(message: string, isError = false): void {
    if (!mainContent) return;
    mainContent.innerHTML = `<div class="feed-status${isError ? " error" : ""}"></div>`;
    const el = mainContent.querySelector(".feed-status");
    if (el) el.textContent = message;
}

async function loadFeed(): Promise<void> {
    if (!mainContent) return;

    try {
        const { data } = await api<{ data: CommunityCard[] }>(
            "/communities?limit=50",
        );

        if (data.length === 0) {
            showStatus("Nenhuma comunidade ainda. Crie a primeira!");
            return;
        }

        // Agrupa preservando a ordem de chegada das categorias.
        const groups = new Map<string, CommunityCard[]>();
        for (const community of data) {
            const key = community.category_name ?? "Outros";
            const list = groups.get(key);
            if (list) {
                list.push(community);
            } else {
                groups.set(key, [community]);
            }
        }

        mainContent.innerHTML = Array.from(groups.entries())
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
        showStatus(
            err instanceof Error
                ? `Não foi possível carregar as comunidades: ${err.message}`
                : "Não foi possível carregar as comunidades.",
            true,
        );
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
        // Sidebar é acessório; a home continua utilizável sem ela.
    }
}

void loadFeed();
void loadMyCommunities();

export {};
