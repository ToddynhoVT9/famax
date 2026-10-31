/**
 * FAMAX — Configurações do perfil
 *
 * Antes esta tela era um protótipo: dados fixos, privacidade no localStorage
 * e — o pior — a troca de senha dizia "Alterado com sucesso!" sem chamar API
 * nenhuma. Agora tudo lê de GET /api/me e grava nas rotas de /api/me/*, e
 * nenhuma mensagem de sucesso aparece antes de a API confirmar.
 *
 * As rotas de edição devolvem o /me atualizado; render(me) redesenha a tela a
 * partir dele, então o que aparece é sempre o que o servidor gravou.
 */
import { api, getMe, logoutAll, setMeCache, type Me, type SocialLink } from "../shared/api.js";
import { requireLogin } from "../shared/auth-guard.js";
import { initLayout, updateHeaderUser } from "../shared/layout.js";
import { avatarColor, initials } from "../shared/dom.js";
import { MAX_SOCIAL_LINKS, SOCIAL_PLATFORM_LABELS } from "../shared/social.js";
import { initAccountSecurity } from "./account-security.js";
import { attachCharCounter } from "../shared/char-counter.js";
import { trapFocus } from "../shared/focus-trap.js";
import { bindWindowActions, lockPageScroll } from "../shared/window.js";
import { followKeyboard } from "../shared/keyboard.js";

requireLogin();
initLayout();

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

let me: Me | null = null;

// ===========================================================================
// Utilidades
// ===========================================================================

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

/** Mostra (ou esconde, com null) uma mensagem num elemento de status/erro. */
function show(el: HTMLElement | null, text: string | null, kind: "ok" | "error" = "error"): void {
    if (!el) return;
    el.textContent = text ?? "";
    el.hidden = text === null;
    el.classList.toggle("is-ok", kind === "ok");
}

function flash(el: HTMLElement | null, text: string): void {
    show(el, text, "ok");
    window.setTimeout(() => {
        if (el?.textContent === text) show(el, null);
    }, 3000);
}

/** Aplica o /me novo: tela, cache da página e header. */
function apply(next: Me): void {
    me = next;
    setMeCache(next);
    updateHeaderUser(next);
    render(next);
}

const securityCards = $("securityCards");
const security = securityCards ? initAccountSecurity(securityCards, { apply }) : null;

// ===========================================================================
// Render
// ===========================================================================

const avatarEl = $("settingsAvatar");
const bannerEl = $("settingsBanner");
const displayNameInput = $<HTMLInputElement>("displayNameInput");
const nicknameInput = $<HTMLInputElement>("nicknameInput");
const emailValue = $("emailValue");
const usernameValue = $("usernameValue");
const toggleAdult = $<HTMLButtonElement>("toggleAdult");
const togglePrivate = $<HTMLButtonElement>("togglePrivate");
const toggleNotifyComments = $<HTMLButtonElement>("toggleNotifyComments");
const toggleNotifyReplies = $<HTMLButtonElement>("toggleNotifyReplies");
const toggleNotifyLikes = $<HTMLButtonElement>("toggleNotifyLikes");
const toggleNotifyFollows = $<HTMLButtonElement>("toggleNotifyFollows");
const toggleNotifyEvents = $<HTMLButtonElement>("toggleNotifyEvents");
const socialCount = $("socialCount");

function setToggle(button: HTMLButtonElement | null, on: boolean): void {
    if (!button) return;
    // O desenho do Switch (fx-switch) lê o aria-checked.
    button.setAttribute("aria-checked", String(on));
    button.disabled = false;
}

function renderAvatar(user: Me, previewUrl?: string): void {
    if (!avatarEl) return;
    avatarEl.replaceChildren();
    avatarEl.className = "fx-avatar st-pic";

    const url = previewUrl ?? user.avatarUrl;
    if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        avatarEl.append(img);
    } else {
        // Sem foto: iniciais na mesma cor estável do header e do perfil.
        avatarEl.classList.add(avatarColor(user.userId));
        avatarEl.textContent = initials(user.displayName ?? user.username);
    }
    const remove = $("btnAvatarRemove");
    if (remove) remove.hidden = !user.avatarUrl;
}

function renderBanner(user: Me, previewUrl?: string): void {
    if (!bannerEl) return;
    const url = previewUrl ?? user.bannerUrl;
    // JSON.stringify gera uma string CSS válida, com aspas e barras escapadas.
    bannerEl.style.backgroundImage = url ? `url(${JSON.stringify(url)})` : "";
    bannerEl.classList.toggle("has-image", Boolean(url));
    const remove = $("btnBannerRemove");
    if (remove) remove.hidden = !user.bannerUrl;
}

