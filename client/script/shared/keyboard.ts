/**
 * FAMAX — Teclado do celular (Shared)
 *
 * Com o viewport interactive-widget=resizes-content, o Chrome do Android
 * encolhe a página quando o teclado abre; no iPhone a página não encolhe, e o
 * campo focado pode ficar atrás do teclado. Quando a área visível muda de
 * tamanho (visualViewport resize), o campo focado dentro de `root` volta para
 * a vista.
 *
 * A regra da R: com o teclado aberto, o título, o primeiro campo e a ação
 * principal ficam acima dele. Na janela em tela cheia, a ação está no topo;
 * nos formulários longos, a barra de ações gruda embaixo (sticky) e sobe com
 * a área visível.
 *
 * Devolve a função que desliga.
 */
export function followKeyboard(root: ParentNode = document): () => void {
    const viewport = window.visualViewport;
    if (!viewport) return () => {};

    const onResize = (): void => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !active.matches("input, textarea, select")) return;
        if (root !== document && !(root as Node).contains(active)) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        active.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    };

    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
}
