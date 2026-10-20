/**
 * FAMAX — Eventos da comunidade
 *
 * A vista "Eventos" (?view=events) com Próximos / Anteriores, o "Vou" dos
 * membros e, para o dono e os moderadores, criar / editar / cancelar num
 * modal. Também o widget "Próximos eventos" da lateral das discussões.
 *
 * Tudo por createElement/textContent: título, descrição e local são texto
 * de usuário. O local só vira link quando é https (isSafeLink, a mesma
 * regra das redes sociais do perfil).
 */
import { api, getToken } from "./shared/api.js";
import { goToLogin } from "./shared/auth-guard.js";
import { communityUrl } from "./shared/pages.js";
import { confirmDialog, toast } from "./shared/dialog.js";
import { isSafeLink } from "./shared/social.js";
import type { CommunityRole } from "./shared/moderation.js";
import { trapFocus } from "./shared/focus-trap.js";
import { bindTabKeys } from "./shared/tabs.js";

export interface CommunityEvent {
    event_id: string;
    community_id: string;
    title: string;
    description: string | null;
    starts_at: string;
    ends_at: string | null;
    location: string | null;
    creator_id: string | null;
    creator_username: string | null;
    creator_display_name: string | null;
    attendees_count: number;
    attending: boolean;
    is_past: boolean;
}

type Scope = "upcoming" | "past";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

// ===========================================================================
// Datas
// ===========================================================================

const dayFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit" });
const monthFormat = new Intl.DateTimeFormat("pt-BR", { month: "short" });
const fullFormat = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

function sameDay(a: Date, b: Date): boolean {
    return a.toDateString() === b.toDateString();
}

/** "sábado, 25 de outubro, 19:00 – 21:00" (ou com a data do fim, se outro dia). */
export function eventWhen(event: Pick<CommunityEvent, "starts_at" | "ends_at">): string {
    const start = new Date(event.starts_at);
    if (!event.ends_at) return fullFormat.format(start);
    const end = new Date(event.ends_at);
    return `${fullFormat.format(start)} – ${sameDay(start, end) ? timeFormat.format(end) : fullFormat.format(end)}`;
}