function render(user: Me): void {
    renderAvatar(user);
    renderBanner(user);

    // Não sobrescreve o que a pessoa está digitando.
    if (displayNameInput && document.activeElement !== displayNameInput) {
        displayNameInput.value = user.displayName ?? "";
    }
    if (nicknameInput && document.activeElement !== nicknameInput) {
        nicknameInput.value = user.nickname ?? "";
    }

    if (emailValue) emailValue.textContent = user.email;
    if (usernameValue) usernameValue.textContent = `@${user.username}`;

    setToggle(toggleAdult, user.isAdult);
    setToggle(togglePrivate, user.isPrivate);
    setToggle(toggleNotifyComments, user.notifyComments);
    setToggle(toggleNotifyReplies, user.notifyReplies);
    setToggle(toggleNotifyLikes, user.notifyLikes);
    setToggle(toggleNotifyFollows, user.notifyFollows);
    setToggle(toggleNotifyEvents, user.notifyEvents);

    if (socialCount) {
        const n = user.socialLinks.length;
        socialCount.textContent = n === 0 ? "nenhuma" : n === 1 ? "1 link" : `${n} links`;
    }
    security?.render(user);
}

// ===========================================================================
// Nome de exibição e apelido
// ===========================================================================

const identityForm = $<HTMLFormElement>("identityForm");
const identityStatus = $("identityStatus");
const identitySave = $<HTMLButtonElement>("btnIdentitySave");

identityForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!displayNameInput || !nicknameInput || !identitySave) return;

    const displayName = displayNameInput.value.trim();
    if (!displayName) {
        show(identityStatus, "O nome de exibição não pode ficar vazio.");
        displayNameInput.focus();
        return;
    }

    identitySave.disabled = true;
    show(identityStatus, null);
    try {
        const { user } = await api.me.updateProfile({ displayName, nickname: nicknameInput.value });
        displayNameInput.blur();
        nicknameInput.blur();
        apply(user);
        flash(identityStatus, "Salvo.");
    } catch (err) {
        show(identityStatus, errorMessage(err, "Não foi possível salvar."));
    } finally {
        identitySave.disabled = false;
    }
});

// ===========================================================================
// Toggles: conteúdo adulto, perfil privado e preferências de notificação
// ===========================================================================

const settingsStatus = $("settingsStatus");

type ToggleKey =
    | "isAdult"
    | "isPrivate"
    | "notifyComments"
    | "notifyReplies"
    | "notifyLikes"
    | "notifyFollows"
    | "notifyEvents";

function bindToggle(button: HTMLButtonElement | null, key: ToggleKey): void {
    button?.addEventListener("click", async () => {
        if (!me) return;
        const next = !me[key];

        // Mostra a mudança na hora e volta atrás se a API recusar.
        setToggle(button, next);
        button.disabled = true;
        show(settingsStatus, null);
        try {
            const { user } = await api.me.updateSettings({ [key]: next });
            apply(user);
        } catch (err) {
            setToggle(button, me[key]);
            show(settingsStatus, errorMessage(err, "Não foi possível salvar."));
        }
    });
}

bindToggle(toggleAdult, "isAdult");
bindToggle(togglePrivate, "isPrivate");
bindToggle(toggleNotifyComments, "notifyComments");
bindToggle(toggleNotifyReplies, "notifyReplies");
bindToggle(toggleNotifyLikes, "notifyLikes");
bindToggle(toggleNotifyFollows, "notifyFollows");
bindToggle(toggleNotifyEvents, "notifyEvents");

// ===========================================================================
// Avatar e banner
// ===========================================================================

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const mediaStatus = $("mediaStatus");

