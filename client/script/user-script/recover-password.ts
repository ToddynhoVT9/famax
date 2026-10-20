/**
 * FAMAX — Recuperação de senha
 *
 * Três passos, cada um falando com a API (ver server/lib/password-recovery.ts):
 *   1. e-mail      → POST /auth/forgot-password
 *   2. código      → POST /auth/verify-reset-code  (devolve um resetToken)
 *   3. nova senha  → POST /auth/reset-password
 *
 * Antes era uma simulação: aceitava qualquer código e terminava num
 * alerta nativo de "Senha alterada com sucesso!" sem nada mudar no servidor.
 */
import { api, clearToken } from "../shared/api.js";
import { pages } from "../shared/pages.js";

const RESEND_SECONDS = 60;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

const emailStep = $<HTMLFormElement>("email-step");
const codeStep = $<HTMLFormElement>("code-step");
const passwordStep = $<HTMLFormElement>("password-step");
const emailInput = $<HTMLInputElement>("email-input");
const codeInput = $<HTMLInputElement>("code-input");
const newPasswordInput = $<HTMLInputElement>("new-password");
const confirmPasswordInput = $<HTMLInputElement>("confirm-password");
const showPassword = $<HTMLInputElement>("show-password");
const sendCodeButton = $<HTMLButtonElement>("sendCodeButton");
const verifyCodeButton = $<HTMLButtonElement>("verifyCodeButton");
const resetPasswordButton = $<HTMLButtonElement>("resetPasswordButton");
const resendButton = $<HTMLButtonElement>("resendButton");
const changeEmailButton = $<HTMLButtonElement>("changeEmailButton");
const codeSentText = $("code-sent-text");
const emailError = $("email-error");
const codeError = $("code-error");
const passwordError = $("password-error");
const backToLogin = $<HTMLAnchorElement>("backToLogin");

if (backToLogin) backToLogin.href = pages.login;

let email = "";
let resetToken = "";
let resendTimer: number | undefined;

function showError(el: HTMLElement | null, message: string | null): void {
    if (!el) return;
    el.textContent = message ?? "";
    el.hidden = message === null;
}

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

function showStep(step: 1 | 2 | 3): void {
    if (emailStep) emailStep.hidden = step !== 1;
    if (codeStep) codeStep.hidden = step !== 2;
    if (passwordStep) passwordStep.hidden = step !== 3;
    const focus = step === 1 ? emailInput : step === 2 ? codeInput : newPasswordInput;
    window.setTimeout(() => focus?.focus(), 0);
}

// ---------------------------------------------------------------------------
// Passo 1 e reenvio
// ---------------------------------------------------------------------------

/** "Reenviar código" só depois de 60 s, com a contagem no próprio botão. */
function startResendCountdown(): void {
    if (!resendButton) return;
    window.clearInterval(resendTimer);

    let remaining = RESEND_SECONDS;
    const tick = (): void => {
        if (remaining <= 0) {
            window.clearInterval(resendTimer);
            resendButton.disabled = false;
            resendButton.textContent = "Reenviar código";
            return;
        }
        resendButton.disabled = true;
        resendButton.textContent = `Reenviar em ${remaining}s`;
        remaining--;
    };
    tick();
    resendTimer = window.setInterval(tick, 1000);
}

async function requestCode(): Promise<boolean> {
    // A resposta é a mesma exista a conta ou não — o texto do passo 2 também
    // não pode afirmar que o e-mail foi enviado.
    await api.auth.forgotPassword(email);

    if (codeSentText) {
        const strong = document.createElement("strong");
        strong.textContent = email;
        codeSentText.replaceChildren(
            "Se houver uma conta com ",
            strong,
            ", enviamos um código. Ele vale por 15 minutos.",
        );
    }
    startResendCountdown();
    return true;
}