/** Valor para <input type="datetime-local"> no fuso de quem usa. */
function toLocalInput(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateBadge(iso: string): HTMLElement {
    const date = new Date(iso);
    const badge = el("div", "tf-event-date");
    badge.setAttribute("aria-hidden", "true");
    badge.append(
        el("span", "tf-event-day", dayFormat.format(date)),
        el("span", "tf-event-month", monthFormat.format(date).replace(".", "")),
    );
    return badge;
}

function locationNode(location: string): HTMLElement {
    const wrapper = el("p", "tf-event-location");
    wrapper.append("📍 ");
    if (isSafeLink(location)) {
        const link = el("a", "", location);
        link.href = location;
        link.target = "_blank";
        link.rel = "noopener nofollow ugc";
        wrapper.append(link);
    } else {
        wrapper.append(location);
    }
    return wrapper;
}

// ===========================================================================
// Modal de criar / editar
// ===========================================================================

function openEventEditor(communityId: string, event?: CommunityEvent): Promise<CommunityEvent | null> {
    return new Promise((resolve) => {
        const overlay = el("div", "modal-overlay show");
        const form = el("form", "modal-box");
        form.noValidate = true;
        form.setAttribute("role", "dialog");
        form.setAttribute("aria-modal", "true");
        form.setAttribute("aria-labelledby", "eventEditorTitle");

        const header = el("div", "modal-header");
        const title = el("h2", "modal-title", event ? "Editar evento" : "Novo evento");
        title.id = "eventEditorTitle";
        const close = el("button", "modal-close", "×");
        close.type = "button";
        close.setAttribute("aria-label", "Fechar");
        header.append(title, close);

        const error = el("div", "modal-error");
        error.setAttribute("role", "alert");

        const field = <T extends HTMLInputElement | HTMLTextAreaElement>(
            label: string,
            input: T,
            id: string,
            spaced = true,
        ): [HTMLLabelElement, T] => {
            const labelEl = el("label", `modal-label${spaced ? " modal-label--spaced" : ""}`, label);
            input.id = id;
            labelEl.htmlFor = id;
            return [labelEl, input];
        };

        const titleInput = el("input", "modal-input");
        titleInput.maxLength = 150;
        titleInput.value = event?.title ?? "";
        titleInput.placeholder = "Ex.: Encontro mensal";
        const startInput = el("input", "modal-input");
        startInput.type = "datetime-local";
        startInput.value = toLocalInput(event?.starts_at ?? null);
        const endInput = el("input", "modal-input");
        endInput.type = "datetime-local";
        endInput.value = toLocalInput(event?.ends_at ?? null);
        const locationInput = el("input", "modal-input");
        locationInput.maxLength = 300;
        locationInput.value = event?.location ?? "";
        locationInput.placeholder = "Endereço ou link (https://...)";
        const descriptionInput = el("textarea", "modal-textarea");
        descriptionInput.maxLength = 5000;
        descriptionInput.value = event?.description ?? "";
        descriptionInput.placeholder = "O que vai acontecer, o que levar...";

        const row = el("div", "modal-row");
        const startCol = el("div");
        startCol.append(...field("Início", startInput, "eventEditorStart"));
        const endCol = el("div");
        endCol.append(...field("Fim (opcional)", endInput, "eventEditorEnd"));
        row.append(startCol, endCol);

        const actions = el("div", "modal-actions");
        const cancel = el("button", "modal-btn-secondary", "Cancelar");
        cancel.type = "button";
        const submit = el("button", "modal-btn-primary", event ? "Salvar alterações" : "Criar evento");
        submit.type = "submit";
        actions.append(cancel, submit);

        form.append(
            header,
            error,
            ...field("Título", titleInput, "eventEditorTitleInput", false),
            row,
            ...field("Local ou link", locationInput, "eventEditorLocation"),
            ...field("Descrição", descriptionInput, "eventEditorDescription"),
            actions,
        );
        overlay.append(form);
        document.body.append(overlay);

        const showError = (message: string | null): void => {
            error.textContent = message ?? "";
            error.classList.toggle("show", message !== null);
        };
        let releaseFocus = (): void => {};
        const finish = (result: CommunityEvent | null): void => {
            overlay.remove();
            releaseFocus();
            resolve(result);
        };
        close.addEventListener("click", () => finish(null));
        cancel.addEventListener("click", () => finish(null));
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) finish(null);
        });
        releaseFocus = trapFocus(form, { onEscape: () => finish(null), initialFocus: titleInput });

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const titleValue = titleInput.value.trim();
            if (titleValue.length < 3) return showError("O título deve ter no mínimo 3 caracteres.");
            if (!startInput.value) return showError("Informe quando o evento começa.");
            const startsAt = new Date(startInput.value);
            const endsAt = endInput.value ? new Date(endInput.value) : null;
            if (endsAt && endsAt < startsAt) return showError("O fim não pode ser antes do início.");

            const body = {
                title: titleValue,
                startsAt: startsAt.toISOString(),
                endsAt: endsAt ? endsAt.toISOString() : null,
                location: locationInput.value.trim() || null,
                description: descriptionInput.value.trim() || null,
            };
            submit.disabled = true;
            showError(null);
            try {
                const result = event
                    ? await api<{ event: CommunityEvent }>(`/events/${encodeURIComponent(event.event_id)}`, {
                          method: "PATCH",
                          body: JSON.stringify(body),
                      })
                    : await api<{ event: CommunityEvent }>(`/communities/${encodeURIComponent(communityId)}/events`, {
                          method: "POST",
                          body: JSON.stringify(body),
                      });
                finish(result.event);
            } catch (err) {
                showError(errorMessage(err, "Não foi possível salvar o evento."));
                submit.disabled = false;
            }
        });
    });
}

// ===========================================================================
// Vista "Eventos"
// ===========================================================================

