/**
 * FAMAX — Redes sociais (Shared)
 *
 * Espelha a lista fechada de SOCIAL_PLATFORMS do backend (server/lib/
 * profile.ts). A ordem aqui é a ordem do <select> no editor.
 */
export const SOCIAL_PLATFORM_LABELS: Record<string, string> = {
    site: "Site",
    instagram: "Instagram",
    x: "X (Twitter)",
    youtube: "YouTube",
    twitch: "Twitch",
    tiktok: "TikTok",
    github: "GitHub",
    linkedin: "LinkedIn",
    discord: "Discord",
};

export const MAX_SOCIAL_LINKS = 8;

/**
 * Só https vira link clicável. O backend já recusa o resto, mas o perfil é a
 * última barreira antes do <a href> — "javascript:" ali seria XSS.
 */
export function isSafeLink(url: string): boolean {
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}
