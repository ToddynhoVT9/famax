/**
 * FAMAX — Confirmar e-mail (html/user-pages/verify-email.html#token=...)
 *
 * A página do link enviado no cadastro (ou na troca de e-mail). Lê o token
 * do fragmento, confirma em POST /api/auth/verify-email e tira o token da
 * barra de endereço — ele não precisa ficar no histórico.
 *
 * Funciona com ou sem sessão: o link pode ser aberto em outro aparelho.
 */
import { api, getToken } from "../shared/api.js";
import { pages } from "../shared/pages.js";

const title = document.getElementById("verifyTitle");
const text = document.getElementById("verifyText");
const next = document.getElementById("verifyContinue") as HTMLAnchorElement | null;

const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
history.replaceState(null, "", window.location.pathname);

function finish(heading: string, message: string, href: string, label: string): void {
    if (title) title.textContent = heading;
    if (text) text.textContent = message;
    if (next) {
        next.href = href;
        next.textContent = label;
        next.hidden = false;
    }
}

async function verify(): Promise<void> {
    if (!token) {
        finish(
            "Link incompleto",
            "Abra o link exatamente como chegou no e-mail, ou peça um novo nas configurações da conta.",
            getToken() ? pages.settings : pages.login,
            getToken() ? "Ir para as configurações" : "Entrar",
        );
        return;
    }
    try {
        const { email } = await api<{ email: string }>("/auth/verify-email", {
            method: "POST",
            body: JSON.stringify({ token }),
        });
        finish(
            "E-mail confirmado!",
            `${email} está confirmado. Agora você pode criar comunidades e mandar mensagens.`,
            getToken() ? pages.home : pages.login,
            getToken() ? "Ir para a home" : "Entrar",
        );
    } catch (err) {
        finish(
            "Não foi possível confirmar",
            err instanceof Error ? err.message : "Tente de novo mais tarde.",
            getToken() ? pages.settings : pages.login,
            getToken() ? "Ir para as configurações" : "Entrar",
        );
    }
}

void verify();
