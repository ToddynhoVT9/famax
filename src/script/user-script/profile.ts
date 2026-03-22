export {};

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebarToggle");
const searchInput = document.getElementById("searchInput");
const searchSuggestions = document.getElementById("searchSuggestions");
const btnFiltros = document.getElementById("btnFiltros");
const filtrosDropdown = document.getElementById("filtrosDropdown");
const btnChangePassword = document.getElementById("btnChangePassword");
const senhaModalOverlay = document.getElementById("senhaModalOverlay");
const modalStep1 = document.getElementById("modalStep1");
const modalStep2 = document.getElementById("modalStep2");
const modalStep3 = document.getElementById("modalStep3");
const currentPasswordInput = document.getElementById("currentPasswordInput");
const newPasswordInput = document.getElementById("newPasswordInput");
const confirmPasswordInput = document.getElementById("confirmPasswordInput");
const btnSobre = document.getElementById("btnSobre");
const sobreModalOverlay = document.getElementById("sobreModalOverlay");
const generoOptionsContainer = document.getElementById("generoOptionsContainer");
const toggleSwitches = document.querySelectorAll<HTMLElement>(".toggle-switch-ui");

if (
  sidebar instanceof HTMLElement &&
  sidebarToggle instanceof HTMLButtonElement &&
  searchInput instanceof HTMLInputElement &&
  searchSuggestions instanceof HTMLElement &&
  btnFiltros instanceof HTMLButtonElement &&
  filtrosDropdown instanceof HTMLElement &&
  btnChangePassword instanceof HTMLElement &&
  senhaModalOverlay instanceof HTMLElement &&
  modalStep1 instanceof HTMLElement &&
  modalStep2 instanceof HTMLElement &&
  modalStep3 instanceof HTMLElement &&
  currentPasswordInput instanceof HTMLInputElement &&
  newPasswordInput instanceof HTMLInputElement &&
  confirmPasswordInput instanceof HTMLInputElement &&
  btnSobre instanceof HTMLElement &&
  sobreModalOverlay instanceof HTMLElement &&
  generoOptionsContainer instanceof HTMLElement
) {
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    sidebarToggle.classList.toggle("open");
  });

  searchInput.addEventListener("focus", () => {
    searchSuggestions.classList.add("show");
  });

  btnFiltros.addEventListener("click", (event: MouseEvent) => {
    event.stopPropagation();
    filtrosDropdown.classList.toggle("show");
    btnFiltros.classList.toggle("active");
  });

  document.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;

    if (!(target instanceof Node)) {
      return;
    }

    if (
      !searchInput.contains(target) &&
      !searchSuggestions.contains(target)
    ) {
      searchSuggestions.classList.remove("show");
    }

    if (!btnFiltros.contains(target) && !filtrosDropdown.contains(target)) {
      filtrosDropdown.classList.remove("show");
      btnFiltros.classList.remove("active");
    }
  });

  toggleSwitches.forEach((toggleSwitch) => {
    toggleSwitch.addEventListener("click", () => {
      toggleSwitch.classList.toggle("on");
    });
  });

  btnChangePassword.addEventListener("click", () => {
    modalStep1.style.display = "block";
    modalStep2.style.display = "none";
    modalStep3.style.display = "none";

    currentPasswordInput.value = "";
    newPasswordInput.value = "";
    confirmPasswordInput.value = "";

    senhaModalOverlay.classList.add("show");
    window.setTimeout(() => currentPasswordInput.focus(), 100);
  });

  senhaModalOverlay.addEventListener("click", (event: MouseEvent) => {
    if (event.target === senhaModalOverlay) {
      senhaModalOverlay.classList.remove("show");
    }
  });

  currentPasswordInput.addEventListener(
    "keydown",
    (event: KeyboardEvent): void => {
      if (event.key !== "Enter") {
        return;
      }

      if (currentPasswordInput.value.trim() !== "") {
        modalStep1.style.display = "none";
        modalStep2.style.display = "block";
        window.setTimeout(() => newPasswordInput.focus(), 100);
        return;
      }

      alert("Digite a senha atual.");
    }
  );

  newPasswordInput.addEventListener(
    "keydown",
    (event: KeyboardEvent): void => {
      if (event.key === "Enter") {
        confirmPasswordInput.focus();
      }
    }
  );

  confirmPasswordInput.addEventListener(
    "keydown",
    (event: KeyboardEvent): void => {
      if (event.key !== "Enter") {
        return;
      }

      if (newPasswordInput.value.trim() === "") {
        alert("A nova senha não pode ser vazia.");
        return;
      }

      if (newPasswordInput.value === confirmPasswordInput.value) {
        modalStep2.style.display = "none";
        modalStep3.style.display = "block";

        window.setTimeout(() => {
          senhaModalOverlay.classList.remove("show");
        }, 2500);
        return;
      }

      alert("As senhas digitadas não coincidem. Verifique e tente novamente!");
    }
  );

  btnSobre.addEventListener("click", () => {
    sobreModalOverlay.classList.add("show");
  });

  sobreModalOverlay.addEventListener("click", (event: MouseEvent) => {
    if (event.target === sobreModalOverlay) {
      sobreModalOverlay.classList.remove("show");
    }
  });

  const generosBtns =
    generoOptionsContainer.querySelectorAll<HTMLButtonElement>(".btn-genero");

  generosBtns.forEach((button) => {
    button.addEventListener("click", () => {
      generosBtns.forEach((btn) => btn.classList.remove("selected"));
      button.classList.add("selected");
    });
  });
}
