/**
 * FAMAX — Avisos curtos ("toasts") (Shared)
 *
 * Aviso no pé da tela que some sozinho, para o resultado de ações que não têm
 * um lugar natural na página para a mensagem. "info" e "success" são lidos
 * pelo leitor de tela sem interromper (role="status"); "error" interrompe
 * (role="alert"). Montado com textContent: a mensagem nunca vira HTML.
 */

export type ToastKind = "info" | "success" | "error";

let host: HTMLElement | null = null;

export function toast(message: string, kind: ToastKind = "info"): void {
    if (!host) {
        host = document.createElement("div");
        host.className = "toast-host";
        document.body.append(host);
    }
    const item = document.createElement("div");
    item.className = `toast toast--${kind}`;
    item.setAttribute("role", kind === "error" ? "alert" : "status");
    item.textContent = message;
    host.append(item);
    // Erro fica mais tempo: dá para ler com calma.
    window.setTimeout(() => item.remove(), kind === "error" ? 6500 : 4500);
}
