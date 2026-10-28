import { api, setToken } from "../shared/api.js";
import { redirectIfLoggedIn } from "../shared/auth-guard.js";
import { pages } from "../shared/pages.js";
import { trapFocus } from "../shared/focus-trap.js";

redirectIfLoggedIn();

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
  let releaseFocus: (() => void) | null = null;

  const closeModal = (): void => {
    modal.hidden = true;
    releaseFocus?.();
    releaseFocus = null;
  };

  // Foco preso no modal enquanto aberto; Esc fecha e o foco volta ao link.
  const openModal = (): void => {
    modal.hidden = false;
    releaseFocus = trapFocus(dialog, { onEscape: closeModal, initialFocus: closeModalButton });
  };

  const showError = (message: string): void => {
    errorElement.innerText = message;
    errorElement.hidden = false;
  };

  const handleRegister = async (): Promise<void> => {
    errorElement.hidden = true;

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const username = usernameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const termsChecked = termsCheckbox.checked;

    if (!email || !password || !confirmPassword || !username || !displayName) {
      showError("Por favor, preencha todos os campos.");
      return;
    }

    if (password !== confirmPassword) {
      showError("As senhas não coincidem.");
      return;
    }

    if (!termsChecked) {
      showError("Você precisa aceitar os termos de usuário para criar a conta.");
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
  registerButton.addEventListener("click", handleRegister);

  window.addEventListener("click", (event: MouseEvent) => {
    if (event.target === modal) {
      closeModal();
    }
  });
}

export {};
