/**
 * FAMAX — Reações (Shared)
 *
 * A lista de reações (mesma do reaction_type_enum, migration 018) e o desenho
 * do botão + seletor usado em shared/post-thread.ts. O seletor abre ao passar
 * o mouse (desktop), ao segurar o botão (toque) ou com a seta para cima no
 * teclado; o clique simples continua sendo "curtir / desfazer".
 *
 * Classes do design system (fx-react*, fx-stat, no post.css); o post-thread.ts
 * acha as partes pelos data-* (data-react, data-react-picker...).
 */
import { escapeHtml } from "./dom.js";
import type { ReactionCounts, ReactionType } from "../../../shared/api-types.js";
export type { ReactionCounts, ReactionType };

export const REACTIONS: Array<{ type: ReactionType; emoji: string; label: string }> = [
    { type: "like", emoji: "👍", label: "Curtir" },
    { type: "love", emoji: "❤️", label: "Amei" },
    { type: "haha", emoji: "😂", label: "Haha" },
    { type: "wow", emoji: "😮", label: "Uau" },
    { type: "sad", emoji: "😢", label: "Triste" },
];

const BY_TYPE = new Map(REACTIONS.map((r) => [r.type, r]));

export function isReactionType(value: unknown): value is ReactionType {
    return typeof value === "string" && BY_TYPE.has(value as ReactionType);
}

export function reactionEmoji(type: ReactionType | null): string {
    return BY_TYPE.get(type ?? "like")?.emoji ?? "👍";
}

export function reactionLabel(type: ReactionType | null): string {
    return BY_TYPE.get(type ?? "like")?.label ?? "Curtir";
}

/**
 * Estado depois de um clique, calculado no cliente para a resposta otimista
 * (mesma regra do servidor): sem tipo desfaz/curte; o mesmo tipo desfaz;
 * outro tipo troca.
 */
export function nextReaction(current: ReactionType | null, requested: ReactionType | null): ReactionType | null {
    if (current && (!requested || requested === current)) return null;
    return requested ?? "like";
}

export function applyToCounts(
    counts: ReactionCounts,
    from: ReactionType | null,
    to: ReactionType | null,
): ReactionCounts {
    const next: ReactionCounts = { ...counts };
    if (from) next[from] = Math.max(0, (next[from] ?? 0) - 1);
    if (to) next[to] = (next[to] ?? 0) + 1;
    return next;
}

/** "❤️😂👍" com as 3 reações mais usadas; o title detalha as contagens. */
export function reactionSummaryHtml(counts: ReactionCounts): string {
    const used = REACTIONS.map((r) => ({ ...r, n: counts[r.type] ?? 0 }))
        .filter((r) => r.n > 0)
        .sort((a, b) => b.n - a.n);
    if (used.length === 0) return '<span class="fx-react-summary" data-react-summary hidden></span>';
    const title = used.map((r) => `${r.n} ${r.label}`).join(", ");
    return `<span class="fx-react-summary" data-react-summary title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${used
        .slice(0, 3)
        .map((r) => r.emoji)
        .join("")}</span>`;
}

/** Botão principal + seletor (escondido) de um post. */
export function reactionControlHtml(mine: ReactionType | null, total: number, counts: ReactionCounts): string {
    const options = REACTIONS.map(
        (r) =>
            `<button type="button" class="fx-react-option${r.type === mine ? " is-mine" : ""}" role="menuitem"
                     data-action="react" data-type="${r.type}" title="${r.label}" aria-label="${r.label}">${r.emoji}</button>`,
    ).join("");
    return `
        <div class="fx-react" data-react>
            <button type="button" class="fx-stat${mine ? " is-active" : ""}"
                    data-action="like" data-reaction="${mine ?? ""}" aria-pressed="${mine !== null}"
                    aria-haspopup="menu" aria-expanded="false"
                    aria-label="${mine ? `Sua reação: ${reactionLabel(mine)}. Clique para desfazer` : "Curtir"}"
                    title="Passe o mouse, segure ou use a seta para cima para escolher a reação">
                <span class="fx-react-emoji" data-react-emoji>${reactionEmoji(mine)}</span> <span data-count="likes">${total}</span>
            </button>
            <div class="fx-react-picker" data-react-picker role="menu" aria-label="Escolher reação" hidden>${options}</div>
        </div>
        ${reactionSummaryHtml(counts)}`;
}
