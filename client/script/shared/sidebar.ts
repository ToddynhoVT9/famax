/**
 * FAMAX — Sidebar Toggle (Shared)
 * Inicializa o toggle do menu lateral. A sidebar e o botão são criados pelo
 * layout.ts (initLayout), que chama esta função depois de montá-los.
 *
 * Fechada, a sidebar fica fora do Tab (visibility no CSS). Em tela de até
 * 1024 px ela vira gaveta: abre por cima do conteúdo com um fundo escuro, e
 * tocar no fundo fecha. Esc fecha em qualquer tamanho e devolve o foco ao
 * botão.
 */
export function initSidebar(): void {
    const sidebar = document.getElementById("app-sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");

    if (
        sidebar instanceof HTMLElement &&
        sidebarToggle instanceof HTMLButtonElement
    ) {
        const backdrop = document.createElement("div");
        backdrop.className = "sidebar-backdrop";
        backdrop.hidden = true;
        sidebar.after(backdrop);

        const setOpen = (open: boolean): void => {
            sidebar.classList.toggle("open", open);
            sidebarToggle.classList.toggle("open", open);
            backdrop.hidden = !open;
            document.body.classList.toggle("sidebar-is-open", open);
            sidebarToggle.setAttribute("aria-expanded", String(open));
            sidebarToggle.setAttribute(
                "aria-label",
                open ? "Fechar menu lateral" : "Abrir menu lateral",
            );
        };

        sidebarToggle.setAttribute("aria-expanded", "false");
        sidebarToggle.addEventListener("click", () => {
            const open = !sidebar.classList.contains("open");
            setOpen(open);
            if (open) sidebar.querySelector<HTMLElement>("a[href], button")?.focus();
        });
        backdrop.addEventListener("click", () => setOpen(false));
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || !sidebar.classList.contains("open")) return;
            // Um modal aberto por cima trata o próprio Esc.
            const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
            if (Array.from(modals).some((m) => m.getClientRects().length > 0)) return;
            setOpen(false);
            sidebarToggle.focus();
        });
    }
}
