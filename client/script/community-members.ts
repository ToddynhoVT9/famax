/**
 * FAMAX — Vista "Membros" da página da comunidade
 *
 * Lista paginada de GET /communities/:id/members (dono, moderadores e depois
 * por data de entrada), com filtro por papel. Para quem pode: o dono promove
 * e rebaixa moderadores e transfere a comunidade; dono e moderadores banem
 * quem está abaixo deles. O backend refaz todas essas checagens.
 */
import { api, getCurrentUserId } from "./shared/api.js";
import { profileUrl } from "./shared/pages.js";
import { avatarColor, initials } from "./shared/dom.js";
import { confirmDialog, toast } from "./shared/dialog.js";
import {
    canModerate,
    openBanDialog,
    roleBadge,
    type CommunityRole,
} from "./shared/moderation.js";
import type { CommunityMember as Member } from "../../shared/api-types.js";

export interface MembersViewOptions {
    communityId: string;
    /** Lidos na hora de desenhar: o papel muda depois de transferir. */
    viewerRole: () => CommunityRole | null;
    communityName: () => string;
    /** Algo mudou que afeta o topo da página (contagem, dono). */
    onCommunityChanged: () => Promise<void>;
}

const PER_PAGE = 20;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function createMembersView(root: HTMLElement, options: MembersViewOptions) {
    const { communityId } = options;

    let roleFilter: "" | "moderator" = "";
    let page = 0;
    let totalPages = 0;
    let seq = 0;

    // ----- Estrutura fixa ---------------------------------------------------

    const filters = el("div", "tf-category-chips");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filtrar membros");
    const chip = (label: string, value: "" | "moderator") => {
        const b = el("button", "fx-chip", label);
        b.type = "button";
        b.dataset.role = value;
        b.setAttribute("aria-pressed", String(value === roleFilter));
        return b;
    };
    filters.append(chip("Todos", ""), chip("Moderadores", "moderator"));

    const total = el("p", "tf-members-total");
    const list = el("ul", "tf-members-list");
    const more = el("button", "fx-btn fx-btn--outline fx-btn--pill list-more", "Carregar mais");
    more.type = "button";
    more.hidden = true;
    root.replaceChildren(filters, total, list, more);

    // ----- Render -----------------------------------------------------------

    function actionButton(label: string, action: string, danger = false): HTMLButtonElement {
        const b = el("button", `fx-btn fx-btn--sm fx-btn--pill ${danger ? "fx-btn--outline-danger" : "fx-btn--outline-ink"}`, label);
        b.type = "button";
        b.dataset.action = action;
        return b;
    }

    function renderMember(member: Member): HTMLLIElement {
        const name = member.displayName?.trim() || member.username;
        const viewer = options.viewerRole();
        const self = member.userId === getCurrentUserId();

        const item = el("li", "tf-member");
        item.dataset.userId = member.userId;
        item.dataset.name = name;

        const avatar = el("a", "fx-avatar fx-avatar--md");
        avatar.href = profileUrl(member.userId);
        avatar.setAttribute("aria-hidden", "true");
        avatar.tabIndex = -1;
        if (member.avatarUrl) {
            const img = el("img");
            img.src = member.avatarUrl;
            img.alt = "";
            avatar.append(img);
        } else {
            avatar.classList.add(avatarColor(member.userId));
            avatar.textContent = initials(name);
        }

        const info = el("div", "tf-member-info");
        const nameLink = el("a", "tf-member-name", name);
        nameLink.href = profileUrl(member.userId);
        info.append(nameLink);
        if (member.role !== "member") {
            info.append(roleBadge(member.role));
        }
        info.append(
            el(
                "span",
                "tf-member-meta",
                `@${member.username} · entrou em ${new Date(member.joinedAt).toLocaleDateString("pt-BR")}`,
            ),
        );

        const actions = el("div", "tf-member-actions");
        if (!self && viewer === "owner" && member.role !== "owner") {
            actions.append(
                member.role === "moderator"
                    ? actionButton("Remover moderador", "demote")
                    : actionButton("Tornar moderador", "promote"),
                actionButton("Transferir comunidade", "transfer"),
            );
        }
        if (!self && canModerate(viewer, member.role)) {
            actions.append(actionButton("Banir", "ban", true));
        }

        item.append(avatar, info, actions);
        return item;
    }

    // ----- Carregar -----------------------------------------------------------

    async function load(reset: boolean): Promise<void> {
        const current = ++seq;
        if (reset) {
            page = 0;
            list.replaceChildren(el("li", "tf-feed-status", "Carregando membros..."));
            more.hidden = true;
        }
        more.disabled = true;

        const params = new URLSearchParams({ page: String(page + 1), limit: String(PER_PAGE) });
        if (roleFilter) params.set("role", roleFilter);
        try {
            const result = await api.communities.members(communityId, { page: page + 1, limit: PER_PAGE, role: roleFilter });
            if (current !== seq) return;

            page += 1;
            totalPages = result.pagination.totalPages;
            if (reset) list.replaceChildren();
            list.append(...result.data.map(renderMember));

            const n = result.pagination.total;
            total.textContent = roleFilter
                ? `${n} ${n === 1 ? "moderador" : "moderadores"}`
                : `${n} ${n === 1 ? "membro" : "membros"}`;
            if (n === 0) list.replaceChildren(el("li", "tf-feed-status", "Nenhum moderador além do dono."));
            more.hidden = page >= totalPages;
        } catch (err) {
            if (current !== seq) return;
            const message = err instanceof Error ? err.message : "Não foi possível carregar os membros.";
            if (reset) list.replaceChildren(el("li", "tf-feed-status error", message));
            else toast(message, "error");
        } finally {
            if (current === seq) more.disabled = false;
        }
    }

    // ----- Ações ------------------------------------------------------------

    async function setRole(userId: string, name: string, role: "moderator" | "member"): Promise<void> {
        try {
            await api.communities.setMemberRole(communityId, userId, role);
            toast(role === "moderator" ? `${name} agora é moderador.` : `${name} deixou de ser moderador.`);
            await load(true);
        } catch (err) {
            toast(err instanceof Error ? err.message : "Não foi possível mudar o papel.", "error");
        }
    }

    async function transfer(userId: string, name: string): Promise<void> {
        const communityName = options.communityName();
        const ok = await confirmDialog({
            title: `Transferir para ${name}?`,
            message: `${name} passa a ser o dono de "${communityName}" e você vira moderador. Só o novo dono pode desfazer.`,
            confirmLabel: "Transferir",
            danger: true,
            requireText: communityName,
        });
        if (!ok) return;
        try {
            await api.communities.transferOwnership(communityId, userId, communityName);
            toast(`A comunidade agora é de ${name}.`);
            await options.onCommunityChanged();
            await load(true);
        } catch (err) {
            toast(err instanceof Error ? err.message : "Não foi possível transferir.", "error");
        }
    }

    filters.addEventListener("click", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(".fx-chip");
        if (!button) return;
        roleFilter = (button.dataset.role ?? "") as "" | "moderator";
        filters.querySelectorAll(".fx-chip").forEach((c) => c.setAttribute("aria-pressed", String(c === button)));
        void load(true);
    });

    list.addEventListener("click", async (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-action]");
        const item = button?.closest<HTMLElement>(".tf-member");
        const userId = item?.dataset.userId;
        const name = item?.dataset.name ?? "";
        if (!button || !userId) return;

        switch (button.dataset.action) {
            case "promote":
                return setRole(userId, name, "moderator");
            case "demote":
                return setRole(userId, name, "member");
            case "transfer":
                return transfer(userId, name);
            case "ban":
                if (await openBanDialog(communityId, userId, name)) {
                    await options.onCommunityChanged();
                    await load(true);
                }
                return;
        }
    });

    more.addEventListener("click", () => void load(false));

    return {
        /** Recarrega do zero (ao abrir a vista ou depois de uma mudança). */
        reload: () => load(true),
    };
}
