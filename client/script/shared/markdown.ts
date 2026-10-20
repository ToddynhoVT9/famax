/**
 * FAMAX — Markdown de posts e comentários (Shared)
 *
 * marked transforma o texto em HTML e o DOMPurify limpa o resultado antes de
 * ele tocar o DOM. As duas camadas importam: o marked não é um sanitizador
 * (HTML cru no texto passaria direto), e o DOMPurify sozinho não sabe nada de
 * markdown.
 *
 * O que é aceito: negrito, itálico, tachado, links, listas, código (inline e
 * em bloco), citação, tabela, spoiler ||texto|| e menções @username. O que
 * não é:
 *  - HTML escrito no texto: aparece como texto, escapado (renderer.html);
 *  - imagem por markdown (![](url)): vira link — imagem de fora carregaria
 *    um pixel de rastreio para cada leitor; imagens de verdade são as do
 *    upload, em grade (post-thread.ts);
 *  - títulos (#): viram parágrafo em negrito, para um post não gritar.
 *
 * Links externos abrem em nova aba com rel="noopener nofollow ugc"; menções
 * levam ao perfil (pages.profile?u=username, resolvido pela página).
 */
import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";
import DOMPurify from "dompurify";
import { escapeHtml } from "./dom.js";
import { pages } from "./pages.js";

/** Mesma regra do servidor (lib/mentions.ts) e do cadastro. */
const MENTION_START = /(^|[^\w@])@[a-zA-Z0-9_]{3,50}(?![a-zA-Z0-9_])/;
const MENTION_TOKEN = /^@([a-zA-Z0-9_]{3,50})(?![a-zA-Z0-9_])/;

export function mentionUrl(username: string): string {
    return `${pages.profile}?u=${encodeURIComponent(username)}`;
}

const mention: TokenizerAndRendererExtension = {
    name: "mention",
    level: "inline",
    // Só aponta o @ que não está colado em outra palavra (e-mail não é menção).
    start(src: string) {
        const match = MENTION_START.exec(src);
        return match ? match.index + match[1].length : undefined;
    },
    tokenizer(src: string) {
        const match = MENTION_TOKEN.exec(src);
        if (match) return { type: "mention", raw: match[0], username: match[1] };
        return undefined;
    },
    renderer(token) {
        const username = String(token.username);
        return `<a class="md-mention" href="${escapeHtml(mentionUrl(username))}">@${escapeHtml(username)}</a>`;
    },
};

const spoiler: TokenizerAndRendererExtension = {
    name: "spoiler",
    level: "inline",
    start(src: string) {
        const index = src.indexOf("||");
        return index >= 0 ? index : undefined;
    },
    tokenizer(src: string) {
        const match = /^\|\|(?=\S)([\s\S]*?\S)\|\|/.exec(src);
        if (!match) return undefined;
        return { type: "spoiler", raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) {
        const inner = this.parser.parseInline((token as { tokens: Tokens.Generic[] }).tokens ?? []);
        return `<span class="md-spoiler" role="button" tabindex="0" aria-label="Spoiler: clique para revelar">${inner}</span>`;
    },
};

const marked = new Marked({ gfm: true, breaks: true, async: false });
marked.use({
    extensions: [mention, spoiler],
    renderer: {
        html(token: Tokens.HTML | Tokens.Tag) {
            return escapeHtml(token.text);
        },
        image(token: Tokens.Image) {
            return `<a href="${escapeHtml(token.href)}">${escapeHtml(token.text || token.href)}</a>`;
        },
        heading(token: Tokens.Heading) {
            return `<p><strong>${this.parser.parseInline(token.tokens)}</strong></p>\n`;
        },
    },
});

const PURIFY_CONFIG = {
    ALLOWED_TAGS: [
        "p", "br", "strong", "em", "del", "s", "a", "ul", "ol", "li", "code", "pre",
        "blockquote", "span", "hr", "table", "thead", "tbody", "tr", "th", "td",
    ],
    ALLOWED_ATTR: ["href", "title", "class", "tabindex", "role", "aria-label", "start"],
};

// Depois da limpeza: links de fora em nova aba, sem dar acesso a esta página
// (noopener), sem endosso para buscadores (nofollow) e marcados como conteúdo
// de usuário (ugc). Menção é link interno e abre aqui mesmo.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName !== "A") return;
    if (node.classList.contains("md-mention")) return;
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener nofollow ugc");
});

/** Texto do usuário → HTML seguro para innerHTML. */
export function renderMarkdown(text: string): string {
    const html = marked.parse(text ?? "") as string;
    return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/** Texto corrido, sem marcação — para resumos (busca, perfil, meta description). */
export function markdownToText(text: string): string {
    const box = document.createElement("div");
    box.innerHTML = renderMarkdown(text);
    // Spoiler não vaza no resumo.
    box.querySelectorAll(".md-spoiler").forEach((el) => el.replaceWith("[spoiler]"));
    return (box.textContent ?? "").replace(/\s+/g, " ").trim();
}

// Spoiler: clique (ou Enter/Espaço) revela. Um listener para a página toda.
function reveal(target: EventTarget | null): boolean {
    const el = (target as Element | null)?.closest?.(".md-spoiler:not(.is-revealed)");
    if (!el) return false;
    el.classList.add("is-revealed");
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.removeAttribute("aria-label");
    return true;
}

document.addEventListener("click", (event) => {
    if (reveal(event.target)) event.preventDefault();
});
document.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && reveal(event.target)) event.preventDefault();
});
