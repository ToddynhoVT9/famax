export {};

const sidebar = document.getElementById("sidebar");
const mainContent = document.getElementById("main-content");
const sidebarToggle = document.getElementById("sidebarToggle");
const searchInput = document.getElementById("searchInput");
const searchSuggestions = document.getElementById("searchSuggestions");
const btnFiltros = document.getElementById("btnFiltros");
const filtrosDropdown = document.getElementById("filtrosDropdown");

if (
  sidebar instanceof HTMLElement &&
  mainContent instanceof HTMLElement &&
  sidebarToggle instanceof HTMLButtonElement &&
  searchInput instanceof HTMLInputElement &&
  searchSuggestions instanceof HTMLElement &&
  btnFiltros instanceof HTMLButtonElement &&
  filtrosDropdown instanceof HTMLElement
) {
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    sidebarToggle.classList.toggle("open");
    mainContent.classList.toggle("shifted");
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
}
