export {};

const modal = document.getElementById("terms-modal");
const errorElement = document.getElementById("register-error");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirm-password");
const usernameInput = document.getElementById("username");
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

  const handleRegister = (): void => {
    errorElement.style.display = "none";

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const username = usernameInput.value.trim();
    const termsChecked = termsCheckbox.checked;

    if (!email || !password || !confirmPassword || !username) {
      showError("Por favor, preencha todos os campos.");
      return;
    }

    const numberCount = (password.match(/\d/g) || []).length;
    const specialCount = (password.match(/[^A-Za-z0-9]/g) || []).length;

    if (password.length < 8 || numberCount < 3 || specialCount < 1) {
      showError(
        "A senha precisa ter no mínimo 8 caracteres, 3 números e 1 caractere especial."
      );
      return;
    }

    if (password !== confirmPassword) {
      showError("As senhas não coincidem.");
      return;
    }

    const usuariosExistentes = new Set(["admin", "teste", "famax"]);
    if (usuariosExistentes.has(username.toLowerCase())) {
      showError("Esse nome de usuário já está em uso.");
      return;
    }

    if (!termsChecked) {
      showError("Você precisa aceitar os termos de usuário para criar a conta.");
      return;
    }

    alert("Conta cadastrada com sucesso!");
    window.location.href = "../index.html";
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