function setupMedia(options: {
    field: "avatar" | "banner";
    label: string;
    doneLabel: string;
    maxBytes: number;
    changeBtn: string;
    removeBtn: string;
    input: string;
    preview: (user: Me, url?: string) => void;
}): void {
    const changeBtn = $<HTMLButtonElement>(options.changeBtn);
    const removeBtn = $<HTMLButtonElement>(options.removeBtn);
    const input = $<HTMLInputElement>(options.input);
    if (!changeBtn || !removeBtn || !input) return;

    changeBtn.addEventListener("click", () => input.click());

    input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.value = ""; // permite escolher o mesmo arquivo de novo
        if (!file || !me) return;

        // Validação no cliente só para responder rápido; o servidor confere
        // de novo, inclusive o tipo real pelos bytes.
        if (!ALLOWED_TYPES.includes(file.type)) {
            show(mediaStatus, `${options.label} deve ser PNG, JPEG ou WebP.`);
            return;
        }
        if (file.size > options.maxBytes) {
            const mb = Math.round(options.maxBytes / (1024 * 1024));
            show(mediaStatus, `${options.label} deve ter no máximo ${mb}MB.`);
            return;
        }

        // Prévia imediata enquanto envia; desfeita se a API recusar.
        const previewUrl = URL.createObjectURL(file);
        options.preview(me, previewUrl);
        changeBtn.disabled = true;
        removeBtn.disabled = true;
        show(mediaStatus, "Enviando...", "ok");

        const form = new FormData();
        form.append(options.field, file);
        try {
            const { user } = await api.me.uploadImage(options.field, form);
            apply(user);
            flash(mediaStatus, options.doneLabel);
        } catch (err) {
            options.preview(me);
            show(mediaStatus, errorMessage(err, "Não foi possível enviar a imagem."));
        } finally {
            URL.revokeObjectURL(previewUrl);
            changeBtn.disabled = false;
            removeBtn.disabled = false;
        }
    });

    removeBtn.addEventListener("click", async () => {
        changeBtn.disabled = true;
        removeBtn.disabled = true;
        show(mediaStatus, null);
        try {
            const { user } = await api.me.removeImage(options.field);
            apply(user);
        } catch (err) {
            show(mediaStatus, errorMessage(err, "Não foi possível remover a imagem."));
        } finally {
            changeBtn.disabled = false;
            removeBtn.disabled = false;
        }
    });
}

setupMedia({
    field: "avatar",
    label: "A foto de perfil",
    doneLabel: "Foto de perfil atualizada.",
    maxBytes: 1024 * 1024,
    changeBtn: "btnAvatarChange",
    removeBtn: "btnAvatarRemove",
    input: "avatarInput",
    preview: renderAvatar,
});

setupMedia({
    field: "banner",
    label: "O banner",
    doneLabel: "Banner atualizado.",
    maxBytes: 2 * 1024 * 1024,
    changeBtn: "btnBannerChange",
    removeBtn: "btnBannerRemove",
    input: "bannerInput",
    preview: renderBanner,
});

// ===========================================================================
// Janelas (comum): a janela de formulário da R (r-win), escrita no HTML
// ===========================================================================

/** Janela aberta -> função que desfaz tudo (foco, trava da página, ações, teclado). */
const openModals = new Map<HTMLElement, () => void>();

function openModal(overlay: HTMLElement | null, focus?: HTMLElement | null): void {
    if (!overlay || openModals.has(overlay)) return;
    overlay.hidden = false;
    const box = overlay.querySelector<HTMLElement>('[role="dialog"]') ?? overlay;
    // No celular, tela cheia com a ação principal no topo.
    const unbindActions = bindWindowActions(box);
    const unlock = lockPageScroll();
    const stopKeyboard = followKeyboard(box);
    const release = trapFocus(box, { onEscape: () => closeModal(overlay), initialFocus: focus });
    openModals.set(overlay, () => {
        unbindActions();
        unlock();
        stopKeyboard();
        release();
    });
}

function closeModal(overlay: HTMLElement | null): void {
    if (!overlay) return;
    overlay.hidden = true;
    openModals.get(overlay)?.();
    openModals.delete(overlay);
}

for (const overlay of document.querySelectorAll<HTMLElement>(".r-win-veil")) {
    // Clique fora da caixa e botões "Cancelar" fecham.
    overlay.addEventListener("click", (event) => {
        const target = event.target as Element;
        if (target === overlay || target.closest("[data-close-modal]")) closeModal(overlay);
    });
}

// Checkboxes "Mostrar senha": data-toggle-password lista os ids dos campos.
// (Antes era onclick inline chamando uma função pendurada em window.)
for (const checkbox of document.querySelectorAll<HTMLInputElement>("[data-toggle-password]")) {
    checkbox.addEventListener("change", () => {
        for (const id of (checkbox.dataset.togglePassword ?? "").split(" ")) {
            const input = $<HTMLInputElement>(id);
            if (input) input.type = checkbox.checked ? "text" : "password";
        }
    });
}

// ===========================================================================
// Modal de senha
// ===========================================================================

