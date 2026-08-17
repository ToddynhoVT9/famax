/**
 * FAMAX — Helpers de DOM (Shared)
 *
 * `escapeHtml` existe porque os três sistemas renderizam texto vindo de outros
 * usuários (mensagens, comentários, títulos de post). Qualquer um desses campos
 * inserido via innerHTML sem escape é XSS armazenado.
 *
 * Regra: ou o texto entra por textContent, ou passa por escapeHtml antes de ir
 * para uma template string. Nunca direto.
 */

export function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Iniciais para os avatares circulares (ex: "Ana Paula" -> "AP"). */
export function initials(name: string | null | undefined): string {
    const clean = (name ?? "").trim();
    if (!clean) return "?";

    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = [
    "bg-blue",
    "bg-pink",
    "bg-gray",
    "bg-orange",
    "bg-lightb",
    "bg-teal",
] as const;

/**
 * Cor de avatar estável por usuário — o mesmo id sempre recebe a mesma cor,
 * em qualquer página e entre sessões.
 */
export function avatarColor(seed: string | null | undefined): string {
    const key = seed ?? "";
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** "3 horas atrás", "agora", "12/03/2026" — formato usado nos stats do post. */
export function timeAgo(isoDate: string): string {
    const then = new Date(isoDate).getTime();
    if (Number.isNaN(then)) return "";

    const seconds = Math.floor((Date.now() - then) / 1000);
    if (seconds < 90) return "agora";

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} ${minutes === 1 ? "minuto" : "minutos"} atrás`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} ${hours === 1 ? "hora" : "horas"} atrás`;
    }

    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days} ${days === 1 ? "dia" : "dias"} atrás`;
    }

    return new Date(isoDate).toLocaleDateString("pt-BR");
}

/** Hora curta para os balões do chat (ex: "14:32"). */
export function shortTime(isoDate: string): string {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** Lê um parâmetro da query string da página atual. */
export function queryParam(name: string): string | null {
    return new URLSearchParams(window.location.search).get(name);
}
