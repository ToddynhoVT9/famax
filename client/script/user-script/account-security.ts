/**
 * FAMAX — Configurações: "Conta e segurança"
 *
 * Os cartões da seção de segurança das configurações, montados aqui para não
 * inchar profile-settings.ts: e-mail (verificação e troca), verificação em
 * duas etapas, sessões ativas, usuários bloqueados e seus dados (exportar e
 * excluir a conta).
 *
 * Cada cartão recebe o /me atual em render(me) e, quando uma ação devolve o
 * /me novo, chama ctx.apply(user) — o mesmo caminho do resto da tela.
 *
 * Tudo por createElement/textContent: e-mails, nomes e user agents são texto
 * de usuário (ou controlado por ele).
 */
import { ApiError, api, clearToken, getToken, type Me } from "../shared/api.js";
import { pages, profileUrl } from "../shared/pages.js";
import { confirmDialog, toast } from "../shared/dialog.js";
import { timeAgo } from "../shared/dom.js";

export interface SecurityContext {
    apply(user: Me): void;
}

interface Card {
    element: HTMLElement;
    render(me: Me): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

function card(title: string, description?: string): { element: HTMLElement; body: HTMLElement } {
    const element = el("section", "security-card");
    const heading = el("h3", "security-card-title", title);
    element.append(heading);
    if (description) element.append(el("p", "security-card-text", description));
    const body = el("div", "security-card-body");
    element.append(body);
    return { element, body };
}

function status(): HTMLParagraphElement {
    const p = el("p", "settings-status");
    p.setAttribute("role", "status");
    p.hidden = true;
    return p;
}

export function setStatus(target: HTMLElement, text: string | null, kind: "ok" | "error" = "error"): void {
    target.textContent = text ?? "";
    target.hidden = text === null;
    target.classList.toggle("is-ok", kind === "ok");
}

export function passwordInput(label: string, autocomplete: AutoFill = "current-password"): [HTMLLabelElement, HTMLInputElement] {
    const wrapper = el("label", "settings-field");
    const input = el("input", "settings-input");
    input.type = "password";
    input.autocomplete = autocomplete;
    wrapper.append(el("span", "", label), input);
    return [wrapper, input];
}

// ===========================================================================
// E-mail: verificação e troca
// ===========================================================================

function emailCard(ctx: SecurityContext): Card {
    const { element, body } = card("E-mail");

    const current = el("p", "security-line");
    const pending = el("p", "security-line security-line--warn");
    const actions = el("div", "security-actions");
    const resend = el("button", "btn-modal", "Reenviar link de confirmação");
    resend.type = "button";
    const cancelPending = el("button", "btn-modal", "Cancelar troca");
    cancelPending.type = "button";
    actions.append(resend, cancelPending);

    const form = el("form", "settings-form security-form");
    form.noValidate = true;
    const newLabel = el("label", "settings-field");
    const newInput = el("input", "settings-input");
    newInput.type = "email";
    newInput.autocomplete = "email";
    newInput.maxLength = 255;
    newLabel.append(el("span", "", "Novo e-mail"), newInput);
    const [passwordLabel, password] = passwordInput("Sua senha");
    const submit = el("button", "btn-modal btn-modal--primary", "Trocar e-mail");
    submit.type = "submit";
    const formActions = el("div", "settings-form-actions");
    formActions.append(submit);
    form.append(newLabel, passwordLabel, formActions);

    const message = status();
    body.append(current, pending, actions, form, message);

    resend.addEventListener("click", async () => {
        resend.disabled = true;
        try {
            const result = await api<{ message: string }>("/auth/resend-verification", { method: "POST" });
            setStatus(message, result.message, "ok");
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível reenviar."));
        } finally {
            resend.disabled = false;
        }
    });

    cancelPending.addEventListener("click", async () => {
        try {
            const { user } = await api<{ user: Me }>("/me/email/pending", { method: "DELETE" });
            ctx.apply(user);
            setStatus(message, "Troca de e-mail cancelada.", "ok");
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível cancelar."));
        }
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const newEmail = newInput.value.trim();
        if (!newEmail || !password.value) {
            setStatus(message, "Informe o novo e-mail e sua senha.");
            return;
        }
        submit.disabled = true;
        try {
            const { user } = await api<{ user: Me }>("/me/email", {
                method: "PATCH",
                body: JSON.stringify({ newEmail, password: password.value }),
            });
            ctx.apply(user);
            newInput.value = "";
            password.value = "";
            setStatus(message, `Enviamos um link para ${user.pendingEmail}. A troca vale depois que você confirmar.`, "ok");
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível pedir a troca."));
        } finally {
            submit.disabled = false;
        }
    });

    return {
        element,
        render(me) {
            current.replaceChildren(
                el("strong", "", me.email),
                el(
                    "span",
                    me.emailVerified ? "security-badge security-badge--ok" : "security-badge security-badge--warn",
                    me.emailVerified ? "confirmado" : "não confirmado",
                ),
            );
            pending.hidden = !me.pendingEmail;
            pending.textContent = me.pendingEmail
                ? `Troca pendente para ${me.pendingEmail}: confirme pelo link enviado a esse endereço.`
                : "";
            resend.hidden = me.emailVerified && !me.pendingEmail;
            cancelPending.hidden = !me.pendingEmail;
            actions.hidden = resend.hidden && cancelPending.hidden;
        },
    };
}

// ===========================================================================
// Verificação em duas etapas
// ===========================================================================

/** Lista dos códigos de recuperação, com copiar e baixar (.txt). */
function recoveryCodesBox(codes: string[]): HTMLElement {
    const box = el("div", "recovery-box");
    box.append(
        el(
            "p",
            "security-card-text",
            "Guarde estes códigos num lugar seguro. Cada um entra uma vez, se você perder o celular. Eles não aparecem de novo.",
        ),
    );
    const list = el("ol", "recovery-codes");
    for (const code of codes) list.append(el("li", "", code));
    const actions = el("div", "security-actions");
    const copy = el("button", "btn-modal", "Copiar");
    copy.type = "button";
    copy.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(codes.join("\n"));
            toast("Códigos copiados.");
        } catch {
            toast("Não foi possível copiar. Selecione e copie à mão.", "error");
        }
    });
    const download = el("a", "btn-modal", "Baixar .txt");
    download.href = URL.createObjectURL(
        new Blob([`Códigos de recuperação do FAMAX\n\n${codes.join("\n")}\n`], { type: "text/plain" }),
    );
    download.download = "famax-codigos-de-recuperacao.txt";
    actions.append(copy, download);
    box.append(list, actions);
    return box;
}

