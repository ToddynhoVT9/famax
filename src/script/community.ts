/**
 * FAMAX — Community Page Script
 */
import { initSidebar } from "./shared/sidebar.js";
import { initHeaderDropdowns } from "./shared/header-dropdowns.js";

initSidebar();
initHeaderDropdowns();

// --- Tab Slider ---
function updateIndicator(): void {
    const activeTab = document.querySelector<HTMLElement>(".tf-tab.active");
    const indicator = document.getElementById("tfTabIndicator");
    const container = document.getElementById("tfTabsContainer");

    if (activeTab && indicator && container) {
        const containerRect = container.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();
        const relativeLeft = tabRect.left - containerRect.left;

        indicator.style.width = `${tabRect.width}px`;
        indicator.style.transform = `translateX(${relativeLeft}px)`;
    }
}

function updateWidgetIndicator(): void {
    const activeTab = document.querySelector<HTMLElement>(".tf-w-tab.active");
    const indicator = document.getElementById("tfWidgetTabIndicator");
    const container = document.getElementById("tfWidgetTabsContainer");

    if (activeTab && indicator && container) {
        const containerRect = container.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();
        const relativeLeft = tabRect.left - containerRect.left;

        indicator.style.width = `${tabRect.width}px`;
        indicator.style.transform = `translateX(${relativeLeft}px)`;
    }
}

// Tabs principais da comunidade
const mainTabs = document.querySelectorAll<HTMLElement>(".tf-tab");
mainTabs.forEach((tab) => {
    tab.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        mainTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        updateIndicator();
    });
});

// Tabs do widget de leaderboard
const widgetTabs = document.querySelectorAll<HTMLElement>(".tf-w-tab");
widgetTabs.forEach((tab) => {
    tab.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        widgetTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        updateWidgetIndicator();
    });
});

// Inicializar posição dos indicadores
window.addEventListener("load", () => {
    setTimeout(updateIndicator, 50);
    setTimeout(updateWidgetIndicator, 50);
});

window.addEventListener("resize", () => {
    updateIndicator();
    updateWidgetIndicator();
});

// --- Click no avatar/nome dos posts → perfil do usuário ---
const postAvatars = document.querySelectorAll<HTMLElement>(
    ".tf-post-avatar-container"
);
const postNames = document.querySelectorAll<HTMLElement>(".tf-post-meta strong");

const goToProfile = (event: MouseEvent): void => {
    let userName = "Usuário";
    const currentTarget = event.currentTarget as HTMLElement;
    const post = currentTarget.closest(".tf-post");

    if (post) {
        const nameEl = post.querySelector<HTMLElement>(".tf-post-meta strong");
        if (nameEl) userName = nameEl.innerText;
    }

    window.location.href = `user-pages/profile-view.html?view=other&name=${encodeURIComponent(userName)}`;
};

postAvatars.forEach((avatar) =>
    avatar.addEventListener("click", goToProfile)
);
postNames.forEach((name) => name.addEventListener("click", goToProfile));

// --- Modal de criação de post ---
const btnCreatePost = document.getElementById("btnCreatePost");
const createPostModal = document.getElementById("createPostModal");
const closePostModal = document.getElementById("closePostModal");
const cancelPostModal = document.getElementById("cancelPostModal");

const openModal = (): void => {
    if (createPostModal) createPostModal.classList.add("show");
};

const closeModal = (): void => {
    if (createPostModal) createPostModal.classList.remove("show");
};

if (btnCreatePost) btnCreatePost.addEventListener("click", openModal);
if (closePostModal) closePostModal.addEventListener("click", closeModal);
if (cancelPostModal) cancelPostModal.addEventListener("click", closeModal);

if (createPostModal) {
    createPostModal.addEventListener("click", (e: MouseEvent) => {
        if (e.target === createPostModal) {
            closeModal();
        }
    });
}

if (closePostModal) {
    closePostModal.addEventListener("mouseover", () => {
        (closePostModal as HTMLElement).style.color = "#fff";
    });
    closePostModal.addEventListener("mouseout", () => {
        (closePostModal as HTMLElement).style.color = "#aaa";
    });
}
