/**
 * FAMAX — Widget "Maiores criadores" da comunidade
 *
 * Abas Semanalmente / Todos os tempos sobre
 * GET /communities/:id/leaderboard?period=week|all. Cada linha tem posição,
 * avatar (foto ou iniciais na cor estável), nome com link para o perfil e
 * pontos. As regras de pontos ficam no servidor (server/lib/points.ts); a
 * nota no rodapé só as resume.
 */
import { api } from "./shared/api.js";
import { profileUrl } from "./shared/pages.js";
import { avatarColor, initials } from "./shared/dom.js";

type Period = "week" | "all";

interface LeaderboardRow {
    user_id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    points: number;
    rank: number;
}

const EMPTY: Record<Period, string> = {
    week: "Ninguém pontuou nesta semana ainda. Publique uma discussão para aparecer aqui!",
    all: "Ninguém pontuou nesta comunidade ainda.",
};

function renderRow(row: LeaderboardRow): HTMLLIElement {
    const name = row.display_name?.trim() || row.username;
    const li = document.createElement("li");
    li.className = "tf-lb-item";

    const rank = document.createElement("span");
    rank.className = `tf-lb-rank${row.rank <= 3 ? ` tf-lb-rank--${row.rank}` : ""}`;
    rank.textContent = String(row.rank);

    const link = document.createElement("a");
    link.className = "tf-lb-user";
    link.href = profileUrl(row.user_id);

    const avatar = document.createElement("span");
    avatar.className = "tf-lb-avatar";
    if (row.avatar_url) {
        const img = document.createElement("img");
        img.src = row.avatar_url;
        img.alt = "";
        img.loading = "lazy";
        avatar.append(img);
    } else {
        avatar.classList.add(avatarColor(row.user_id));
        avatar.textContent = initials(name);
    }

    const label = document.createElement("span");
    label.className = "tf-lb-name";
    label.textContent = name;
    link.append(avatar, label);

    const points = document.createElement("span");
    points.className = "tf-lb-points";
    points.textContent = `${row.points} pts`;
    points.title = `${row.points} ${row.points === 1 ? "ponto" : "pontos"}`;

    li.append(rank, link, points);
    return li;
}

export function createLeaderboard(widget: HTMLElement, communityId: string): { reload(): Promise<void> } {
    const list = widget.querySelector<HTMLOListElement>(".tf-lb-list");
    const status = widget.querySelector<HTMLElement>(".tf-lb-status");
    const tabs = Array.from(widget.querySelectorAll<HTMLButtonElement>(".tf-lb-tab"));
    let period: Period = "week";
    let seq = 0;

    function setStatus(text: string | null, isError = false): void {
        if (!status) return;
        status.textContent = text ?? "";
        status.hidden = text === null;
        status.classList.toggle("error", isError);
    }

    async function load(): Promise<void> {
        if (!list) return;
        const current = ++seq;
        widget.setAttribute("aria-busy", "true");
        try {
            const { data } = await api<{ data: LeaderboardRow[] }>(
                `/communities/${encodeURIComponent(communityId)}/leaderboard?period=${period}&limit=5`,
            );
            if (current !== seq) return;
            list.replaceChildren(...data.map(renderRow));
            setStatus(data.length === 0 ? EMPTY[period] : null);
        } catch (err) {
            if (current !== seq) return;
            list.replaceChildren();
            setStatus(err instanceof Error ? err.message : "Não foi possível carregar o ranking.", true);
        } finally {
            if (current === seq) widget.removeAttribute("aria-busy");
        }
    }

    for (const tab of tabs) {
        tab.addEventListener("click", () => {
            const next = tab.dataset.period as Period;
            if (next === period) return;
            period = next;
            for (const t of tabs) {
                const active = t === tab;
                t.classList.toggle("active", active);
                t.setAttribute("aria-selected", String(active));
            }
            void load();
        });
    }

    void load();
    return { reload: load };
}
