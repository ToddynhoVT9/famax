/**
 * FAMAX — Teclado em abas (Shared)
 *
 * Padrão de tablist do WAI-ARIA para as barras de abas que a página já
 * monta (role="tablist" com botões role="tab" e aria-selected):
 *  - só a aba ativa entra no Tab (tabindex 0; as outras -1);
 *  - setas esquerda/direita, Home e End passam de aba e já a ativam.
 *
 * A troca em si continua no clique de cada página: aqui a seta só foca e
 * clica a aba de destino. Chamar depois de registrar o clique da página.
 */

function tabsOf(tablist: HTMLElement): HTMLElement[] {
    return Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]')).filter((tab) => !tab.hidden);
}

function syncTabindex(tablist: HTMLElement): void {
    for (const tab of tabsOf(tablist)) {
        tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    }
}

export function bindTabKeys(tablist: HTMLElement | null): void {
    if (!tablist) return;
    syncTabindex(tablist);

    tablist.addEventListener("click", () => syncTabindex(tablist));
    tablist.addEventListener("keydown", (event) => {
        const tabs = tabsOf(tablist);
        const index = tabs.indexOf(document.activeElement as HTMLElement);
        if (index < 0) return;
        let target = -1;
        if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") target = 0;
        else if (event.key === "End") target = tabs.length - 1;
        if (target < 0) return;
        event.preventDefault();
        tabs[target].focus();
        tabs[target].click();
    });
}