emailStep?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!emailInput || !sendCodeButton) return;

    const value = emailInput.value.trim();
    if (!value || !emailInput.checkValidity()) {
        showError(emailError, "Digite um e-mail válido.");
        emailInput.focus();
        return;
    }

    email = value;
    sendCodeButton.disabled = true;
    showError(emailError, null);
    try {
        await requestCode();
        if (codeInput) codeInput.value = "";
        showError(codeError, null);
        showStep(2);
    } catch (err) {
        showError(emailError, errorMessage(err, "Não foi possível enviar o código."));
    } finally {
        sendCodeButton.disabled = false;
    }
});

resendButton?.addEventListener("click", async () => {
    resendButton.disabled = true;
    showError(codeError, null);
    try {
        await requestCode();
        codeInput?.focus();
    } catch (err) {
        showError(codeError, errorMessage(err, "Não foi possível reenviar o código."));
        resendButton.disabled = false;
    }
});

changeEmailButton?.addEventListener("click", () => {
    window.clearInterval(resendTimer);
    showError(emailError, null);
    showStep(1);
});

// ---------------------------------------------------------------------------
// Passo 2: código
// ---------------------------------------------------------------------------

// Só dígitos: colar "123 456" ou "Código: 123456" do e-mail também funciona.
codeInput?.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
    if (codeInput.value !== digits) codeInput.value = digits;
});

codeStep?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!codeInput || !verifyCodeButton) return;

    const code = codeInput.value;
    if (!/^\d{6}$/.test(code)) {
        showError(codeError, "Digite os 6 dígitos do código.");
        codeInput.focus();
        return;
    }

    verifyCodeButton.disabled = true;
    showError(codeError, null);
    try {
        const result = await api.auth.verifyResetCode(email, code);
        resetToken = result.resetToken;
        window.clearInterval(resendTimer);
        showStep(3);
    } catch (err) {
        showError(codeError, errorMessage(err, "Não foi possível conferir o código."));
        codeInput.select();
    } finally {
        verifyCodeButton.disabled = false;
    }
});

// ---------------------------------------------------------------------------
// Passo 3: nova senha
// ---------------------------------------------------------------------------

/** Mesmas regras do backend (server/lib/password.ts), conferidas ao digitar. */
const RULES: Record<string, (password: string, confirm: string) => boolean> = {
    length: (p) => p.length >= 8,
    digits: (p) => (p.match(/\d/g) ?? []).length >= 3,
    special: (p) => /[^A-Za-z0-9]/.test(p),
    match: (p, c) => p.length > 0 && p === c,
};

function updateRules(): boolean {
    const password = newPasswordInput?.value ?? "";
    const confirm = confirmPasswordInput?.value ?? "";
    let allOk = true;
    for (const item of document.querySelectorAll<HTMLElement>("#password-rules [data-rule]")) {
        const ok = RULES[item.dataset.rule ?? ""]?.(password, confirm) ?? false;
        item.classList.toggle("ok", ok);
        allOk &&= ok;
    }
    return allOk;
}

newPasswordInput?.addEventListener("input", updateRules);
confirmPasswordInput?.addEventListener("input", updateRules);

showPassword?.addEventListener("change", () => {
    const type = showPassword.checked ? "text" : "password";
    if (newPasswordInput) newPasswordInput.type = type;
    if (confirmPasswordInput) confirmPasswordInput.type = type;
});

passwordStep?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!newPasswordInput || !resetPasswordButton) return;

    if (!updateRules()) {
        showError(passwordError, "A senha ainda não cumpre todos os requisitos.");
        newPasswordInput.focus();
        return;
    }

    resetPasswordButton.disabled = true;
    showError(passwordError, null);
    try {
        await api.auth.resetPassword(resetToken, newPasswordInput.value);
        // O reset encerrou todas as sessões, inclusive uma deste navegador.
        clearToken();
        window.location.replace(`${pages.login}?reset=ok`);
    } catch (err) {
        showError(passwordError, errorMessage(err, "Não foi possível alterar a senha."));
        resetPasswordButton.disabled = false;
    }
});

export {};
