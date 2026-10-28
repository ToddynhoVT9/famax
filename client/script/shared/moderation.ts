/**
 * FAMAX — Denúncia e moderação (Shared)
 *
 * Os diálogos de denunciar e de banir, o selo de papel ("Dono",
 * "Moderador") e a regra de quem pode moderar quem. Usados pelo feed, pela
 * página do post, pelo perfil, pela lista de membros e pela fila de moderação.
 *
 * A hierarquia aqui só decide o que MOSTRAR; quem decide de verdade é o
 * backend (server/middleware/community-role.ts), com a mesma regra.
 */
import { api } from "./api.js";
import { escapeHtml } from "./dom.js";
import { toast } from "./dialog.js";
import { trapFocus } from "./focus-trap.js";
import type { CommunityRole } from "../../../shared/api-types.js";
export type { CommunityRole };

const RANK: Record<CommunityRole, number> = { owner: 3, moderator: 2, member: 1 };

/** Quem vê pode moderar o conteúdo/pessoa? Só quem está acima na hierarquia. */
export function canModerate(viewer: CommunityRole | null | undefined, target: CommunityRole | null | undefined): boolean {
    if (!viewer || viewer === "member") return false;
    return RANK[viewer] > RANK[target ?? "member"];
}

export function isStaff(role: CommunityRole | null | undefined): boolean {
    return role === "owner" || role === "moderator";
}

export const ROLE_LABEL: Record<CommunityRole, string> = {
    owner: "Dono",
    moderator: "Moderador",
    member: "Membro",
};

/** Selo ao lado do nome; membro comum não tem selo. HTML já escapado. */
export function roleBadgeHtml(role: CommunityRole | null | undefined): string {
    if (role !== "owner" && role !== "moderator") return "";
    return `<span class="fx-badge fx-badge--${role}" data-role-badge>${escapeHtml(ROLE_LABEL[role])}</span>`;
}

/** O mesmo selo, como elemento (para quem monta a lista por DOM). */
export function roleBadge(role: "owner" | "moderator"): HTMLElement {
    const badge = el("span", `fx-badge fx-badge--${role}`, ROLE_LABEL[role]);
    badge.dataset.roleBadge = "";
    return badge;
}

// ===========================================================================
// Diálogo base com formulário
// ===========================================================================

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** Campo do diálogo: rótulo visível em cima e o controle embaixo (Field). */
function field(label: string, control: HTMLElement): HTMLLabelElement {
    const wrap = el("label", "fx-field");
    wrap.append(el("span", "fx-label", label), control);
    return wrap;
}

interface FormDialogOptions {
    title: string;
    message?: string;
    submitLabel: string;
    danger?: boolean;
    /** Monta os campos; devolve uma função que lê/valida (string = erro). */
    build: (body: HTMLElement) => () => unknown | string;
    /** Envia; um erro lançado aparece dentro do diálogo. */
    submit: (value: unknown) => Promise<void>;
}

/** Resolve true se enviou, false se cancelou. Mesmo comportamento do confirmDialog. */
function formDialog(options: FormDialogOptions): Promise<boolean> {
    return new Promise((resolve) => {

        const overlay = el("div", "fx-overlay");
        const form = el("form", "fx-dialog");
        form.noValidate = true;
        form.setAttribute("role", "dialog");
        form.setAttribute("aria-modal", "true");

        const title = el("h2", "fx-dialog-title", options.title);
        title.id = `dialog-title-${Date.now()}`;
        form.setAttribute("aria-labelledby", title.id);
        form.append(title);
        if (options.message) form.append(el("p", "fx-dialog-text", options.message));

        const body = el("div", "dialog-body");
        const read = options.build(body);
        const error = el("p", "fx-error");
        error.setAttribute("role", "alert");
        error.hidden = true;

        const actions = el("div", "fx-dialog-actions");
        const cancel = el("button", "fx-btn fx-btn--secondary", "Cancelar");
        cancel.type = "button";
        const submit = el(
            "button",
            `fx-btn ${options.danger ? "fx-btn--danger" : "fx-btn--primary"}`,
            options.submitLabel,
        );
        submit.type = "submit";
        actions.append(cancel, submit);

        form.append(body, error, actions);
        overlay.append(form);
        document.body.append(overlay);

        let releaseFocus = (): void => {};
        const close = (result: boolean): void => {
            overlay.remove();
            releaseFocus();
            resolve(result);
        };

        cancel.addEventListener("click", () => close(false));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) close(false);
        });

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const value = read();
            if (typeof value === "string") {
                error.textContent = value;
                error.hidden = false;
                return;
            }
            submit.disabled = true;
            error.hidden = true;
            try {
                await options.submit(value);
                close(true);
            } catch (err) {
                error.textContent = err instanceof Error ? err.message : "Não foi possível enviar.";
                error.hidden = false;
                submit.disabled = false;
            }
        });

        releaseFocus = trapFocus(form, {
            onEscape: () => close(false),
            initialFocus: form.querySelector<HTMLElement>("input, textarea, select"),
        });
    });
}