export interface EventsViewOptions {
    communityId: string;
    viewerRole: () => CommunityRole | null;
    /** Chamado quando a lista muda (o widget da lateral se atualiza). */
    onChanged?: () => void;
}

export function createEventsView(root: HTMLElement, options: EventsViewOptions): { reload(): Promise<void> } {
    let scope: Scope = "upcoming";
    let page = 0;
    let seq = 0;

    const toolbar = el("div", "tf-events-toolbar");
    const tabs = el("div", "tf-lb-tabs tf-events-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Quais eventos");
    const tabButton = (label: string, value: Scope) => {
        const b = el("button", `tf-lb-tab${value === scope ? " active" : ""}`, label);
        b.type = "button";
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(value === scope));
        b.dataset.scope = value;
        return b;
    };
    tabs.append(tabButton("Próximos", "upcoming"), tabButton("Anteriores", "past"));
    const create = el("button", "tf-btn-join", "Novo evento");
    create.type = "button";
    create.hidden = true;
    toolbar.append(tabs, create);

    const list = el("div", "tf-events-list");
    list.setAttribute("aria-live", "polite");
    const status = el("p", "tf-feed-status");
    const more = el("button", "tf-load-more", "Carregar mais");
    more.type = "button";
    more.hidden = true;
    root.replaceChildren(toolbar, list, status, more);

    const isStaff = () => {
        const role = options.viewerRole();
        return role === "owner" || role === "moderator";
    };
    const isMember = () => options.viewerRole() !== null;

    function renderEvent(event: CommunityEvent): HTMLElement {
        const card = el("article", `tf-event${event.is_past ? " is-past" : ""}`);
        card.dataset.eventId = event.event_id;

        const body = el("div", "tf-event-body");
        body.append(el("h3", "tf-event-title", event.title), el("p", "tf-event-when", eventWhen(event)));
        if (event.location) body.append(locationNode(event.location));
        if (event.description) body.append(el("p", "tf-event-description", event.description));

        const footer = el("div", "tf-event-footer");
        const count = el(
            "span",
            "tf-event-count",
            `${event.attendees_count} ${event.attendees_count === 1 ? "pessoa vai" : "pessoas vão"}`,
        );
        footer.append(count);

        // "Vou": membros, em evento que ainda não terminou. Visitante vai ao login.
        if (!event.is_past && (isMember() || !getToken())) {
            const going = el("button", `tf-event-going${event.attending ? " is-going" : ""}`, event.attending ? "✓ Vou" : "Vou");
            going.type = "button";
            going.setAttribute("aria-pressed", String(event.attending));
            going.addEventListener("click", async () => {
                if (!getToken()) return goToLogin();
                going.disabled = true;
                try {
                    const result = await api<{ attending: boolean; attendeesCount: number }>(
                        `/events/${encodeURIComponent(event.event_id)}/attend`,
                        { method: event.attending ? "DELETE" : "POST" },
                    );
                    event.attending = result.attending;
                    event.attendees_count = result.attendeesCount;
                    card.replaceWith(renderEvent(event));
                } catch (err) {
                    toast(errorMessage(err, "Não foi possível marcar presença."), "error");
                    going.disabled = false;
                }
            });
            footer.append(going);
        }

        if (isStaff()) {
            const edit = el("button", "tf-comment-action", "Editar");
            edit.type = "button";
            edit.addEventListener("click", async () => {
                const saved = await openEventEditor(options.communityId, event);
                if (saved) {
                    card.replaceWith(renderEvent(saved));
                    options.onChanged?.();
                    toast("Evento atualizado.");
                }
            });
            const remove = el("button", "tf-comment-action tf-comment-action--danger", "Cancelar evento");
            remove.type = "button";
            remove.addEventListener("click", async () => {
                const ok = await confirmDialog({
                    title: "Cancelar evento?",
                    message: `"${event.title}" some da comunidade e o aviso enviado aos membros também.`,
                    confirmLabel: "Cancelar evento",
                    cancelLabel: "Voltar",
                    danger: true,
                });
                if (!ok) return;
                try {
                    await api(`/events/${encodeURIComponent(event.event_id)}`, { method: "DELETE" });
                    card.remove();
                    if (list.childElementCount === 0) setStatus(emptyMessage());
                    options.onChanged?.();
                    toast("Evento cancelado.");
                } catch (err) {
                    toast(errorMessage(err, "Não foi possível cancelar."), "error");
                }
            });
            footer.append(edit, remove);
        }

        body.append(footer);
        card.append(dateBadge(event.starts_at), body);
        return card;
    }

    function setStatus(text: string | null, isError = false): void {
        status.textContent = text ?? "";
        status.hidden = text === null;
        status.classList.toggle("error", isError);
    }

    const emptyMessage = () =>
        scope === "upcoming"
            ? isStaff()
                ? "Nenhum evento marcado. Que tal criar o primeiro?"
                : "Nenhum evento marcado por enquanto."
            : "Nenhum evento passado ainda.";

    async function load(reset: boolean): Promise<void> {
        const current = ++seq;
        if (reset) {
            page = 0;
            list.replaceChildren();
            setStatus("Carregando eventos...");
            more.hidden = true;
        }
        create.hidden = !isStaff();
        more.disabled = true;
        try {
            const result = await api<{ data: CommunityEvent[]; pagination: { totalPages: number } }>(
                `/communities/${encodeURIComponent(options.communityId)}/events?scope=${scope}&page=${page + 1}&limit=10`,
            );
            if (current !== seq) return;
            page += 1;
            list.append(...result.data.map(renderEvent));
            setStatus(list.childElementCount === 0 ? emptyMessage() : null);
            more.hidden = page >= result.pagination.totalPages;
        } catch (err) {
            if (current !== seq) return;
            setStatus(errorMessage(err, "Não foi possível carregar os eventos."), true);
        } finally {
            if (current === seq) more.disabled = false;
        }
    }

    tabs.addEventListener("click", (e) => {
        const button = (e.target as Element).closest<HTMLButtonElement>("[data-scope]");
        const next = button?.dataset.scope as Scope | undefined;
        if (!next || next === scope) return;
        scope = next;
        tabs.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((b) => {
            const active = b.dataset.scope === scope;
            b.classList.toggle("active", active);
            b.setAttribute("aria-selected", String(active));
        });
        void load(true);
    });
    bindTabKeys(tabs);
    more.addEventListener("click", () => void load(false));
    create.addEventListener("click", async () => {
        const saved = await openEventEditor(options.communityId);
        if (!saved) return;
        toast("Evento criado. Os membros foram avisados.");
        options.onChanged?.();
        if (scope === "upcoming") void load(true);
    });

    return { reload: () => load(true) };
}

