export {};

const emailStep = document.getElementById("email-step");
const codeStep = document.getElementById("code-step");
const passwordStep = document.getElementById("password-step");
const emailInput = document.getElementById("email-input");
const codeInput = document.getElementById("code-input");
const newPasswordInput = document.getElementById("new-password");
const confirmPasswordInput = document.getElementById("confirm-password");
const sendCodeButton = document.getElementById("sendCodeButton");
const verifyCodeButton = document.getElementById("verifyCodeButton");
const resetPasswordButton = document.getElementById("resetPasswordButton");

if (
  emailStep instanceof HTMLElement &&
  codeStep instanceof HTMLElement &&
  passwordStep instanceof HTMLElement &&
  emailInput instanceof HTMLInputElement &&
  codeInput instanceof HTMLInputElement &&
  newPasswordInput instanceof HTMLInputElement &&
  confirmPasswordInput instanceof HTMLInputElement &&
  sendCodeButton instanceof HTMLButtonElement &&
  verifyCodeButton instanceof HTMLButtonElement &&
  resetPasswordButton instanceof HTMLButtonElement
) {
  const showCodeStep = (): void => {
    if (emailInput.value.trim() !== "") {
      codeStep.style.display = "flex";
      return;
    }

    alert("Por favor, digite seu email primeiro.");
    emailInput.focus();
  };

  const verifyCode = (): void => {
    if (codeInput.value.trim() !== "") {
      emailStep.style.display = "none";
      codeStep.style.display = "none";
      passwordStep.style.display = "flex";
      return;
    }

    alert("Por favor, digite o código recebido.");
    codeInput.focus();
  };

  const resetPassword = (): void => {
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (newPassword === "" || confirmPassword === "") {
      alert("Por favor, preencha as duas senhas.");
      return;
    }

    if (newPassword !== confirmPassword) {
      alert("As senhas não coincidem.");
      return;
    }

    alert("Senha alterada com sucesso!");
    window.location.href = "../index.html";
  };

  sendCodeButton.addEventListener("click", showCodeStep);
  verifyCodeButton.addEventListener("click", verifyCode);
  resetPasswordButton.addEventListener("click", resetPassword);
}
