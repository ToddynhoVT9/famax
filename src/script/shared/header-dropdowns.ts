/**
 * FAMAX — Header Dropdowns (Shared)
 * Inicializa os dropdowns de pesquisa e filtros do header.
 */
export function initHeaderDropdowns(): void {
    const searchInput = document.getElementById("searchInput");
    const searchSuggestions = document.getElementById("searchSuggestions");
    const btnFiltros = document.getElementById("btnFiltros");
    const filtrosDropdown = document.getElementById("filtrosDropdown");

    if (
        searchInput instanceof HTMLInputElement &&
        searchSuggestions instanceof HTMLElement &&
        btnFiltros instanceof HTMLButtonElement &&
        filtrosDropdown instanceof HTMLElement
    ) {
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

            if (
                !btnFiltros.contains(target) &&
                !filtrosDropdown.contains(target)
            ) {
                filtrosDropdown.classList.remove("show");
                btnFiltros.classList.remove("active");
            }
        });
    }
}
