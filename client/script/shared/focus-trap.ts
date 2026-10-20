/**
 * FAMAX — Foco preso em modais (Shared)
 *
 * O que todo modal precisa para teclado e leitor de tela (WCAG 2.1.2, 2.4.3):
 *  - Tab e Shift+Tab giram dentro do modal, sem escapar para a página atrás;
 *  - Esc fecha;
 *  - ao abrir, o foco vai para dentro; ao fechar, volta para quem abriu.
 *
 * trapFocus devolve a função que solta o modal (chamar ao fechar). O
 * role="dialog" / aria-modal e o rótulo ficam no HTML de cada modal. Com
 * dois modais empilhados, só o de cima (o último aria-modal da página)
 * responde ao teclado.
 */

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Visível de fato (display:none não gera caixa; position:fixed sim). */
const isShown = (el: HTMLElement): boolean => el.getClientRects().length > 0;

function focusables(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isShown);
}

export function trapFocus(
    container: HTMLElement,
    options: { onEscape?: () => void; initialFocus?: HTMLElement | null } = {},
): () => void {
    const previous = document.activeElement as HTMLElement | null;

    const onKey = (event: KeyboardEvent): void => {
        // Outro modal aberto por cima (ex.: confirmação): ele é quem manda.
        // (Modais escondidos continuam no HTML com aria-modal: só contam os visíveis.)
        const modals = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter(isShown);
        const top = modals[modals.length - 1];
        if (top && top !== container && !container.contains(top)) return;

        if (event.key === "Escape" && options.onEscape) {
            event.stopPropagation();
            options.onEscape();
            return;
        }
        if (event.key !== "Tab") return;
        const items = focusables(container);
        if (items.length === 0) {
            event.preventDefault();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && (active === first || !container.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !container.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    };

    document.addEventListener("keydown", onKey, true);
    (options.initialFocus ?? focusables(container)[0] ?? container).focus();

    return () => {
        document.removeEventListener("keydown", onKey, true);
        previous?.focus();
    };
}
