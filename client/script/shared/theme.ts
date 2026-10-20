/**
 * FAMAX — Tema claro / escuro (Shared)
 *
 * Três escolhas: "system" (segue o sistema — prefers-color-scheme, o
 * padrão), "light" ou "dark". A escolha manual vai para data-theme no <html>
 * e para o localStorage; os tokens de cor que mudam ficam em global.css.
 *
 * Cada HTML aplica a escolha salva num <script> curto no <head>, antes da
 * primeira pintura (sem isso a página piscaria no tema errado); este módulo
 * cuida da troca em tempo de uso. localStorage pode não existir (modo
 * privado, bloqueado): toda leitura e escrita fica num try/catch, e sem ele
 * vale o tema do sistema.
 */

export type ThemePref = "system" | "light" | "dark";

const KEY = "famax_theme";
const listeners = new Set<(pref: ThemePref) => void>();

export function getThemePref(): ThemePref {
    try {
        const value = localStorage.getItem(KEY);
        return value === "light" || value === "dark" ? value : "system";
    } catch {
        return "system";
    }
}

function apply(pref: ThemePref): void {
    if (pref === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = pref;
}

export function setThemePref(pref: ThemePref): void {
    try {
        if (pref === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
    } catch {
        // Sem armazenamento: vale só até recarregar.
    }
    apply(pref);
    for (const listener of listeners) listener(pref);
}

export function onThemeChange(listener: (pref: ThemePref) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export const THEME_LABELS: Record<ThemePref, string> = {
    system: "Automático (do sistema)",
    light: "Claro",
    dark: "Escuro",
};

// Outra aba trocou o tema: esta acompanha.
window.addEventListener("storage", (event) => {
    if (event.key === KEY) apply(getThemePref());
});

apply(getThemePref());
