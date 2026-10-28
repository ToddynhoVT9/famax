/**
 * FAMAX — Seguir usuários (Shared)
 *
 * O botão Seguir / Seguindo e o diálogo com a lista de seguidores ou de quem
 * a pessoa segue (paginada por cursor). Tudo por createElement/textContent:
 * nomes são texto de usuário.
 */
import { api, getCurrentUserId, getToken } from "./api.js";
import { goToLogin } from "./auth-guard.js";
import { profileUrl } from "./pages.js";
import { avatarColor, initials } from "./dom.js";
import { toast } from "./dialog.js";
import { trapFocus } from "./focus-trap.js";
import type { FollowListItem, FollowState } from "../../../shared/api-types.js";
export type { FollowState };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function setFollowing(userId: string, follow: boolean): Promise<FollowState> {
    return api.users.setFollowing(userId, follow);
}

/**
 * Liga um botão ao estado de seguir. O texto "Seguindo" vira "Deixar de
 * seguir" no hover, como nas redes conhecidas — clicar num "Seguindo" sem
 * aviso é o jeito mais comum de deixar de seguir sem querer.
 */
export function bindFollowButton(
    button: HTMLButtonElement,
    userId: string,
    initial: boolean,
    onChange?: (state: FollowState) => void,
): void {
    let following = initial;

    const render = (): void => {
        button.textContent = following ? "Seguindo" : "Seguir";
        // Seguir é a ação principal; "Seguindo" vira contornado (Button outline).
        button.classList.add("fx-btn", "fx-btn--pill");
        button.classList.toggle("fx-btn--primary", !following);
        button.classList.toggle("fx-btn--outline", following);
        button.setAttribute("aria-pressed", String(following));
    };
    render();

    button.addEventListener("mouseenter", () => {
        if (following && !button.disabled) button.textContent = "Deixar de seguir";
    });
    button.addEventListener("mouseleave", render);

    button.addEventListener("click", async () => {
        if (!getToken()) {
            goToLogin();
            return;
        }
        button.disabled = true;
        try {
            const state = await setFollowing(userId, !following);
            following = state.following;
            render();
            onChange?.(state);
        } catch (err) {
            toast(err instanceof Error ? err.message : "Não foi possível seguir.", "error");
        } finally {
            button.disabled = false;
        }
    });
}

function renderListItem(item: FollowListItem): HTMLLIElement {
    const name = item.displayName?.trim() || item.username;
    const li = el("li", "follow-list-item");

    const link = el("a", "follow-list-user");
    link.href = profileUrl(item.userId);
    const avatar = el("span", "fx-avatar fx-avatar--md");
    if (item.avatarUrl) {
        const img = el("img");
        img.src = item.avatarUrl;
        img.alt = "";
        img.loading = "lazy";
        avatar.append(img);
    } else {
        avatar.classList.add(avatarColor(item.userId));
        avatar.textContent = initials(name);
    }
    const names = el("span", "follow-list-names");
    names.append(el("strong", "", name), el("span", "follow-list-username", `@${item.username}`));
    link.append(avatar, names);
    li.append(link);

    // Botão ao lado de cada pessoa, menos a própria conta (e só com sessão).
    if (getToken() && item.userId !== getCurrentUserId()) {
        const button = el("button", "fx-btn--sm");
        button.type = "button";
        bindFollowButton(button, item.userId, item.followedByMe);
        li.append(button);
    }
    return li;
}

/** Diálogo com a lista "Seguidores" ou "Seguindo" de alguém. */
export function openFollowList(userId: string, kind: "followers" | "following", ownerName: string): void {

    const overlay = el("div", "fx-overlay");
    const box = el("div", "fx-dialog follow-list-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    const header = el("div", "fx-dialog-head");
    const title = el("h2", "fx-dialog-title", kind === "followers" ? "Seguidores" : "Seguindo");
    title.id = `follow-list-${Date.now()}`;
    box.setAttribute("aria-labelledby", title.id);
    const close = el("button", "fx-btn fx-btn--icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Fechar");
    header.append(title, close);

    const subtitle = el(
        "p",
        "follow-list-subtitle",
        kind === "followers" ? `Quem segue ${ownerName}` : `Quem ${ownerName} segue`,
    );
    const list = el("ul", "follow-list");
    const status = el("p", "follow-list-status", "Carregando...");
    const more = el("button", "fx-btn fx-btn--outline fx-btn--pill follow-list-more", "Carregar mais");
    more.type = "button";
    more.hidden = true;

    box.append(header, subtitle, list, status, more);
    overlay.append(box);
    document.body.append(overlay);

    let cursor: string | null = null;

    async function load(): Promise<void> {
        more.disabled = true;
        try {
            const params = new URLSearchParams({ limit: "20" });
            if (cursor) params.set("cursor", cursor);
            const page = await api.users.followList(userId, kind, { limit: 20, cursor });
            list.append(...page.data.map(renderListItem));
            cursor = page.nextCursor;
            more.hidden = !cursor;
            status.hidden = list.childElementCount > 0;
            status.textContent = kind === "followers" ? "Ninguém segue este perfil ainda." : "Este perfil ainda não segue ninguém.";
        } catch (err) {
            status.hidden = false;
            status.textContent = err instanceof Error ? err.message : "Não foi possível carregar.";
        } finally {
            more.disabled = false;
        }
    }

    let releaseFocus = (): void => {};
    function dismiss(): void {
        overlay.remove();
        releaseFocus();
    }

    close.addEventListener("click", dismiss);
    more.addEventListener("click", () => void load());
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) dismiss();
    });
    releaseFocus = trapFocus(box, { onEscape: dismiss, initialFocus: close });
    void load();
}
