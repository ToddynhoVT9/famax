/**
 * FAMAX — Profile View (Perfil Público) Script
 */
import { initSidebar } from "../shared/sidebar.js";
import { initHeaderDropdowns } from "../shared/header-dropdowns.js";

initSidebar();
initHeaderDropdowns();

// --- Verificação de perfil público vs. terceiros ---
document.addEventListener("DOMContentLoaded", () => {
    const urlParams = new URLSearchParams(window.location.search);
    const isOtherUser = urlParams.get("view") === "other";

    // Lógica do Cadeado de Perfil Privado
    const padlock = document.getElementById("privatePadlockProfile");
    if (padlock) {
        if (!isOtherUser) {
            const storedPrivate = localStorage.getItem("isPrivateProfile");
            const isPrivate =
                storedPrivate === null ? true : storedPrivate === "true";
            padlock.style.display = isPrivate ? "inline-block" : "none";
        } else {
            padlock.style.display = "none";
        }
    }

    if (isOtherUser) {
        // Esconde o botão de Editar Perfil
        const btnEditProfile =
            document.querySelector<HTMLElement>(".btn-edit-profile");
        if (btnEditProfile) {
            btnEditProfile.style.display = "none";
        }

        // Simula mudança de nome/usuário
        const nameParam = urlParams.get("name");
        if (nameParam) {
            const profileName =
                document.querySelector<HTMLElement>(".profile-name");
            const profileUsername =
                document.querySelector<HTMLElement>(".profile-username");
            const cleanName = nameParam
                .replace(/[\u{1F600}-\u{1F6FF}]/gu, "")
                .trim();

            if (profileName) profileName.innerText = cleanName;
            if (profileUsername)
                profileUsername.innerText =
                    "@" + cleanName.toLowerCase().replace(/\s+/g, "");
        }
    }
});

// --- Lógica de abas do perfil público ---
const tabBtns = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        tabBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
    });
});
