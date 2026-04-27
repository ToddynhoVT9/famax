/**
 * FAMAX — Profile Settings (Editar Perfil) Script
 */
import { initSidebar } from "../shared/sidebar.js";
import { initHeaderDropdowns } from "../shared/header-dropdowns.js";
import { initToggleSwitches } from "../shared/toggle-switch.js";

initSidebar();
initHeaderDropdowns();

// Toggle switches com callback para privar perfil
initToggleSwitches((element, isOn) => {
    if (element.id === "togglePrivate") {
        localStorage.setItem("isPrivateProfile", String(isOn));
        const padlock = document.getElementById("privatePadlockSettings");
        if (padlock) {
            padlock.style.display = isOn ? "inline-block" : "none";
        }
    }
});

// Inicializar estado do cadeado nas configurações
document.addEventListener("DOMContentLoaded", () => {
    const togglePrivate = document.getElementById("togglePrivate");
    const padlock = document.getElementById("privatePadlockSettings");
    const storedPrivate = localStorage.getItem("isPrivateProfile");

    const isPrivate =
        storedPrivate === null ? true : storedPrivate === "true";

    if (togglePrivate) {
        if (isPrivate) togglePrivate.classList.add("on");
        else togglePrivate.classList.remove("on");
    }

    if (padlock) {
        padlock.style.display = isPrivate ? "inline-block" : "none";
    }
});

// --- Lógica do Modal de Senha ---
const btnChangePassword = document.getElementById("btnChangePassword");
const senhaModalOverlay = document.getElementById("senhaModalOverlay");
const modalStep1 = document.getElementById("modalStep1");
const modalStep2 = document.getElementById("modalStep2");
const modalStep3 = document.getElementById("modalStep3");
const currentPasswordInput = document.getElementById("currentPasswordInput");
const newPasswordInput = document.getElementById("newPasswordInput");
const confirmPasswordInput = document.getElementById("confirmPasswordInput");

if (
    btnChangePassword instanceof HTMLElement &&
    senhaModalOverlay instanceof HTMLElement &&
    modalStep1 instanceof HTMLElement &&
    modalStep2 instanceof HTMLElement &&
    modalStep3 instanceof HTMLElement &&
    currentPasswordInput instanceof HTMLInputElement &&
    newPasswordInput instanceof HTMLInputElement &&
    confirmPasswordInput instanceof HTMLInputElement
) {
    // Abrir modal ao clicar em Senha
    btnChangePassword.addEventListener("click", () => {
        modalStep1.style.display = "block";
        modalStep2.style.display = "none";
        modalStep3.style.display = "none";
        currentPasswordInput.value = "";
        newPasswordInput.value = "";
        confirmPasswordInput.value = "";

        const step1Error = document.getElementById("step1Error");
        const step2Error = document.getElementById("step2Error");
        if (step1Error) step1Error.style.display = "none";
        if (step2Error) step2Error.style.display = "none";

        senhaModalOverlay.classList.add("show");
        setTimeout(() => currentPasswordInput.focus(), 100);
    });

    // Fechar ao clicar fora do Modal
    senhaModalOverlay.addEventListener("click", (event: MouseEvent) => {
        if (event.target === senhaModalOverlay) {
            senhaModalOverlay.classList.remove("show");
        }
    });

    // Passo 1 → Passo 2 (Enter)
    currentPasswordInput.addEventListener(
        "keydown",
        (event: KeyboardEvent): void => {
            if (event.key !== "Enter") return;

            const err1 = document.getElementById("step1Error");
            if (currentPasswordInput.value.trim() !== "") {
                if (err1) err1.style.display = "none";
                modalStep1.style.display = "none";
                modalStep2.style.display = "block";
                setTimeout(() => newPasswordInput.focus(), 100);
            } else {
                if (err1) {
                    err1.innerText = "Digite a senha atual.";
                    err1.style.display = "block";
                }
            }
        }
    );

    // Passo 2: Nova senha → Confirmação (Enter)
    newPasswordInput.addEventListener(
        "keydown",
        (event: KeyboardEvent): void => {
            if (event.key === "Enter") {
                confirmPasswordInput.focus();
            }
        }
    );

    // Passo 2 → Passo 3 Sucesso (Enter em confirmar)
    confirmPasswordInput.addEventListener(
        "keydown",
        (event: KeyboardEvent): void => {
            if (event.key !== "Enter") return;

            const err2 = document.getElementById("step2Error");
            if (err2) err2.style.display = "none";

            if (newPasswordInput.value.trim() === "") {
                if (err2) {
                    err2.innerText = "A nova senha não pode ser vazia.";
                    err2.style.display = "block";
                }
                return;
            }

            const password = newPasswordInput.value;
            const numberCount = (password.match(/\d/g) || []).length;
            const specialCount = (password.match(/[^A-Za-z0-9]/g) || [])
                .length;

            if (password.length < 8 || numberCount < 3 || specialCount < 1) {
                if (err2) {
                    err2.innerText =
                        "A senha precisa ter no mínimo 8 caracteres, 3 números e 1 caractere especial.";
                    err2.style.display = "block";
                }
                return;
            }

            if (newPasswordInput.value === confirmPasswordInput.value) {
                modalStep2.style.display = "none";
                modalStep3.style.display = "block";

                setTimeout(() => {
                    senhaModalOverlay.classList.remove("show");
                }, 2500);
            } else {
                if (err2) {
                    err2.innerText =
                        "As senhas digitadas não coincidem. Verifique e tente novamente!";
                    err2.style.display = "block";
                }
            }
        }
    );
}

// --- Toggle mostrar/ocultar senha ---
function togglePasswordVis(...ids: string[]): void {
    ids.forEach((id) => {
        const input = document.getElementById(id);
        if (input instanceof HTMLInputElement) {
            input.type = input.type === "password" ? "text" : "password";
        }
    });
}

// Expor para uso inline (checkboxes de "Mostrar senha")
(window as unknown as Record<string, unknown>)["togglePasswordVis"] = togglePasswordVis;

// --- Lógica do Modal de Sobre ---
const btnSobre = document.getElementById("btnSobre");
const sobreModalOverlay = document.getElementById("sobreModalOverlay");
const generoOptionsContainer = document.getElementById(
    "generoOptionsContainer"
);

if (btnSobre instanceof HTMLElement && sobreModalOverlay instanceof HTMLElement) {
    btnSobre.addEventListener("click", () => {
        sobreModalOverlay.classList.add("show");
    });

    sobreModalOverlay.addEventListener("click", (event: MouseEvent) => {
        if (event.target === sobreModalOverlay) {
            sobreModalOverlay.classList.remove("show");
        }
    });
}

// Gênero buttons
if (generoOptionsContainer instanceof HTMLElement) {
    const generosBtns =
        generoOptionsContainer.querySelectorAll<HTMLButtonElement>(
            ".btn-genero"
        );
    generosBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
            generosBtns.forEach((b) => b.classList.remove("selected"));
            btn.classList.add("selected");
        });
    });
}
