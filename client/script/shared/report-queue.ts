/**
 * FAMAX — Fila de denúncias (Shared)
 *
 * Usada pela moderação da comunidade (posts e comentários) e pela página de
 * admin (usuários). Filtro por status, lista paginada e as ações de
 * PATCH /api/reports/:id: em análise, descartar, remover conteúdo, banir
 * autor. Tudo entra por textContent.
 */
import { api } from "./api.js";
import { postUrl, profileUrl } from "./pages.js";
import { timeAgo, truncate } from "./dom.js";
import { confirmDialog, toast } from "./dialog.js";
import { canModerate, openBanDialog, ROLE_LABEL, type CommunityRole } from "./moderation.js";

export interface Report {
    report_id: string;
    target_type: "post" | "comment" | "user";
    target_id: string;
    reason: string;
    status: "pending" | "reviewing" | "resolved" | "dismissed";
    resolution: "none" | "remove_content" | "ban_author" | "dismiss" | null;
    created_at: string;
    resolved_at: string | null;
    community_id: string | null;
    reporter_username: string;
    resolved_by_username: string | null;
    post_id: string | null;
    post_title: string | null;
    content: string | null;
    target_deleted: boolean;
    author_id: string | null;
    author_username: string | null;
    author_display_name: string | null;
    author_role: CommunityRole | null;
}

type StatusFilter = "open" | "pending" | "reviewing" | "resolved" | "dismissed" | "all";

