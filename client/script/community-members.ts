/**
 * FAMAX — Vista "Membros" da página da comunidade
 *
 * Lista paginada de GET /communities/:id/members (dono, moderadores e depois
 * por data de entrada), com filtro por papel. Para quem pode: o dono promove
 * e rebaixa moderadores e transfere a comunidade; dono e moderadores banem
 * quem está abaixo deles. O backend refaz todas essas checagens.
 *
 * Desenho: MemberList (fx-member, no components.css). As ações são as de
 * antes; a faixa decide onde ficam (community.css):
 *  - desktop: todas na linha;
 *  - compacto e tablet: Tornar moderador e Banir na linha, Transferir no ⋯;
 *  - celular: todas no ⋯.
 */
import { api, getCurrentUserId } from "./shared/api.js";
import { profileUrl } from "./shared/pages.js";
import { avatarColor, initials } from "./shared/dom.js";
import { ICONS } from "./shared/icons.js";
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

    const filters = el("div", "r-hscroll r-hscroll-row");
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

    const total = el("p", "cm-mtotal");
    const list = el("ul", "fx-members r-edge");
    const more = el("button", "fx-btn fx-btn--outline fx-btn--pill list-more", "Carregar mais");
    more.type = "button";
    more.hidden = true;
    root.replaceChildren(total, filters, list, more);

    // ----- Render -----------------------------------------------------------

    /** where: as faixas em que o botão fica na linha (nas outras, está no ⋯). */
    function actionButton(label: string, action: string, danger: boolean, where: string): HTMLButtonElement {
        const b = el("button", `fx-btn fx-btn--sm ${danger ? "fx-btn--outline-danger" : "fx-btn--outline-ink"} ${where}`, label);
        b.type = "button";
        b.dataset.action = action;
        return b;
    }

    function menuItem(label: string, action: string, danger: boolean, where = ""): HTMLButtonElement {
        const b = el("button", `fx-menu-item${danger ? " fx-menu-item--danger" : ""} ${where}`.trim(), label);
        b.type = "button";
        b.setAttribute("role", "menuitem");
        b.dataset.action = action;
        return b;
    }

    function renderMember(member: Member): HTMLLIElement {
        const name = member.displayName?.trim() || member.username;
        const viewer = options.viewerRole();
        const self = member.userId === getCurrentUserId();

        const item = el("li", "fx-member");
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

        const info = el("div", "fx-member-info");
        const nameRow = el("span", "cm-mname");
        const nameLink = el("a", "fx-member-name", name);
        nameLink.href = profileUrl(member.userId);
        nameRow.append(nameLink);
        if (member.role !== "member") {
            nameRow.append(roleBadge(member.role));
        }
        info.append(
            nameRow,
            el(
                "span",
                "fx-member-meta",
                `@${member.username} · entrou em ${new Date(member.joinedAt).toLocaleDateString("pt-BR")}`,
            ),
        );
        item.append(avatar, info);

        // As mesmas ações de antes: na linha (botões) e no ⋯ (itens), por faixa.
        const inline: HTMLButtonElement[] = [];
        const menu: HTMLButtonElement[] = [];
        let transfer = false;
        if (!self && viewer === "owner" && member.role !== "owner") {
            const [label, action] =
                member.role === "moderator" ? ["Remover moderador", "demote"] : ["Tornar moderador", "promote"];
            inline.push(actionButton(label, action, false, "cm-hide-phone"));
            menu.push(menuItem(label, action, false, "cm-show-phone"));
            inline.push(actionButton("Transferir comunidade", "transfer", false, "cm-desktop-only"));
            menu.push(menuItem("Transferir comunidade", "transfer", false));
            transfer = true;
        }
        if (!self && canModerate(viewer, member.role)) {
            inline.push(actionButton("Banir", "ban", true, "cm-hide-phone"));
            menu.push(menuItem("Banir", "ban", true, "cm-show-phone"));
        }
        if (inline.length === 0) return item;

        const actions = el("div", "cm-macts");
        actions.append(...inline);
        // O ⋯ aparece onde algum item não está na linha: abaixo de 1280px com
        // Transferir; só no celular sem ele.
        const more = el("div", `cm-menu ${transfer ? "cm-below-desktop" : "cm-show-phone"}`);
        const toggle = el("button", "fx-btn fx-btn--icon fx-btn--icon-paper cm-mmore");
        toggle.type = "button";
        toggle.innerHTML = ICONS.dots; // ícone fixo, sem dado
        toggle.setAttribute("aria-label", `Ações para ${name}`);
        toggle.setAttribute("aria-haspopup", "menu");
        toggle.setAttribute("aria-expanded", "false");
        toggle.dataset.memberMenu = "";
        const menuEl = el("div", "fx-menu");
        menuEl.setAttribute("role", "menu");
        menuEl.hidden = true;
        menuEl.append(...menu);
        more.append(toggle, menuEl);
        actions.append(more);
        item.append(actions);
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

    function closeMenus(except?: Element): void {
        list.querySelectorAll<HTMLElement>("[data-member-menu]").forEach((toggle) => {
            if (toggle === except) return;
            toggle.setAttribute("aria-expanded", "false");
            const menu = toggle.nextElementSibling as HTMLElement | null;
            // O foco num item que vai sumir volta ao ⋯.
            if (menu?.contains(document.activeElement)) toggle.focus();
            if (menu) menu.hidden = true;
        });
    }
    document.addEventListener("click", (event) => {
        if (!(event.target as Element).closest?.("[data-member-menu]")) closeMenus();
    });
    list.addEventListener("keydown", (event) => {
        const toggle = (event.target as Element).closest(".cm-menu")?.querySelector<HTMLElement>("[data-member-menu]");
        if (event.key === "Escape" && toggle?.getAttribute("aria-expanded") === "true") {
            closeMenus();
            toggle.focus();
        }
    });

    list.addEventListener("click", async (event) => {
        // O ⋯ abre e fecha o menu de ações da pessoa.
        const toggle = (event.target as Element).closest<HTMLButtonElement>("[data-member-menu]");
        if (toggle) {
            const menu = toggle.nextElementSibling as HTMLElement | null;
            const open = toggle.getAttribute("aria-expanded") !== "true";
            closeMenus(toggle);
            toggle.setAttribute("aria-expanded", String(open));
            if (menu) {
                menu.hidden = !open;
                if (open) menu.querySelector<HTMLElement>('[role="menuitem"]:not([hidden])')?.focus();
            }
            return;
        }
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-action]");
        if (button?.getAttribute("role") === "menuitem") closeMenus();
        const item = button?.closest<HTMLElement>("[data-user-id]");
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
