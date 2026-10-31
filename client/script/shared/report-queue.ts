/**
 * FAMAX — Fila de denúncias (Shared)
 *
 * Usada pela moderação da comunidade (posts e comentários) e pela página de
 * admin (usuários). Filtro por status, lista paginada e as ações de
 * PATCH /api/reports/:id: em análise, descartar, remover conteúdo, banir
 * autor. Tudo entra por textContent.
 *
 * Desenho: ReportCard (fx-report, no moderation.css). As ações saem numa
 * ordem fixa — a principal, as neutras e, separadas à direita, as de perigo
 * —, sem mudar quais aparecem. O código acha o cartão por data-report-id.
 */
import { api } from "./api.js";
import { postUrl, profileUrl } from "./pages.js";
import { timeAgo, truncate } from "./dom.js";
import { confirmDialog, toast } from "./dialog.js";
import { canModerate, openBanDialog, roleBadge, type CommunityRole } from "./moderation.js";
import type { Report } from "../../../shared/api-types.js";
export type { Report };

type StatusFilter = "open" | "pending" | "reviewing" | "resolved" | "dismissed" | "all";

export interface ReportQueueOptions {
    /** De onde vem a fila: uma comunidade (moderação) ou o site inteiro (admin). */
    source: { communityId: string } | "admin";
    /** Papel de quem modera (admin age como dono). Decide o que mostrar. */
    viewerRole: CommunityRole;
    /** Ao banir alguém (a lista de banidos da página pode atualizar). */
    onBan?: () => void;
}

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
    { value: "open", label: "Abertas" },
    { value: "pending", label: "Pendentes" },
    { value: "reviewing", label: "Em análise" },
    { value: "resolved", label: "Resolvidas" },
    { value: "dismissed", label: "Descartadas" },
    { value: "all", label: "Todas" },
];

const STATUS_LABEL: Record<Report["status"], string> = {
    pending: "Pendente",
    reviewing: "Em análise",
    resolved: "Resolvida",
    dismissed: "Descartada",
};

/** Tom do selo de cada estado (Badge): descartada fica neutra. */
const STATUS_TONE: Record<Report["status"], string> = {
    pending: " fx-badge--warning",
    reviewing: " fx-badge--info",
    resolved: " fx-badge--success",
    dismissed: "",
};

const RESOLUTION_LABEL: Record<string, string> = {
    none: "sem ação",
    remove_content: "conteúdo removido",
    ban_author: "autor banido",
    dismiss: "descartada",
};

const TARGET_LABEL: Record<Report["targetType"], string> = {
    post: "Discussão",
    comment: "Comentário",
    user: "Usuário",
};

