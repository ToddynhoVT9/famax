import { api, setToken } from "../shared/api.js";
import { redirectIfLoggedIn } from "../shared/auth-guard.js";
import { pages } from "../shared/pages.js";
import { trapFocus } from "../shared/focus-trap.js";
import { bindWindowActions, lockPageScroll } from "../shared/window.js";
import { bindPasswordRules } from "../shared/password-rules.js";
import { followKeyboard } from "../shared/keyboard.js";

redirectIfLoggedIn();
// Celular: com o teclado aberto, o campo focado volta para a vista.
followKeyboard();

const modal = document.getElementById("terms-modal");
const errorElement = document.getElementById("register-error");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirm-password");
const usernameInput = document.getElementById("username");
const displayNameInput = document.getElementById("display-name");
const privateCheckbox = document.getElementById("private-checkbox");
const termsCheckbox = document.getElementById("terms-checkbox");
const termsTrigger = document.getElementById("termsTrigger");
const closeModalButton = document.getElementById("closeModalButton");
const termsClose = document.getElementById("termsClose");
const termsAccept = document.getElementById("termsAccept");
const registerButton = document.getElementById("registerButton");

if (
  modal instanceof HTMLElement &&
  errorElement instanceof HTMLElement &&
  emailInput instanceof HTMLInputElement &&
  passwordInput instanceof HTMLInputElement &&
  confirmPasswordInput instanceof HTMLInputElement &&
  usernameInput instanceof HTMLInputElement &&
  displayNameInput instanceof HTMLInputElement &&
  privateCheckbox instanceof HTMLInputElement &&
  termsCheckbox instanceof HTMLInputElement &&
  termsTrigger instanceof HTMLElement &&
  closeModalButton instanceof HTMLButtonElement &&
  registerButton instanceof HTMLButtonElement
) {
  const dialog = modal.querySelector<HTMLElement>('[role="dialog"]') ?? modal;
  let releaseModal: (() => void) | null = null;

  const closeModal = (): void => {
    modal.hidden = true;
    releaseModal?.();
    releaseModal = null;
  };

  // Janela dos termos (r-win): foco preso, Esc fecha e o foco volta ao link;
  // a página de trás não rola; no celular, "Aceitar" sobe para o topo.
  const openModal = (): void => {
    modal.hidden = false;
    const unbindActions = bindWindowActions(dialog);
    const unlock = lockPageScroll();
    const release = trapFocus(dialog, { onEscape: closeModal, initialFocus: closeModalButton });
    releaseModal = () => {
      unbindActions();
      unlock();
      release();
    };
  };

  // Regras da senha marcadas ao digitar (quem valida é o servidor).
  bindPasswordRules(document.getElementById("password-rules"), passwordInput);

  const fields = [emailInput, passwordInput, confirmPasswordInput, usernameInput, displayNameInput];

  /** A faixa no topo; os campos com problema (vazios ou as senhas) ficam com aria-invalid. */
  const showError = (message: string, invalid: HTMLInputElement[] = []): void => {
    errorElement.innerText = message;
    errorElement.hidden = false;
    for (const field of invalid) {
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-errormessage", errorElement.id);
    }
  };

  const clearError = (): void => {
    errorElement.hidden = true;
    for (const field of [...fields, termsCheckbox]) {
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-errormessage");
    }
  };

  const handleRegister = async (): Promise<void> => {
    clearError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const username = usernameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const termsChecked = termsCheckbox.checked;

    if (!email || !password || !confirmPassword || !username || !displayName) {
      showError("Por favor, preencha todos os campos.", fields.filter((field) => !field.value.trim()));
      return;
    }

    if (password !== confirmPassword) {
      showError("As senhas não coincidem.", [confirmPasswordInput]);
      return;
    }

    if (!termsChecked) {
      showError("Você precisa aceitar os termos de usuário para criar a conta.", [termsCheckbox]);
      return;
    }

    registerButton.disabled = true;

    try {
      const { token } = await api.auth.register({ email, username, password, displayName, termsAccepted: true, isPrivate: privateCheckbox.checked });
      setToken(token);
      // Já sai logado do cadastro: vai direto para a home, como no login.
      window.location.href = pages.home;
    } catch (err) {
      showError(err instanceof Error ? err.message : "Erro ao criar conta");
    } finally {
      registerButton.disabled = false;
    }
  };

  termsTrigger.addEventListener("click", openModal);
  closeModalButton.addEventListener("click", closeModal);
  termsClose?.addEventListener("click", closeModal);
  // "Aceitar os termos" marca a caixa e fecha.
  termsAccept?.addEventListener("click", () => {
    termsCheckbox.checked = true;
    termsCheckbox.removeAttribute("aria-invalid");
    closeModal();
  });
  registerButton.addEventListener("click", handleRegister);

  window.addEventListener("click", (event: MouseEvent) => {
    if (event.target === modal) {
      closeModal();
    }
  });
}

export {};
