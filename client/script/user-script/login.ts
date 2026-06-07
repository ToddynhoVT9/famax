import { api, setToken } from "../shared/api.js";

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
      const { token } = await api<{ token: string; user: unknown }>(
        "/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ identifier, password }),
        },
      );
      setToken(token);
      window.location.href = "../home.html";
    } catch (err) {
      showError(err instanceof Error ? err.message : "Erro ao fazer login");
    } finally {
      loginButton.disabled = false;
    }
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

export {};
