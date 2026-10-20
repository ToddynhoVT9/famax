/**
 * FAMAX — Diálogos e avisos (Shared)
 *
 * Substituem confirm() e alert() nativos, que travam a página, não seguem o
 * visual do site e não podem ser estilizados nem testados. Tudo é montado
 * com textContent: nenhum texto passado aqui é interpretado como HTML.
 */

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Ação destrutiva: botão de confirmar em vermelho. */
    danger?: boolean;
    /**
     * Exige digitar este texto exato para liberar o botão (ex.: o nome da
     * comunidade antes de excluí-la).
     */
    requireText?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Abre um diálogo de confirmação e resolve true/false. Esc, clique fora e
 * "Cancelar" resolvem false. O foco volta para onde estava ao fechar.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const previousFocus = document.activeElement as HTMLElement | null;

        const overlay = el("div", "dialog-overlay");
        const box = el("div", "dialog-box");
        box.setAttribute("role", "alertdialog");
        box.setAttribute("aria-modal", "true");

        const title = el("h2", "dialog-title", options.title);
        title.id = `dialog-title-${Date.now()}`;
        box.setAttribute("aria-labelledby", title.id);

        const message = el("p", "dialog-message", options.message);

        const actions = el("div", "dialog-actions");
        const cancel = el("button", "dialog-btn", options.cancelLabel ?? "Cancelar");
        cancel.type = "button";
        const confirm = el(
            "button",
            `dialog-btn dialog-btn--primary${options.danger ? " dialog-btn--danger" : ""}`,
            options.confirmLabel ?? "Confirmar",
        );
        confirm.type = "button";
        actions.append(cancel, confirm);

        box.append(title, message);

        let input: HTMLInputElement | null = null;
        if (options.requireText !== undefined) {
            const label = el("label", "dialog-label");
            label.append("Digite ");
            label.append(el("strong", "", options.requireText));
            label.append(" para confirmar:");
            input = el("input", "dialog-input");
            input.type = "text";
            input.autocomplete = "off";
            label.append(input);
            box.append(label);
            confirm.disabled = true;
            input.addEventListener("input", () => {
                confirm.disabled = input!.value.trim() !== options.requireText;
            });
        }

        box.append(actions);
        overlay.append(box);
        document.body.append(overlay);

        const close = (result: boolean): void => {
            document.removeEventListener("keydown", onKey);
            overlay.remove();
            previousFocus?.focus();
            resolve(result);
        };

        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                event.stopPropagation();
                close(false);
            } else if (event.key === "Tab") {
                // Foco preso dentro do diálogo enquanto ele está aberto.
                const focusable = Array.from(
                    box.querySelectorAll<HTMLElement>("button:not(:disabled), input"),
                );
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        };

        cancel.addEventListener("click", () => close(false));
        confirm.addEventListener("click", () => close(true));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) close(false);
        });
        input?.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !confirm.disabled) close(true);
        });
        document.addEventListener("keydown", onKey);

        (input ?? cancel).focus();
    });
}

// O aviso curto mora em toast.ts; reexportado para quem já importa daqui.
export { toast, type ToastKind } from "./toast.js";
