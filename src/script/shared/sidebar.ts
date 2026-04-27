/**
 * FAMAX — Sidebar Toggle (Shared)
 * Inicializa o toggle do menu lateral.
 */
export function initSidebar(): void {
    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");

    if (
        sidebar instanceof HTMLElement &&
        sidebarToggle instanceof HTMLButtonElement
    ) {
        sidebarToggle.addEventListener("click", () => {
            sidebar.classList.toggle("open");
            sidebarToggle.classList.toggle("open");
        });
    }
}