// ===========================================================================
// Widget "Próximos eventos" (lateral das discussões)
// ===========================================================================

export async function loadUpcomingWidget(widget: HTMLElement, communityId: string): Promise<void> {
    const list = widget.querySelector<HTMLElement>(".tf-upcoming-list");
    const link = widget.querySelector<HTMLAnchorElement>(".tf-upcoming-all");
    if (!list) return;
    if (link) link.href = communityUrl(communityId, "events");
    try {
        const { data } = await api<{ data: CommunityEvent[] }>(
            `/communities/${encodeURIComponent(communityId)}/events?scope=upcoming&limit=3`,
        );
        if (data.length === 0) {
            list.replaceChildren(el("p", "tf-lb-status", "Nenhum evento marcado."));
            return;
        }
        list.replaceChildren(
            ...data.map((event) => {
                const item = el("a", "tf-upcoming-item");
                item.href = communityUrl(communityId, "events");
                const text = el("span", "tf-upcoming-text");
                text.append(
                    el("strong", "", event.title),
                    el("span", "tf-upcoming-when", eventWhen({ starts_at: event.starts_at, ends_at: null })),
                );
                item.append(dateBadge(event.starts_at), text);
                return item;
            }),
        );
    } catch {
        list.replaceChildren(el("p", "tf-lb-status error", "Não foi possível carregar os eventos."));
    }
}