// ===========================================================================
// Denunciar
// ===========================================================================

const REPORT_REASONS = [
    "Spam ou propaganda",
    "Assédio ou discurso de ódio",
    "Conteúdo impróprio ou ofensivo",
    "Informação falsa",
    "Fora do tema da comunidade",
    "Outro",
];

export type ReportTarget = "post" | "comment" | "user";

const REPORT_TITLE: Record<ReportTarget, string> = {
    post: "Denunciar discussão",
    comment: "Denunciar comentário",
    user: "Denunciar usuário",
};

/**
 * Motivo pré-definido + texto livre (obrigatório em "Outro"). Vai para a fila
 * de moderação da comunidade — ou do site, se for um usuário.
 */
export async function openReportDialog(targetType: ReportTarget, targetId: string): Promise<boolean> {
    const sent = await formDialog({
        title: REPORT_TITLE[targetType],
        message:
            targetType === "user"
                ? "A denúncia vai para a administração do FAMAX. Quem você denunciou não fica sabendo."
                : "A denúncia vai para os moderadores da comunidade. Quem você denunciou não fica sabendo.",
        submitLabel: "Enviar denúncia",
        build(body) {
            const group = el("fieldset", "dialog-options");
            group.append(el("legend", "fx-label", "Motivo"));
            REPORT_REASONS.forEach((reason, i) => {
                const label = el("label", "fx-check");
                const radio = el("input");
                radio.type = "radio";
                radio.name = "reportReason";
                radio.value = reason;
                if (i === 0) radio.checked = true;
                label.append(radio, reason);
                group.append(label);
            });

            const details = el("textarea", "fx-input");
            details.maxLength = 800;
            details.rows = 3;
            details.placeholder = "Conte o que aconteceu, se ajudar a moderação.";
            body.append(group, field("Detalhes (opcional)", details));

            return () => {
                const reason = group.querySelector<HTMLInputElement>("input:checked")?.value ?? "Outro";
                const text = details.value.trim();
                if (reason === "Outro" && text.length < 3) return "Descreva o motivo da denúncia.";
                return { reason: text ? `${reason} — ${text}` : reason };
            };
        },
        async submit(value) {
            const { reason } = value as { reason: string };
            await api.reports.create({ targetType, targetId, reason });
        },
    });
    if (sent) toast("Denúncia enviada. Obrigado por ajudar a manter a comunidade.");
    return sent;
}

// ===========================================================================
// Banir
// ===========================================================================

const BAN_DURATIONS: Array<{ label: string; days: number | null }> = [
    { label: "1 dia", days: 1 },
    { label: "7 dias", days: 7 },
    { label: "30 dias", days: 30 },
    { label: "Permanente", days: null },
];

export interface BanChoice {
    durationDays: number | null;
    reason: string | null;
}

/**
 * Escolhe prazo e motivo; o ban tira a pessoa dos membros na hora. Por padrão
 * envia para POST /bans; a fila de denúncias passa `send` para banir
 * resolvendo a denúncia no mesmo pedido.
 */
export async function openBanDialog(
    communityId: string,
    userId: string,
    name: string,
    send?: (choice: BanChoice) => Promise<void>,
): Promise<boolean> {
    const sent = await formDialog({
        title: `Banir ${name}?`,
        message: "A pessoa sai da comunidade e não consegue entrar, postar nem comentar enquanto o banimento valer. O que ela já publicou continua lá.",
        submitLabel: "Banir",
        danger: true,
        build(body) {
            const duration = el("select", "fx-input");
            BAN_DURATIONS.forEach((option, i) => {
                duration.append(new Option(option.label, String(i)));
            });
            duration.value = "1"; // 7 dias

            const reason = el("input", "fx-input");
            reason.type = "text";
            reason.maxLength = 500;
            body.append(field("Duração", duration), field("Motivo (opcional)", reason));

            return () => ({
                durationDays: BAN_DURATIONS[Number(duration.value)]?.days ?? null,
                reason: reason.value.trim() || null,
            });
        },
        async submit(value) {
            if (send) return send(value as BanChoice);
            await api.communities.ban(communityId, userId, value as BanChoice);
        },
    });
    if (sent) toast(`${name} foi banido da comunidade.`);
    return sent;
}

/** "até 12/05/2026" ou "permanente". */
export function banUntil(expiresAt: string | null): string {
    if (!expiresAt) return "permanente";
    return `até ${new Date(expiresAt).toLocaleDateString("pt-BR")}`;
}