function twoFactorCard(ctx: SecurityContext): Card {
    const { element, body } = card(
        "Verificação em duas etapas",
        "Além da senha, o login pede um código do seu app autenticador (Google Authenticator, Authy, 1Password...).",
    );
    const state = el("p", "security-line");
    const area = el("div", "security-card-body");
    const message = status();
    body.append(state, area, message);
    let current: Me | null = null;

    const refreshMe = async (): Promise<void> => {
        const { user } = await api<{ user: Me }>("/me");
        ctx.apply(user);
    };

    /** Passo 1: QR + campo do código. */
    async function startSetup(): Promise<void> {
        setStatus(message, null);
        try {
            const setup = await api<{ secret: string; qrCode: string }>("/me/2fa/setup", { method: "POST" });
            const qr = el("img", "twofa-qr");
            qr.src = setup.qrCode;
            qr.alt = "QR code para o app autenticador";
            const manual = el("p", "security-card-text");
            manual.append("Não consegue escanear? Digite no app: ", el("code", "twofa-secret", setup.secret));
            const form = el("form", "settings-form security-form");
            form.noValidate = true;
            const label = el("label", "settings-field");
            const code = el("input", "settings-input");
            code.inputMode = "numeric";
            code.autocomplete = "one-time-code";
            code.maxLength = 6;
            label.append(el("span", "", "Código de 6 dígitos do app"), code);
            const confirm = el("button", "btn-modal btn-modal--primary", "Ativar");
            confirm.type = "submit";
            const cancel = el("button", "btn-modal", "Cancelar");
            cancel.type = "button";
            const actions = el("div", "security-actions");
            actions.append(confirm, cancel);
            form.append(label, actions);
            area.replaceChildren(
                el("p", "security-card-text", "1. Escaneie o QR com o app. 2. Digite o código que ele mostrar."),
                qr,
                manual,
                form,
            );
            code.focus();

            cancel.addEventListener("click", () => current && render(current));
            form.addEventListener("submit", async (event) => {
                event.preventDefault();
                confirm.disabled = true;
                try {
                    const { recoveryCodes } = await api<{ recoveryCodes: string[] }>("/me/2fa/enable", {
                        method: "POST",
                        body: JSON.stringify({ code: code.value.trim() }),
                    });
                    const done = el("button", "btn-modal btn-modal--primary", "Guardei os códigos");
                    done.type = "button";
                    done.addEventListener("click", () => void refreshMe());
                    area.replaceChildren(recoveryCodesBox(recoveryCodes), done);
                    state.replaceChildren(el("span", "security-badge security-badge--ok", "ativa"));
                    setStatus(message, "Verificação em duas etapas ativada.", "ok");
                } catch (err) {
                    setStatus(message, errorMessage(err, "Não foi possível ativar."));
                    confirm.disabled = false;
                }
            });
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível começar a ativação."));
        }
    }

    /** Senha + código, para desativar ou gerar códigos novos. */
    function confirmForm(action: "disable" | "codes"): void {
        const form = el("form", "settings-form security-form");
        form.noValidate = true;
        const [passwordLabel, password] = passwordInput("Sua senha");
        const label = el("label", "settings-field");
        const code = el("input", "settings-input");
        code.autocomplete = "one-time-code";
        code.maxLength = 20;
        label.append(el("span", "", "Código do app ou de recuperação"), code);
        const submit = el(
            "button",
            action === "disable" ? "btn-modal btn-modal--danger" : "btn-modal btn-modal--primary",
            action === "disable" ? "Desativar" : "Gerar códigos novos",
        );
        submit.type = "submit";
        const cancel = el("button", "btn-modal", "Cancelar");
        cancel.type = "button";
        const actions = el("div", "security-actions");
        actions.append(submit, cancel);
        form.append(passwordLabel, label, actions);
        area.replaceChildren(form);
        password.focus();

        cancel.addEventListener("click", () => current && render(current));
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            submit.disabled = true;
            try {
                const result = await api<{ recoveryCodes?: string[] }>(
                    action === "disable" ? "/me/2fa/disable" : "/me/2fa/recovery-codes",
                    { method: "POST", body: JSON.stringify({ password: password.value, code: code.value.trim() }) },
                );
                if (action === "disable") {
                    setStatus(message, "Verificação em duas etapas desativada.", "ok");
                    await refreshMe();
                } else {
                    const done = el("button", "btn-modal btn-modal--primary", "Guardei os códigos");
                    done.type = "button";
                    done.addEventListener("click", () => void refreshMe());
                    area.replaceChildren(recoveryCodesBox(result.recoveryCodes ?? []), done);
                    setStatus(message, "Códigos novos gerados. Os antigos não valem mais.", "ok");
                }
            } catch (err) {
                setStatus(message, errorMessage(err, "Não foi possível confirmar."));
                submit.disabled = false;
            }
        });
    }

    function render(me: Me): void {
        current = me;
        if (me.twoFactorEnabled) {
            state.replaceChildren(
                el("span", "security-badge security-badge--ok", "ativa"),
                el(
                    "span",
                    me.recoveryCodesLeft <= 2 ? "security-line--warn" : "security-card-text",
                    `${me.recoveryCodesLeft} ${me.recoveryCodesLeft === 1 ? "código de recuperação restante" : "códigos de recuperação restantes"}`,
                ),
            );
            const codes = el("button", "btn-modal", "Gerar códigos novos");
            codes.type = "button";
            codes.addEventListener("click", () => confirmForm("codes"));
            const disable = el("button", "btn-modal btn-modal--danger", "Desativar");
            disable.type = "button";
            disable.addEventListener("click", () => confirmForm("disable"));
            const actions = el("div", "security-actions");
            actions.append(codes, disable);
            area.replaceChildren(actions);
        } else {
            state.replaceChildren(el("span", "security-badge security-badge--warn", "desativada"));
            const enable = el("button", "btn-modal btn-modal--primary", "Ativar");
            enable.type = "button";
            enable.addEventListener("click", () => void startSetup());
            area.replaceChildren(enable);
        }
    }

    return { element, render };
}

