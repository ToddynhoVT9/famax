/**
 * FAMAX — Abrir o chat de outra página (Shared)
 *
 * O widget (chat-widget.ts) é carregado por um <script> próprio em cada
 * página e escuta o evento famax:open-chat. Quem quer abrir uma conversa —
 * o botão "Enviar mensagem" do perfil — só dispara o evento, sem importar o
 * widget inteiro (que se montaria uma segunda vez).
 */
import { getToken } from "./api.js";
import { goToLogin } from "./auth-guard.js";

export const OPEN_CHAT_EVENT = "famax:open-chat";

export interface OpenChatDetail {
    userId: string;
}

/** Abre o widget na conversa 1:1 com a pessoa (criando-a, se preciso). */
export function openChatWith(userId: string): void {
    if (!getToken()) {
        goToLogin();
        return;
    }
    window.dispatchEvent(new CustomEvent<OpenChatDetail>(OPEN_CHAT_EVENT, { detail: { userId } }));
}