const senhaOverlay = $("senhaModalOverlay");
const step1 = $<HTMLFormElement>("modalStep1");
const step2 = $<HTMLFormElement>("modalStep2");
const step3 = $("modalStep3");
const step1Error = $("step1Error");
const step2Error = $("step2Error");
const currentPasswordInput = $<HTMLInputElement>("currentPasswordInput");
const newPasswordInput = $<HTMLInputElement>("newPasswordInput");
const confirmPasswordInput = $<HTMLInputElement>("confirmPasswordInput");
const passwordSaveBtn = $<HTMLButtonElement>("btnPasswordSave");

function showStep(step: 1 | 2 | 3): void {
    if (step1) step1.hidden = step !== 1;
    if (step2) step2.hidden = step !== 2;
    if (step3) step3.hidden = step !== 3;
}

/** Mesmas regras do backend (server/lib/password.ts). */
function passwordProblem(password: string): string | null {
    if (password.length < 8) return "A senha precisa ter no mínimo 8 caracteres.";
    if ((password.match(/\d/g) ?? []).length < 3) return "A senha precisa de pelo menos 3 números.";
    if (!/[^A-Za-z0-9]/.test(password)) return "A senha precisa de pelo menos 1 caractere especial.";
    return null;
}

$("btnChangePassword")?.addEventListener("click", () => {
    for (const input of [currentPasswordInput, newPasswordInput, confirmPasswordInput]) {
        if (input) {
            input.value = "";
            input.type = "password";
        }
    }
    document
        .querySelectorAll<HTMLInputElement>("#senhaModalOverlay [data-toggle-password]")
        .forEach((c) => (c.checked = false));
    show(step1Error, null);
    show(step2Error, null);
    showStep(1);
    openModal(senhaOverlay, currentPasswordInput);
});

step1?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!currentPasswordInput?.value) {
        show(step1Error, "Digite a senha atual.");
        return;
    }
    // A senha atual só é conferida no envio final: conferir aqui exigiria
    // uma rota que vira oráculo de senha.
    show(step1Error, null);
    showStep(2);
    window.setTimeout(() => newPasswordInput?.focus(), 50);
});

$("btnPasswordBack")?.addEventListener("click", () => {
    show(step2Error, null);
    showStep(1);
    currentPasswordInput?.focus();
});

step2?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentPasswordInput || !newPasswordInput || !confirmPasswordInput || !passwordSaveBtn) return;

    const newPassword = newPasswordInput.value;
    const problem = passwordProblem(newPassword);
    if (problem) {
        show(step2Error, problem);
        return;
    }
    if (newPassword !== confirmPasswordInput.value) {
        show(step2Error, "As senhas digitadas não coincidem.");
        return;
    }

    passwordSaveBtn.disabled = true;
    show(step2Error, null);
    try {
        await api.me.changePassword(currentPasswordInput.value, newPassword);
        // Só aqui, com a API confirmando, aparece o sucesso.
        showStep(3);
        window.setTimeout(() => closeModal(senhaOverlay), 2500);
    } catch (err) {
        const message = errorMessage(err, "Não foi possível alterar a senha.");
        if (message === "Senha atual incorreta") {
            // Volta para o passo onde está o campo errado.
            showStep(1);
            show(step1Error, message);
            currentPasswordInput.select();
        } else {
            show(step2Error, message);
        }
    } finally {
        passwordSaveBtn.disabled = false;
    }
});

// ===========================================================================
// Modal "Sobre": nascimento, gênero e bio
// ===========================================================================

const sobreOverlay = $("sobreModalOverlay");
const sobreForm = $<HTMLFormElement>("sobreForm");
const birthInput = $<HTMLInputElement>("sobreBirthDate");
const bioInput = $<HTMLTextAreaElement>("sobreBio");
const bioCounter = $("sobreBioCounter");
const sobreError = $("sobreError");
const sobreSave = $<HTMLButtonElement>("btnSobreSave");
const genderButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#generoOptionsContainer [role="radio"]'),
);

let selectedGender = "";

function selectGender(value: string): void {
    selectedGender = value;
    for (const button of genderButtons) {
        const on = button.dataset.gender === value;
        button.setAttribute("aria-checked", String(on));
    }
}

const updateBioCounter =
    bioInput instanceof HTMLTextAreaElement ? attachCharCounter(bioInput, { counter: bioCounter }) : () => {};

for (const button of genderButtons) {
    button.addEventListener("click", () => selectGender(button.dataset.gender ?? ""));
}

$("btnSobre")?.addEventListener("click", () => {
    if (!me || !birthInput || !bioInput) return;
    // Sempre a partir do que está gravado: cancelar descarta a edição.
    birthInput.value = me.birthDate ?? "";
    birthInput.max = new Date().toISOString().slice(0, 10);
    bioInput.value = me.bio ?? "";
    selectGender(me.gender ?? "");
    updateBioCounter();
    show(sobreError, null);
    openModal(sobreOverlay, birthInput);
});

sobreForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!birthInput || !bioInput || !sobreSave) return;

    sobreSave.disabled = true;
    show(sobreError, null);
    try {
        const { user } = await api.me.updateProfile({ birthDate: birthInput.value || null, gender: selectedGender || null, bio: bioInput.value });
        apply(user);
        closeModal(sobreOverlay);
        flash(settingsStatus, "Sobre atualizado.");
    } catch (err) {
        show(sobreError, errorMessage(err, "Não foi possível salvar."));
    } finally {
        sobreSave.disabled = false;
    }
});

// ===========================================================================
// Modal de redes sociais
// ===========================================================================

const socialOverlay = $("socialModalOverlay");
const socialForm = $<HTMLFormElement>("socialForm");
const socialRows = $("socialRows");
const socialAdd = $<HTMLButtonElement>("btnSocialAdd");
const socialError = $("socialError");
const socialSave = $<HTMLButtonElement>("btnSocialSave");

function socialRow(link: SocialLink = { platform: "site", url: "" }): HTMLElement {
    const row = document.createElement("div");
    row.className = "social-row";

    const select = document.createElement("select");
    select.className = "fx-input social-platform";
    select.setAttribute("aria-label", "Rede social");
    for (const [value, label] of Object.entries(SOCIAL_PLATFORM_LABELS)) {
        select.append(new Option(label, value, false, value === link.platform));
    }

    const url = document.createElement("input");
    url.type = "url";
    url.className = "fx-input social-url";
    url.placeholder = "https://";
    url.maxLength = 500;
    url.value = link.url;
    url.setAttribute("aria-label", "Endereço do link");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "fx-btn fx-btn--secondary social-remove";
    remove.textContent = "Remover";
    remove.addEventListener("click", () => {
        row.remove();
        updateSocialAdd();
    });

    row.append(select, url, remove);
    return row;
}

function updateSocialAdd(): void {
    if (socialAdd && socialRows) {
        socialAdd.disabled = socialRows.childElementCount >= MAX_SOCIAL_LINKS;
    }
}

$("btnSocial")?.addEventListener("click", () => {
    if (!me || !socialRows) return;
    socialRows.replaceChildren(...me.socialLinks.map((link) => socialRow(link)));
    if (me.socialLinks.length === 0) socialRows.append(socialRow());
    updateSocialAdd();
    show(socialError, null);
    openModal(socialOverlay, socialRows.querySelector<HTMLElement>(".social-url"));
});

socialAdd?.addEventListener("click", () => {
    if (!socialRows) return;
    const row = socialRow();
    socialRows.append(row);
    updateSocialAdd();
    row.querySelector<HTMLInputElement>(".social-url")?.focus();
});

socialForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!socialRows || !socialSave) return;

    // Linhas com o link vazio são ignoradas: é o jeito de "remover" uma linha
    // recém-adicionada sem clicar em Remover.
    const links = Array.from(socialRows.querySelectorAll<HTMLElement>(".social-row"))
        .map((row) => ({
            platform: row.querySelector<HTMLSelectElement>(".social-platform")?.value ?? "",
            url: row.querySelector<HTMLInputElement>(".social-url")?.value.trim() ?? "",
        }))
        .filter((link) => link.url !== "");

    const notHttps = links.find((link) => !link.url.startsWith("https://"));
    if (notHttps) {
        show(socialError, `O link "${notHttps.url}" deve começar com https://`);
        return;
    }

    socialSave.disabled = true;
    show(socialError, null);
    try {
        const { user } = await api.me.setSocialLinks(links);
        apply(user);
        closeModal(socialOverlay);
        flash(settingsStatus, "Redes sociais atualizadas.");
    } catch (err) {
        show(socialError, errorMessage(err, "Não foi possível salvar."));
    } finally {
        socialSave.disabled = false;
    }
});

// ===========================================================================
// Sair de todos os dispositivos
// ===========================================================================

$("btnLogoutAll")?.addEventListener("click", () => {
    void logoutAll();
});

// ===========================================================================
// Início
// ===========================================================================

getMe()
    .then((user) => {
        me = user;
        render(user);
    })
    .catch((err) => {
        // 401 já redirecionou para o login; aqui sobra erro de rede/servidor.
        show(settingsStatus, errorMessage(err, "Não foi possível carregar seus dados."));
    })
    .finally(() => $("settingsContainer")?.removeAttribute("aria-busy"));