export interface ReportQueueOptions {
    /** Ex.: /communities/:id/reports ou /admin/reports. */
    endpoint: string;
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

const RESOLUTION_LABEL: Record<string, string> = {
    none: "sem ação",
    remove_content: "conteúdo removido",
    ban_author: "autor banido",
    dismiss: "descartada",
};

const TARGET_LABEL: Record<Report["target_type"], string> = {
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

    const filters = el("div", "tf-category-chips");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filtrar por status");
    for (const f of STATUS_FILTERS) {
        const chip = el("button", "tf-chip", f.label);
        chip.type = "button";
        chip.dataset.status = f.value;
        chip.setAttribute("aria-pressed", String(f.value === status));
        filters.append(chip);
    }
    const summary = el("p", "report-summary");
    summary.setAttribute("aria-live", "polite");
    const list = el("div", "report-list");
    const more = el("button", "tf-load-more", "Carregar mais");
    more.type = "button";
    more.hidden = true;
    root.replaceChildren(filters, summary, list, more);

    // ----- Render -----------------------------------------------------------

    function button(label: string, action: string, kind = ""): HTMLButtonElement {
        const b = el("button", `report-btn${kind ? ` report-btn--${kind}` : ""}`, label);
        b.type = "button";
        b.dataset.action = action;
        return b;
    }

    function renderTarget(report: Report): HTMLElement {
        const box = el("div", "report-target");
        const author = report.author_display_name?.trim() || report.author_username || "Usuário";

        if (report.target_type === "user") {
            const link = el("a", "report-target-title", `${author} (@${report.author_username ?? "?"})`);
            if (report.author_id) link.href = profileUrl(report.author_id);
            box.append(link);
            if (report.target_deleted) box.append(el("span", "report-removed", "Conta excluída"));
            return box;
        }

        if (report.post_title) {
            const title = el(
                "a",
                "report-target-title",
                report.target_type === "comment" ? `Em: ${report.post_title}` : report.post_title,
            );
            if (report.post_id) title.href = postUrl(report.post_id);
            box.append(title);
        }
        if (report.content) {
            box.append(el("p", "report-target-content", truncate(report.content.replace(/\s+/g, " "), 280)));
        }

        const by = el("p", "report-target-author");
        const authorLink = el("a", "", author);
        if (report.author_id) authorLink.href = profileUrl(report.author_id);
        by.append("por ", authorLink);
        if (report.author_role === "owner" || report.author_role === "moderator") {
            by.append(" ", el("span", `role-badge role-badge--${report.author_role}`, ROLE_LABEL[report.author_role]));
        }
        box.append(by);
        if (report.target_deleted) box.append(el("span", "report-removed", "Já removido"));
        return box;
    }

    function renderReport(report: Report): HTMLElement {
        const card = el("article", "report-card");
        card.dataset.reportId = report.report_id;

        const head = el("div", "report-head");
        head.append(
            el("span", "report-type", TARGET_LABEL[report.target_type]),
            el("span", `report-status report-status--${report.status}`, STATUS_LABEL[report.status]),
            el("span", "report-meta", `denunciado por @${report.reporter_username} · ${timeAgo(report.created_at)}`),
        );

        const reason = el("blockquote", "report-reason", report.reason);
        card.append(head, reason, renderTarget(report));

        const open = report.status === "pending" || report.status === "reviewing";
        if (open) {
            const actions = el("div", "report-actions");
            if (report.status === "pending") actions.append(button("Em análise", "review"));
            actions.append(button("Descartar", "dismiss"));
            if (report.target_type === "user") {
                actions.append(button("Resolver", "resolve", "primary"));
            } else {
                const canAct = canModerate(options.viewerRole, report.author_role);
                if (!report.target_deleted && canAct) actions.append(button("Remover conteúdo", "remove", "danger"));
                if (canAct && report.author_id) actions.append(button("Banir autor", "ban", "danger"));
                if (!canAct) {
                    // Conteúdo do dono ou de outro moderador: só quem está acima decide.
                    actions.append(el("span", "report-hint", "Moderadores não removem conteúdo do dono nem de outro moderador."));
                }
                if (report.target_deleted) actions.append(button("Marcar como resolvida", "resolve", "primary"));
            }
            card.append(actions);
        } else {
            const closed = [`${STATUS_LABEL[report.status]}`];
            if (report.resolution && report.status === "resolved") closed.push(RESOLUTION_LABEL[report.resolution] ?? report.resolution);
            if (report.resolved_by_username) closed.push(`por @${report.resolved_by_username}`);
            if (report.resolved_at) closed.push(timeAgo(report.resolved_at));
            card.append(el("p", "report-closed", closed.join(" · ")));
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
            const result = await api<{ data: Report[]; pagination: { total: number; totalPages: number } }>(
                `${options.endpoint}?${params}`,
            );
            if (current !== seq) return;
            page += 1;
            if (reset) list.replaceChildren();
            for (const report of result.data) {
                reports.set(report.report_id, report);
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
        await api(`/reports/${encodeURIComponent(reportId)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
        });
    }

    async function act(card: HTMLElement, action: string): Promise<void> {
        const report = reports.get(card.dataset.reportId ?? "");
        if (!report) return;
        const author = report.author_display_name?.trim() || report.author_username || "o autor";

        try {
            switch (action) {
                case "review":
                    await patch(report.report_id, { status: "reviewing" });
                    toast("Denúncia marcada como em análise.");
                    break;
                case "dismiss":
                    await patch(report.report_id, { status: "dismissed" });
                    toast("Denúncia descartada.");
                    break;
                case "resolve":
                    await patch(report.report_id, { status: "resolved" });
                    toast("Denúncia resolvida.");
                    break;
                case "remove": {
                    const ok = await confirmDialog({
                        title: "Remover conteúdo?",
                        message: `O ${TARGET_LABEL[report.target_type].toLowerCase()} some da comunidade e as outras denúncias abertas sobre ele também são encerradas.`,
                        confirmLabel: "Remover",
                        danger: true,
                    });
                    if (!ok) return;
                    await patch(report.report_id, { status: "resolved", action: "remove_content" });
                    toast("Conteúdo removido.");
                    break;
                }
                case "ban": {
                    if (!report.community_id || !report.author_id) return;
                    const banned = await openBanDialog(report.community_id, report.author_id, author, (choice) =>
                        patch(report.report_id, {
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
        const chip = (event.target as Element).closest<HTMLButtonElement>(".tf-chip");
        if (!chip) return;
        status = chip.dataset.status as StatusFilter;
        filters.querySelectorAll(".tf-chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
        void load(true);
    });

    list.addEventListener("click", (event) => {
        const b = (event.target as Element).closest<HTMLButtonElement>(".report-btn");
        const card = b?.closest<HTMLElement>(".report-card");
        if (!b || !card || b.disabled) return;
        b.disabled = true;
        void act(card, b.dataset.action ?? "").finally(() => {
            b.disabled = false;
        });
    });

    more.addEventListener("click", () => void load(false));

    return { reload: () => load(true) };
}
