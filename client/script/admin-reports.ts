/**
 * FAMAX — Denúncias de usuários (admin/reports.html)
 *
 * A fila de GET /api/admin/reports, para quem tem users.is_admin. Mesma fila
 * da moderação de comunidade (shared/report-queue.ts); denúncia de usuário só
 * tem "em análise", "resolver" e "descartar".
 */
import { getMe } from "./shared/api.js";
import { requireLogin } from "./shared/auth-guard.js";
import { initLayout } from "./shared/layout.js";
import { createReportQueue } from "./shared/report-queue.js";

requireLogin();
initLayout();

const statusEl = document.getElementById("modStatus");
const queueRoot = document.getElementById("reportQueue");

async function init(): Promise<void> {
    try {
        const me = await getMe();
        if (!me.isAdmin) {
            if (statusEl) statusEl.textContent = "Esta página é só para a administração do FAMAX.";
            return;
        }
    } catch {
        // 401 já redirecionou para o login (api.ts).
        return;
    }

    if (statusEl) statusEl.hidden = true;
    if (!queueRoot) return;
    queueRoot.hidden = false;
    // Admin age como dono em qualquer comunidade (ver lib/moderation.ts).
    void createReportQueue(queueRoot, { endpoint: "/admin/reports", viewerRole: "owner" }).reload();
}

void init();
