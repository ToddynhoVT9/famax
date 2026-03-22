export {};

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
  const usuariosValidos = new Set(["admin", "teste@famax.com"]);

  const showError = (message: string): void => {
    errorElement.innerText = message;
    errorElement.style.display = "block";
  };

  const realizarLogin = (): void => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    errorElement.style.display = "none";

    if (username === "") {
      showError("Por favor, digite seu e-mail ou usuário.");
      return;
    }

    if (!usuariosValidos.has(username)) {
      showError("Esse email e/ou usuario não existe ou está digitado errado");
      return;
    }

    const senhaCorreta =
      (username === "admin" && password === "123") ||
      (username === "teste@famax.com" && password === "senha123");

    if (!senhaCorreta) {
      showError("senha incorreta, tente novamente");
      return;
    }

    window.location.href = "../home.html";
  };

  loginButton.addEventListener("click", realizarLogin);

  [usernameInput, passwordInput].forEach((input) => {
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        realizarLogin();
      }
    });
  });
}
