import { api, setToken } from "../shared/api.js";

const modal = document.getElementById("terms-modal");
const errorElement = document.getElementById("register-error");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirm-password");
const usernameInput = document.getElementById("username");
const displayNameInput = document.getElementById("display-name");
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
  termsCheckbox instanceof HTMLInputElement &&
  termsTrigger instanceof HTMLElement &&
  closeModalButton instanceof HTMLButtonElement &&
  registerButton instanceof HTMLButtonElement
) {
  const openModal = (): void => {
    modal.style.display = "flex";
  };

  const closeModal = (): void => {
    modal.style.display = "none";
  };

  const showError = (message: string): void => {
    errorElement.innerText = message;
    errorElement.style.display = "block";
  };

  const handleRegister = async (): Promise<void> => {
    errorElement.style.display = "none";

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
      const { token } = await api<{ token: string; user: unknown }>(
        "/auth/register",
        {
          method: "POST",
          body: JSON.stringify({
            email,
            username,
            password,
            displayName,
            termsAccepted: true,
          }),
        },
      );
      setToken(token);
      window.location.href = "../../index.html";
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