const PER_PAGE = 15;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function createReportQueue(root: HTMLElement, options: ReportQueueOptions) {
    let status: StatusFilter = "open";
    let page = 0;
    let seq = 0;
    const reports = new Map<string, Report>();

    // Filtros numa fileira que rola (no celular, sem quebrar em linhas).
    const filters = el("div", "r-hscroll r-hscroll-row");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filtrar por status");
    for (const f of STATUS_FILTERS) {
        const chip = el("button", "fx-chip", f.label);
        chip.type = "button";
        chip.dataset.status = f.value;
        chip.setAttribute("aria-pressed", String(f.value === status));
        filters.append(chip);
    }
    const summary = el("p", "mod-summary");
    summary.setAttribute("aria-live", "polite");
    const list = el("div", "fx-reports");
    const more = el("button", "fx-btn fx-btn--outline fx-btn--pill list-more", "Carregar mais");
    more.type = "button";
    more.hidden = true;
    root.replaceChildren(filters, summary, list, more);

    // ----- Render -----------------------------------------------------------

    function button(label: string, action: string, kind = ""): HTMLButtonElement {
        // A principal é escura; as de perigo, contornadas em vermelho (Button sm, no cartão branco).
        const variant = kind === "primary" ? "fx-btn--dark" : kind === "danger" ? "fx-btn--outline-danger" : "fx-btn--outline-ink";
        const b = el("button", `fx-btn fx-btn--sm fx-btn--pill ${variant}`, label);
        b.type = "button";
        b.dataset.action = action;
        return b;
    }

    function renderTarget(report: Report): HTMLElement {
        const box = el("div", "fx-report-target");
        const author = report.authorDisplayName?.trim() || report.authorUsername || "Usuário";

        if (report.targetType === "user") {
            const link = el("a", "fx-report-target-title", `${author} (@${report.authorUsername ?? "?"})`);
            if (report.authorId) link.href = profileUrl(report.authorId);
            box.append(link);
            if (report.targetDeleted) box.append(el("span", "fx-report-removed", "Conta excluída"));
            return box;
        }

        if (report.postTitle) {
            const title = el(
                "a",
                "fx-report-target-title",
                report.targetType === "comment" ? `Em: ${report.postTitle}` : report.postTitle,
            );
            if (report.postId) title.href = postUrl(report.postId);
            box.append(title);
        }
        if (report.content) {
            box.append(el("p", "fx-report-target-content", truncate(report.content.replace(/\s+/g, " "), 280)));
        }

        const by = el("p", "fx-report-target-author");
        const authorLink = el("a", "", author);
        if (report.authorId) authorLink.href = profileUrl(report.authorId);
        by.append("por ", authorLink);
        if (report.authorRole === "owner" || report.authorRole === "moderator") {
            by.append(" ", roleBadge(report.authorRole));
        }
        box.append(by);
        if (report.targetDeleted) box.append(el("span", "fx-report-removed", "Já removido"));
        return box;
    }

    function renderReport(report: Report): HTMLElement {
        const card = el("article", "fx-report");
        card.dataset.reportId = report.reportId;

        const head = el("div", "fx-report-head");
        head.append(
            el("span", "fx-report-type", TARGET_LABEL[report.targetType]),
            el("span", `fx-badge${STATUS_TONE[report.status]}`, STATUS_LABEL[report.status]),
            el("span", "fx-report-meta", `denunciado por @${report.reporterUsername} · ${timeAgo(report.createdAt)}`),
        );

        const reason = el("blockquote", "fx-report-reason", report.reason);
        card.append(head, reason, renderTarget(report));

        const open = report.status === "pending" || report.status === "reviewing";
        if (open) {
            // As mesmas ações de antes, agrupadas para sair na ordem fixa.
            const primary: HTMLElement[] = [];
            const neutral: HTMLElement[] = [];
            const danger: HTMLElement[] = [];
            let hint: HTMLElement | null = null;
            if (report.status === "pending") neutral.push(button("Em análise", "review"));
            neutral.push(button("Descartar", "dismiss"));
            if (report.targetType === "user") {
                primary.push(button("Resolver", "resolve", "primary"));
            } else {
                const canAct = canModerate(options.viewerRole, report.authorRole);
                if (!report.targetDeleted && canAct) danger.push(button("Remover conteúdo", "remove", "danger"));
                if (canAct && report.authorId) danger.push(button("Banir autor", "ban", "danger"));
                if (!canAct) {
                    // Conteúdo do dono ou de outro moderador: só quem está acima decide.
                    hint = el("span", "fx-report-hint", "Moderadores não removem conteúdo do dono nem de outro moderador.");
                }
                if (report.targetDeleted) primary.push(button("Marcar como resolvida", "resolve", "primary"));
            }
            danger[0]?.classList.add("fx-report-sep");
            const actions = el("div", "fx-report-actions");
            actions.dataset.reportActions = "";
            actions.append(...primary, ...neutral, ...danger);
            if (hint) actions.append(hint);
            card.append(actions);
        } else {
            const closed = [`${STATUS_LABEL[report.status]}`];
            if (report.resolution && report.status === "resolved") closed.push(RESOLUTION_LABEL[report.resolution] ?? report.resolution);
            if (report.resolvedByUsername) closed.push(`por @${report.resolvedByUsername}`);
            if (report.resolvedAt) closed.push(timeAgo(report.resolvedAt));
            card.append(el("p", "fx-report-closed", closed.join(" · ")));
        }
        return card;
    }

    // ----- Carregar -----------------------------------------------------------

    async function load(reset: boolean): Promise<void> {
        const current = ++seq;
        if (reset) {
            page = 0;
            reports.clear();
            list.replaceChildren(el("p", "tf-feed-status", "Carregando denúncias..."));
            more.hidden = true;
        }
        more.disabled = true;

        const params = new URLSearchParams({ status, page: String(page + 1), limit: String(PER_PAGE) });
        try {
            const result = await api.reports.queue(options.source, { status, page: page + 1, limit: PER_PAGE });
            if (current !== seq) return;
            page += 1;
            if (reset) list.replaceChildren();
            for (const report of result.data) {
                reports.set(report.reportId, report);
                list.append(renderReport(report));
            }
            const n = result.pagination.total;
            summary.textContent = `${n} ${n === 1 ? "denúncia" : "denúncias"}`;
            if (n === 0) {
                list.replaceChildren(
                    el("p", "tf-feed-status", status === "open" ? "Nenhuma denúncia aberta. 🎉" : "Nenhuma denúncia aqui."),
                );
            }
            more.hidden = page >= result.pagination.totalPages;
        } catch (err) {
            if (current !== seq) return;
            const message = err instanceof Error ? err.message : "Não foi possível carregar as denúncias.";
            if (reset) list.replaceChildren(el("p", "tf-feed-status error", message));
            else toast(message, "error");
        } finally {
            if (current === seq) more.disabled = false;
        }
    }

    // ----- Ações ------------------------------------------------------------

    async function patch(reportId: string, body: Record<string, unknown>): Promise<void> {
        await api.reports.update(reportId, body);
    }

    async function act(card: HTMLElement, action: string): Promise<void> {
        const report = reports.get(card.dataset.reportId ?? "");
        if (!report) return;
        const author = report.authorDisplayName?.trim() || report.authorUsername || "o autor";

        try {
            switch (action) {
                case "review":
                    await patch(report.reportId, { status: "reviewing" });
                    toast("Denúncia marcada como em análise.");
                    break;
                case "dismiss":
                    await patch(report.reportId, { status: "dismissed" });
                    toast("Denúncia descartada.");
                    break;
                case "resolve":
                    await patch(report.reportId, { status: "resolved" });
                    toast("Denúncia resolvida.");
                    break;
                case "remove": {
                    const ok = await confirmDialog({
                        title: "Remover conteúdo?",
                        message: `O ${TARGET_LABEL[report.targetType].toLowerCase()} some da comunidade e as outras denúncias abertas sobre ele também são encerradas.`,
                        confirmLabel: "Remover",
                        danger: true,
                    });
                    if (!ok) return;
                    await patch(report.reportId, { status: "resolved", action: "remove_content" });
                    toast("Conteúdo removido.");
                    break;
                }
                case "ban": {
                    if (!report.communityId || !report.authorId) return;
                    const banned = await openBanDialog(report.communityId, report.authorId, author, (choice) =>
                        patch(report.reportId, {
                            status: "resolved",
                            action: "ban_author",
                            banDays: choice.durationDays,
                            banReason: choice.reason,
                        }),
                    );
                    if (!banned) return;
                    options.onBan?.();
                    break;
                }
                default:
                    return;
            }
            // A ação pode ter fechado outras denúncias do mesmo alvo.
            await load(true);
        } catch (err) {
            toast(err instanceof Error ? err.message : "Não foi possível concluir.", "error");
        }
    }

    filters.addEventListener("click", (event) => {
        const chip = (event.target as Element).closest<HTMLButtonElement>(".fx-chip");
        if (!chip) return;
        status = chip.dataset.status as StatusFilter;
        filters.querySelectorAll(".fx-chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
        void load(true);
    });

    list.addEventListener("click", (event) => {
        const b = (event.target as Element).closest<HTMLButtonElement>("[data-report-actions] button[data-action]");
        const card = b?.closest<HTMLElement>("[data-report-id]");
        if (!b || !card || b.disabled) return;
        b.disabled = true;
        void act(card, b.dataset.action ?? "").finally(() => {
            b.disabled = false;
        });
    });

    more.addEventListener("click", () => void load(false));

    return { reload: () => load(true) };
}
