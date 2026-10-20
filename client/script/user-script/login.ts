import { ApiError, api, setToken } from "../shared/api.js";
import { afterLoginUrl, redirectIfLoggedIn } from "../shared/auth-guard.js";

redirectIfLoggedIn();

// A recuperação de senha termina aqui com ?reset=ok.
const notice = document.getElementById("login-notice");
if (notice && new URLSearchParams(window.location.search).get("reset") === "ok") {
  notice.textContent = "Senha alterada. Entre com a nova senha.";
  notice.hidden = false;
}
// A exclusão de conta (configurações) termina aqui com ?deleted=1.
if (notice && new URLSearchParams(window.location.search).get("deleted") === "1") {
  notice.textContent =
    "Sua conta foi excluída. Mudou de ideia? Por 30 dias dá para reativar entrando com seu e-mail e senha.";
  notice.hidden = false;
}

const passwordStep = document.getElementById("passwordStep");
const codeStep = document.getElementById("codeStep");
const codeInput = document.getElementById("mfaCode") as HTMLInputElement | null;
const codeButton = document.getElementById("mfaButton") as HTMLButtonElement | null;
const codeBack = document.getElementById("mfaBack");
/** Segundo passo da verificação em duas etapas: o token entre os passos. */
let mfaToken: string | null = null;

const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const loginButton = document.getElementById("loginButton");
const errorElement = document.getElementById("error-message");

if (
  usernameInput instanceof HTMLInputElement &&
  passwordInput instanceof HTMLInputElement &&
  loginButton instanceof HTMLButtonElement &&
  errorElement instanceof HTMLElement
) {
  const showError = (message: string): void => {
    errorElement.innerText = message;
    errorElement.style.display = "block";
  };

  const realizarLogin = async (): Promise<void> => {
    const identifier = usernameInput.value.trim();
    const password = passwordInput.value;
    errorElement.style.display = "none";

    if (!identifier || !password) {
      showError("Preencha email/usuário e senha.");
      return;
    }

    loginButton.disabled = true;

    try {
      const result = await api<{ token?: string; mfaRequired?: boolean; mfaToken?: string }>(
        "/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ identifier, password }),
        },
      );
      if (result.mfaRequired && result.mfaToken) {
        // Senha certa, falta o código do app (5 min para digitar).
        mfaToken = result.mfaToken;
        if (passwordStep) passwordStep.hidden = true;
        if (codeStep) codeStep.hidden = false;
        codeInput?.focus();
        return;
      }
      setToken(result.token!);
      // Volta para a página que pediu o login (?next=), ou a home.
      window.location.href = afterLoginUrl();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Erro ao fazer login");
      // Conta excluída no prazo (e senha certa): oferece reativar.
      if (err instanceof ApiError && err.body.reactivatable) offerReactivation(identifier, password);
    } finally {
      loginButton.disabled = false;
    }
  };

  const offerReactivation = (identifier: string, password: string): void => {
    document.getElementById("reactivateButton")?.remove();
    const button = document.createElement("button");
    button.id = "reactivateButton";
    button.className = "btn-login";
    button.textContent = "Reativar minha conta";
    errorElement.after(button);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await api<{ token?: string; mfaRequired?: boolean; mfaToken?: string }>(
          "/auth/reactivate",
          { method: "POST", body: JSON.stringify({ identifier, password }) },
        );
        button.remove();
        errorElement.style.display = "none";
        if (result.mfaRequired && result.mfaToken) {
          mfaToken = result.mfaToken;
          if (passwordStep) passwordStep.hidden = true;
          if (codeStep) codeStep.hidden = false;
          codeInput?.focus();
          return;
        }
        setToken(result.token!);
        window.location.href = afterLoginUrl();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Não foi possível reativar.");
        button.disabled = false;
      }
    });
  };

  loginButton.addEventListener("click", realizarLogin);

  const verificarCodigo = async (): Promise<void> => {
    const code = codeInput?.value.trim() ?? "";
    errorElement.style.display = "none";
    if (!mfaToken || !code) {
      showError("Digite o código.");
      return;
    }
    if (codeButton) codeButton.disabled = true;
    try {
      const { token, recoveryCodesLeft } = await api<{ token: string; recoveryCodesLeft?: number }>(
        "/auth/login/2fa",
        { method: "POST", body: JSON.stringify({ mfaToken, code }) },
      );
      setToken(token);
      if (recoveryCodesLeft !== undefined && notice && codeStep) {
        // Avisa antes de sair: os códigos de recuperação acabam.
        notice.textContent =
          `Você entrou com um código de recuperação. Restam ${recoveryCodesLeft}. ` +
          "Gere novos códigos nas configurações se estiverem acabando.";
        notice.hidden = false;
        const next = document.createElement("a");
        next.className = "btn-login";
        next.href = afterLoginUrl();
        next.textContent = "Continuar";
        codeStep.replaceChildren(next);
        next.focus();
        return;
      }
      window.location.href = afterLoginUrl();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Código incorreto");
      if (codeInput) codeInput.value = "";
    } finally {
      if (codeButton) codeButton.disabled = false;
    }
  };

  codeButton?.addEventListener("click", verificarCodigo);
  codeInput?.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void verificarCodigo();
    }
  });
  codeBack?.addEventListener("click", () => {
    mfaToken = null;
    if (codeStep) codeStep.hidden = true;
    if (passwordStep) passwordStep.hidden = false;
    errorElement.style.display = "none";
    passwordInput.value = "";
    passwordInput.focus();
  });

  [usernameInput, passwordInput].forEach((input) => {
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        realizarLogin();
      }
    });
  });
}

export {};
