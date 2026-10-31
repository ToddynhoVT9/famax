/**
 * FAMAX — Gaveta (menu lateral) (Shared)
 * A gaveta e os gatilhos são criados pelo layout.ts (initLayout), que chama
 * esta função depois de montá-los.
 *
 * Gatilhos: todo [data-sidebar-toggle] — o ☰ do header (desktop e compacto) e
 * "Comunidades" na barra inferior (tablet e celular). Todos mostram o mesmo
 * aria-expanded, e ao fechar o foco volta para o que abriu.
 *
 * A partir de 1024px a gaveta empurra o conteúdo, sem véu; abaixo, o conteúdo
 * desliza e ganha um véu que fecha ao toque (layout.css). Fechada, ela fica
 * fora do Tab (visibility no CSS). Esc fecha em qualquer largura.
 */
export function initSidebar(): void {
    const sidebar = document.getElementById("app-sidebar");
    if (!(sidebar instanceof HTMLElement)) return;

    const backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    backdrop.hidden = true;
    sidebar.after(backdrop);

    const triggers = (): HTMLElement[] =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-toggle]"));
    let opener: HTMLElement | null = null;

    const setOpen = (open: boolean): void => {
        sidebar.classList.toggle("open", open);
        backdrop.hidden = !open;
        document.body.classList.toggle("sidebar-is-open", open);
        for (const trigger of triggers()) {
            trigger.setAttribute("aria-expanded", String(open));
            // O ☰ só tem ícone: o rótulo diz o que ele faz agora.
            if (trigger.id === "sidebarToggle") {
                trigger.setAttribute("aria-label", open ? "Fechar menu lateral" : "Abrir menu lateral");
            }
        }
    };

    const close = (): void => {
        setOpen(false);
        opener?.focus();
        opener = null;
    };

    // Delegação: a barra inferior pode ser redesenhada (sessão que caiu).
    document.addEventListener("click", (event) => {
        const trigger = (event.target as Element | null)?.closest<HTMLElement>("[data-sidebar-toggle]");
        if (!trigger) return;
        if (sidebar.classList.contains("open")) {
            close();
            return;
        }
        opener = trigger;
        setOpen(true);
        sidebar.querySelector<HTMLElement>("a[href], button")?.focus();
    });
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !sidebar.classList.contains("open")) return;
        // Um modal aberto por cima trata o próprio Esc.
        const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
        if (Array.from(modals).some((m) => m.getClientRects().length > 0)) return;
        close();
    });
}
