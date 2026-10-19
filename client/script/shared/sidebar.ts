/**
 * FAMAX — Sidebar Toggle (Shared)
 * Inicializa o toggle do menu lateral. A sidebar e o botão são criados pelo
 * layout.ts (initLayout), que chama esta função depois de montá-los.
 */
export function initSidebar(): void {
    const sidebar = document.getElementById("app-sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");

    if (
        sidebar instanceof HTMLElement &&
        sidebarToggle instanceof HTMLButtonElement
    ) {
        sidebarToggle.setAttribute("aria-expanded", "false");
        sidebarToggle.addEventListener("click", () => {
            const open = sidebar.classList.toggle("open");
            sidebarToggle.classList.toggle("open", open);
            sidebarToggle.setAttribute("aria-expanded", String(open));
            sidebarToggle.setAttribute(
                "aria-label",
                open ? "Fechar menu lateral" : "Abrir menu lateral",
            );
        });
    }
}