// ===========================================================================
// Sessões ativas
// ===========================================================================

interface SessionInfo {
    sessionId: string;
    device: string;
    ip: string | null;
    lastSeenAt: string;
    current: boolean;
}

function sessionsCard(): Card {
    const { element, body } = card(
        "Sessões ativas",
        "Onde sua conta está conectada. Encerre o que você não reconhecer.",
    );
    const list = el("ul", "security-list");
    const revokeOthers = el("button", "btn-modal", "Sair de todos os outros");
    revokeOthers.type = "button";
    const message = status();
    body.append(list, revokeOthers, message);
    let loaded = false;

    async function load(): Promise<void> {
        try {
            const { data } = await api<{ data: SessionInfo[] }>("/me/sessions");
            list.replaceChildren(
                ...data.map((session) => {
                    const item = el("li", "security-list-item");
                    const info = el("div", "security-list-info");
                    const name = el("strong", "", session.device);
                    if (session.current) name.append(" ", el("span", "security-badge security-badge--ok", "este dispositivo"));
                    const meta = [session.ip, `ativo ${timeAgo(session.lastSeenAt)}`].filter(Boolean).join(" · ");
                    info.append(name, el("span", "security-list-meta", meta));
                    item.append(info);
                    if (!session.current) {
                        const end = el("button", "btn-modal", "Encerrar");
                        end.type = "button";
                        end.addEventListener("click", async () => {
                            end.disabled = true;
                            try {
                                await api(`/me/sessions/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" });
                                item.remove();
                                revokeOthers.hidden = list.childElementCount <= 1;
                            } catch (err) {
                                setStatus(message, errorMessage(err, "Não foi possível encerrar."));
                                end.disabled = false;
                            }
                        });
                        item.append(end);
                    }
                    return item;
                }),
            );
            revokeOthers.hidden = data.length <= 1;
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível carregar as sessões."));
        }
    }

    revokeOthers.addEventListener("click", async () => {
        const ok = await confirmDialog({
            title: "Sair de todos os outros dispositivos?",
            message: "Todas as sessões, menos esta, são encerradas. Quem estiver nelas precisa entrar de novo.",
            confirmLabel: "Sair dos outros",
            danger: true,
        });
        if (!ok) return;
        try {
            await api("/me/sessions/revoke-others", { method: "POST" });
            setStatus(message, "Os outros dispositivos foram desconectados.", "ok");
            await load();
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível encerrar."));
        }
    });

    return {
        element,
        render() {
            if (loaded) return;
            loaded = true;
            void load();
        },
    };
}

// ===========================================================================
// Usuários bloqueados
// ===========================================================================

interface BlockedUser {
    user_id: string;
    username: string;
    display_name: string | null;
}

function blocksCard(): Card {
    const { element, body } = card(
        "Usuários bloqueados",
        "Quem você bloqueou não troca mensagens com você nem te segue, e o conteúdo dessa pessoa aparece recolhido.",
    );
    const list = el("ul", "security-list");
    const message = status();
    body.append(list, message);
    let loaded = false;

    async function load(): Promise<void> {
        try {
            const { data } = await api<{ data: BlockedUser[] }>("/me/blocks");
            if (data.length === 0) {
                list.replaceChildren(el("li", "security-card-text", "Você não bloqueou ninguém."));
                return;
            }
            list.replaceChildren(
                ...data.map((user) => {
                    const item = el("li", "security-list-item");
                    const info = el("div", "security-list-info");
                    const link = el("a", "", user.display_name?.trim() || user.username);
                    link.href = profileUrl(user.user_id);
                    info.append(link, el("span", "security-list-meta", `@${user.username}`));
                    const unblock = el("button", "btn-modal", "Desbloquear");
                    unblock.type = "button";
                    unblock.addEventListener("click", async () => {
                        unblock.disabled = true;
                        try {
                            await api(`/users/${encodeURIComponent(user.user_id)}/block`, { method: "DELETE" });
                            item.remove();
                            if (list.childElementCount === 0) void load();
                        } catch (err) {
                            setStatus(message, errorMessage(err, "Não foi possível desbloquear."));
                            unblock.disabled = false;
                        }
                    });
                    item.append(info, unblock);
                    return item;
                }),
            );
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível carregar a lista."));
        }
    }

    return {
        element,
        render() {
            if (loaded) return;
            loaded = true;
            void load();
        },
    };
}

// ===========================================================================
// Seus dados: exportar e excluir a conta
// ===========================================================================

function dataCard(): Card {
    const { element, body } = card(
        "Seus dados",
        "Baixe uma cópia de tudo o que é seu no FAMAX, ou exclua a conta.",
    );
    const exportBtn = el("button", "btn-modal", "Exportar meus dados (.json)");
    exportBtn.type = "button";
    const deleteBtn = el("button", "btn-modal btn-modal--danger", "Excluir minha conta");
    deleteBtn.type = "button";
    const actions = el("div", "security-actions");
    actions.append(exportBtn, deleteBtn);
    const area = el("div", "security-card-body");
    const message = status();
    body.append(actions, area, message);
    let current: Me | null = null;

    // O download precisa do token no header, então não dá para ser um <a>
    // direto: busca o arquivo e entrega como blob.
    exportBtn.addEventListener("click", async () => {
        exportBtn.disabled = true;
        setStatus(message, null);
        try {
            const response = await fetch("/api/me/export", {
                method: "POST",
                headers: { Authorization: `Bearer ${getToken() ?? ""}` },
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error ?? "Não foi possível exportar.");
            }
            const disposition = response.headers.get("content-disposition") ?? "";
            const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "famax-dados.json";
            const url = URL.createObjectURL(await response.blob());
            const link = el("a");
            link.href = url;
            link.download = filename;
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
            setStatus(message, "Download iniciado.", "ok");
        } catch (err) {
            setStatus(message, errorMessage(err, "Não foi possível exportar."));
        } finally {
            exportBtn.disabled = false;
        }
    });

    deleteBtn.addEventListener("click", () => {
        const form = el("form", "settings-form security-form security-danger-zone");
        form.noValidate = true;
        form.append(
            el(
                "p",
                "security-card-text",
                "Seu perfil some na hora e você sai de todos os dispositivos. Por 30 dias dá para voltar atrás entrando com a senha; depois a exclusão é definitiva. Posts, comentários e mensagens continuam, como “Usuário removido”.",
            ),
        );
        const [passwordLabel, password] = passwordInput("Sua senha");
        form.append(passwordLabel);
        let code: HTMLInputElement | null = null;
        if (current?.twoFactorEnabled) {
            const label = el("label", "settings-field");
            code = el("input", "settings-input");
            code.autocomplete = "one-time-code";
            code.maxLength = 20;
            label.append(el("span", "", "Código do app ou de recuperação"), code);
            form.append(label);
        }
        const submit = el("button", "btn-modal btn-modal--danger", "Excluir conta");
        submit.type = "submit";
        const cancel = el("button", "btn-modal", "Cancelar");
        cancel.type = "button";
        const formActions = el("div", "security-actions");
        formActions.append(submit, cancel);
        form.append(formActions);
        area.replaceChildren(form);
        actions.hidden = true;
        password.focus();

        cancel.addEventListener("click", () => {
            area.replaceChildren();
            actions.hidden = false;
        });
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const ok = await confirmDialog({
                title: "Excluir sua conta?",
                message: "Você tem 30 dias para reativar. Depois disso, não há volta.",
                confirmLabel: "Excluir",
                danger: true,
            });
            if (!ok) return;
            submit.disabled = true;
            try {
                await api("/me", {
                    method: "DELETE",
                    body: JSON.stringify({ password: password.value, code: code?.value.trim() || undefined }),
                });
                clearToken();
                window.location.replace(`${pages.login}?deleted=1`);
            } catch (err) {
                const communities = err instanceof ApiError ? (err.body.communities as string[] | undefined) : undefined;
                setStatus(
                    message,
                    communities?.length
                        ? `${errorMessage(err, "")} Comunidades: ${communities.join(", ")}.`
                        : errorMessage(err, "Não foi possível excluir."),
                );
                submit.disabled = false;
            }
        });
    });

    return {
        element,
        render(me) {
            current = me;
        },
    };
}

// ===========================================================================
// Montagem
// ===========================================================================

export function initAccountSecurity(root: HTMLElement, ctx: SecurityContext): { render(me: Me): void } {
    const cards: Card[] = [emailCard(ctx), twoFactorCard(ctx), sessionsCard(), blocksCard(), dataCard()];
    root.replaceChildren(...cards.map((c) => c.element));
    return {
        render(me) {
            for (const c of cards) c.render(me);
        },
    };
}

/** Reaproveitado pelos cartões das outras partes. */
export { card, status, toast };
