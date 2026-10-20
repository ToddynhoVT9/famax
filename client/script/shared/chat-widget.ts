/**
 * FAMAX — Widget de Chat
 *
 * Reescrita do protótipo (_famax-tab/js/chat-widget.js) com três mudanças
 * estruturais:
 *
 *  1. O CSS saiu do JS (client/css/chat-widget.css). A template string de 245
 *     linhas fazia a página aparecer sem estilo até o script rodar.
 *  2. O gate deixou de ser uma blocklist de nomes de arquivo. O protótipo
 *     comparava location.pathname com ['login.html', ...] — isso já não
 *     funcionaria aqui, onde as páginas vivem em subpastas. Agora: renderiza
 *     se há token.
 *  3. O estado vem da API. Nada de contatos fixos nem da resposta automática
 *     via setTimeout.
 *
 * Transporte: tempo real por SSE (shared/realtime.ts) — mensagem nova,
 * apagada, "visto", "digitando" e mudanças em grupos chegam como eventos com
 * ids, e o widget busca o resto pela API. O polling com cursor ficou de
 * reserva: só roda enquanto o stream está fora, e pausa com a aba em
 * background (sem isso, cada aba aberta geraria tráfego para sempre).
 *
 * Também: histórico ao rolar até o topo, reenviar / descartar mensagem que
 * falhou, apagar a própria mensagem, "Visto", "digitando...", lista de
 * conversas paginada e grupos (criar, renomear, adicionar, remover, sair).
 *
 * Outras páginas abrem o widget numa conversa com shared/chat-bus.ts
 * (evento famax:open-chat), sem importar este módulo.
 */
// Importado aqui, não via <link> em cada página: assim o estilo acompanha o
// widget em qualquer HTML que carregue este módulo.
import "../../css/chat-widget.css";
import { api, getCurrentUserId, getToken } from "./api.js";
import { avatarColor, escapeHtml, initials, shortTime } from "./dom.js";
import { confirmDialog, toast } from "./dialog.js";
import { isRealtimeOpen, onRealtime, onRealtimeStatus } from "./realtime.js";
import { OPEN_CHAT_EVENT, type OpenChatDetail } from "./chat-bus.js";

/** Polling de reserva (stream fora): widget aberto / fechado. */
const POLL_OPEN_MS = 5_000;
const POLL_CLOSED_MS = 30_000;
/** No máximo um aviso de "digitando" a cada 3 s; some 4 s depois do último. */
const TYPING_SEND_MS = 3_000;
const TYPING_SHOW_MS = 4_000;
const HISTORY_PAGE = 30;

interface Conversation {
    conversation_id: string;
    is_group: boolean;
    title: string | null;
    last_message_at: string;
    other_user_id: string | null;
    other_username: string | null;
    other_display_name: string | null;
    other_avatar_url: string | null;
    participants_count: number;
    last_message_content: string | null;
    unread_count: number;
}

interface Participant {
    user_id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    role: "admin" | "member";
    last_read_at: string;
}

interface ActiveConversation {
    id: string;
    isGroup: boolean;
    title: string | null;
    myRole: "admin" | "member";
    participants: Participant[];
}

interface Message {
    message_id: string;
    conversation_id: string;
    sender_id: string;
    kind: "text" | "system";
    content: string | null;
    is_deleted: boolean;
    created_at: string;
    sender_username: string | null;
    sender_display_name: string | null;
    sender_avatar_url: string | null;
    /** Só no cliente: enviando / falhou. */
    _state?: "pending" | "failed";
}

interface UserResult {
    user_id: string;
    username: string;
    display_name: string | null;
}

const currentUserId = getCurrentUserId();

// Sem sessão não há chat. Também evita disparar polling em login/cadastro.
if (getToken() && currentUserId && document.body) {
    initChatWidget();
}

function initChatWidget(): void {
    const widget = document.createElement("div");
    widget.className = "chat-widget";
    widget.id = "chatWidget";
    widget.innerHTML = `
        <button class="chat-toggle" id="chatToggle" aria-label="Abrir chat">
            💬<span class="chat-unread-badge" id="chatUnreadBadge"></span>
        </button>
        <div class="chat-panel" id="chatPanel" role="dialog" aria-label="Chat bate-papo">
            <div class="chat-header">
                <div>
                    <h3>Mensagens</h3>
                    <p id="chatSubtitle">Converse com seus amigos</p>
                </div>
                <div class="chat-header-actions">
                    <button class="chat-header-btn" id="chatNewBtn" aria-label="Nova conversa" title="Nova conversa ou grupo">＋</button>
                    <button class="chat-header-btn" id="chatClose" aria-label="Fechar chat">✕</button>
                </div>
            </div>
            <div class="chat-search" id="chatSearch">
                <div class="chat-search-modes" role="group" aria-label="Tipo de conversa">
                    <button type="button" class="chat-mode active" data-mode="direct" aria-pressed="true">Conversa</button>
                    <button type="button" class="chat-mode" data-mode="group" aria-pressed="false">Grupo</button>
                </div>
                <input id="chatGroupTitle" type="text" placeholder="Nome do grupo" maxlength="80" hidden />
                <div class="chat-chips" id="chatGroupChips" hidden></div>
                <input id="chatSearchInput" type="text" placeholder="Buscar pessoa pelo nome ou @usuário" maxlength="50" />
                <div class="chat-search-results" id="chatSearchResults"></div>
                <button type="button" class="chat-primary-btn" id="chatGroupCreate" hidden>Criar grupo</button>
            </div>
            <div class="chat-body">
                <aside class="chat-contacts" id="chatContacts"></aside>
                <section class="chat-conversation">
                    <div class="chat-conv-header" id="chatConvHeader" hidden>
                        <span class="chat-conv-title" id="chatConvTitle"></span>
                        <button type="button" class="chat-conv-btn" id="chatGroupBtn" hidden aria-label="Detalhes do grupo" title="Detalhes do grupo">⚙</button>
                    </div>
                    <div class="chat-messages" id="chatMessages" aria-live="polite"></div>
                    <div class="chat-group-panel" id="chatGroupPanel" hidden></div>
                    <div class="chat-typing" id="chatTyping" hidden></div>
                    <form class="chat-input-row" id="chatForm">
                        <input id="chatInput" type="text" placeholder="Digite uma mensagem..." maxlength="2000" disabled aria-label="Mensagem" />
                        <button type="submit" id="chatSend" disabled>Enviar</button>
                    </form>
                </section>
            </div>
        </div>
    `;
    document.body.appendChild(widget);

    const toggle = must<HTMLButtonElement>("chatToggle");
    const closeBtn = must<HTMLButtonElement>("chatClose");
    const newBtn = must<HTMLButtonElement>("chatNewBtn");
    const contactsEl = must<HTMLElement>("chatContacts");
    const messagesEl = must<HTMLElement>("chatMessages");
    const form = must<HTMLFormElement>("chatForm");
    const input = must<HTMLInputElement>("chatInput");
    const sendBtn = must<HTMLButtonElement>("chatSend");
    const badge = must<HTMLElement>("chatUnreadBadge");
    const searchInput = must<HTMLInputElement>("chatSearchInput");
    const searchResults = must<HTMLElement>("chatSearchResults");
    const groupTitleInput = must<HTMLInputElement>("chatGroupTitle");
    const groupChips = must<HTMLElement>("chatGroupChips");
    const groupCreate = must<HTMLButtonElement>("chatGroupCreate");
    const convHeader = must<HTMLElement>("chatConvHeader");
    const convTitle = must<HTMLElement>("chatConvTitle");
    const groupBtn = must<HTMLButtonElement>("chatGroupBtn");
    const groupPanel = must<HTMLElement>("chatGroupPanel");
    const typingEl = must<HTMLElement>("chatTyping");

    let conversations: Conversation[] = [];
    let conversationsCursor: string | null = null;
    let unreadTotal = 0;
    let active: ActiveConversation | null = null;
    let messages: Message[] = [];
    /** Ainda há mensagens mais antigas para buscar ao rolar até o topo. */
    let hasOlder = false;
    let loadingOlder = false;
    /**
     * Uma página de histórico por "chegada" ao topo: depois de carregar,
     * só volta a buscar quando a pessoa se afasta do topo e volta. Sem isto,
     * os eventos de scroll gerados pelo próprio redesenho emendavam várias
     * páginas seguidas.
     */
    let historyArmed = false;
    let pollTimer: number | null = null;
    let searchTimer: number | null = null;
    let searchMode: "direct" | "group" = "direct";
    let groupSelection: UserResult[] = [];
    /** Quem está digitando na conversa ativa, até quando. */
    const typing = new Map<string, { name: string; until: number }>();
    let typingTimer: number | null = null;
    let lastTypingSent = 0;

    const isOpen = (): boolean => widget.classList.contains("open");
    const errorText = (err: unknown, fallback: string): string => (err instanceof Error ? err.message : fallback);

    // =====================================================================
    // Render
    // =====================================================================

    const conversationName = (c: Conversation): string =>
        c.is_group
            ? c.title?.trim() || "Grupo"
            : c.other_display_name?.trim() || c.other_username || "Conversa";

    function avatarHtml(id: string | null, name: string, url: string | null, className: string): string {
        if (url) {
            return `<span class="${className}"><img src="${escapeHtml(url)}" alt="" /></span>`;
        }
        return `<span class="${className} ${avatarColor(id)}">${escapeHtml(initials(name))}</span>`;
    }

    function renderContacts(): void {
        if (conversations.length === 0) {
            contactsEl.innerHTML = '<div class="chat-search-empty">Nenhuma conversa</div>';
            return;
        }

        contactsEl.innerHTML =
            conversations
                .map((conversation) => {
                    const name = conversationName(conversation);
                    const unread =
                        conversation.unread_count > 0
                            ? `<span class="contact-unread">${conversation.unread_count > 99 ? "99+" : conversation.unread_count}</span>`
                            : "";
                    const avatar = conversation.is_group
                        ? `<span class="contact-avatar contact-avatar--group" aria-hidden="true">👥</span>`
                        : avatarHtml(conversation.other_user_id, name, conversation.other_avatar_url, "contact-avatar");
                    return `
                    <button type="button" class="contact-item ${conversation.conversation_id === active?.id ? "active" : ""}"
                            data-conversation="${escapeHtml(conversation.conversation_id)}" title="${escapeHtml(name)}">
                        ${unread}
                        ${avatar}
                        <span class="contact-name">${escapeHtml(name)}</span>
                    </button>`;
                })
                .join("") +
            (conversationsCursor
                ? '<button type="button" class="contacts-more" id="chatContactsMore">Mais</button>'
                : "");
    }

    function renderHeader(): void {
        if (!active) {
            convHeader.hidden = true;
            return;
        }
        const conversation = conversations.find((c) => c.conversation_id === active!.id);
        const others = active.participants.filter((p) => p.user_id !== currentUserId);
        const name = active.isGroup
            ? active.title?.trim() || "Grupo"
            : conversation
              ? conversationName(conversation)
              : others[0]?.display_name?.trim() || others[0]?.username || "Conversa";
        convTitle.textContent = active.isGroup ? `${name} · ${active.participants.length} pessoas` : name;
        groupBtn.hidden = !active.isGroup;
        convHeader.hidden = false;
    }

    /** Quantos outros participantes já leram até esta mensagem. */
    function seenCount(message: Message): number {
        if (!active) return 0;
        const at = new Date(message.created_at).getTime();
        return active.participants.filter(
            (p) => p.user_id !== currentUserId && new Date(p.last_read_at).getTime() >= at,
        ).length;
    }

    function messageHtml(message: Message, previous: Message | undefined, seenLabel: string | null): string {
        if (message.kind === "system") {
            return `<div class="message-system">${escapeHtml(message.content ?? "")}</div>`;
        }
        const mine = message.sender_id === currentUserId;
        const id = escapeHtml(message.message_id);

        let body: string;
        let meta: string;
        if (message.is_deleted) {
            body = '<em class="message-deleted">mensagem apagada</em>';
            meta = escapeHtml(shortTime(message.created_at));
        } else {
            body = escapeHtml(message.content ?? "");
            if (message._state === "failed") {
                meta = `não enviada ·
                    <button type="button" class="message-action" data-action="retry" data-id="${id}">Tentar de novo</button> ·
                    <button type="button" class="message-action" data-action="discard" data-id="${id}">Descartar</button>`;
            } else if (message._state === "pending") {
                meta = "enviando...";
            } else {
                meta = escapeHtml(shortTime(message.created_at));
                if (mine) {
                    // O "·" vai dentro do botão: some junto com ele (só aparece no hover).
                    meta += ` <button type="button" class="message-action" data-action="delete" data-id="${id}" aria-label="Apagar mensagem">· apagar</button>`;
                }
            }
        }

        const state = message._state ? ` ${message._state}` : "";
        const bubble = `<div class="message-bubble ${mine ? "me" : "other"}${state}${message.is_deleted ? " is-deleted" : ""}">${body}<span class="message-time">${meta}</span></div>`;
        const seen = seenLabel ? `<div class="message-seen">${escapeHtml(seenLabel)}</div>` : "";

        // Grupo: avatar e nome de quem mandou (só no começo de uma sequência).
        if (!mine && active?.isGroup) {
            const name = message.sender_display_name?.trim() || message.sender_username || "Alguém";
            const firstOfRun = previous?.sender_id !== message.sender_id || previous?.kind === "system";
            return `
                <div class="message-row other${firstOfRun ? "" : " is-continued"}">
                    ${firstOfRun ? avatarHtml(message.sender_id, name, message.sender_avatar_url, "message-avatar") : '<span class="message-avatar-space"></span>'}
                    <div class="message-stack">
                        ${firstOfRun ? `<span class="message-sender">${escapeHtml(name)}</span>` : ""}
                        ${bubble}
                    </div>
                </div>`;
        }
        return bubble + seen;
    }

    /**
     * scroll: "bottom" vai para o fim; "keep" mantém a posição relativa (ao
     * pôr histórico em cima); "auto" segue o fim só se já estava lá.
     */
    function renderMessages(scroll: "bottom" | "keep" | "auto" = "auto"): void {
        if (!active) {
            messagesEl.innerHTML =
                '<div class="chat-status">Escolha uma conversa ou use ＋ para começar uma nova.</div>';
            return;
        }
        if (messages.length === 0) {
            messagesEl.innerHTML = '<div class="chat-status">Nenhuma mensagem ainda. Diga oi!</div>';
            return;
        }

        const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
        const previousHeight = messagesEl.scrollHeight;
        const previousTop = messagesEl.scrollTop;

        // "Visto" vai embaixo da última mensagem minha confirmada e lida.
        let seenIndex = -1;
        let seenLabel: string | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.sender_id !== currentUserId || m.kind !== "text" || m._state || m.is_deleted) continue;
            const count = seenCount(m);
            if (count > 0) {
                seenIndex = i;
                seenLabel = active.isGroup ? `Visto por ${count}` : "Visto";
            }
            break;
        }

        const top = hasOlder
            ? '<div class="chat-history-hint">Role para cima para ver mensagens anteriores</div>'
            : '<div class="chat-history-hint">Início da conversa</div>';
        messagesEl.innerHTML =
            top +
            messages
                .map((message, index) => messageHtml(message, messages[index - 1], index === seenIndex ? seenLabel : null))
                .join("");

        if (scroll === "bottom" || (scroll === "auto" && nearBottom)) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (scroll === "keep") {
            messagesEl.scrollTop = messagesEl.scrollHeight - previousHeight + previousTop;
        }
    }

    function renderBadge(): void {
        badge.textContent = unreadTotal > 99 ? "99+" : String(unreadTotal);
        badge.classList.toggle("show", unreadTotal > 0);
    }

    function renderTyping(): void {
        const now = Date.now();
        for (const [id, entry] of typing) if (entry.until <= now) typing.delete(id);
        const names = [...typing.values()].map((t) => t.name);
        typingEl.hidden = names.length === 0;
        typingEl.textContent =
            names.length === 0
                ? ""
                : names.length === 1
                  ? `${names[0]} está digitando...`
                  : `${names.slice(0, 2).join(" e ")}${names.length > 2 ? " e outros" : ""} estão digitando...`;
        if (typingTimer !== null) window.clearTimeout(typingTimer);
        typingTimer = names.length > 0 ? window.setTimeout(renderTyping, 1_000) : null;
    }

    function setInputEnabled(enabled: boolean): void {
        input.disabled = !enabled;
        sendBtn.disabled = !enabled;
    }

    // =====================================================================
    // Dados
    // =====================================================================

    async function loadConversations(more = false): Promise<void> {
        try {
            const params = new URLSearchParams({ limit: "30" });
            if (more && conversationsCursor) params.set("cursor", conversationsCursor);
            const page = await api<{ data: Conversation[]; nextCursor: string | null; unreadTotal: number }>(
                `/conversations?${params}`,
            );
            conversations = more ? conversations.concat(page.data) : page.data;
            conversationsCursor = page.nextCursor;
            unreadTotal = page.unreadTotal;
            renderContacts();
            renderBadge();
            renderHeader();
        } catch {
            // Rede instável não deve quebrar a página que hospeda o widget.
        }
    }

    async function loadDetails(conversationId: string): Promise<boolean> {
        try {
            const { conversation, participants } = await api<{
                conversation: { conversation_id: string; is_group: boolean; title: string | null; my_role: "admin" | "member" };
                participants: Participant[];
            }>(`/conversations/${encodeURIComponent(conversationId)}`);
            if (active?.id !== conversationId) return true;
            active = {
                id: conversationId,
                isGroup: conversation.is_group,
                title: conversation.title,
                myRole: conversation.my_role,
                participants,
            };
            renderHeader();
            return true;
        } catch {
            return false;
        }
    }

    /** Saiu do grupo ou foi removido: a conversa some da tela. */
    function leaveActive(message: string): void {
        active = null;
        messages = [];
        groupPanel.hidden = true;
        typing.clear();
        renderTyping();
        setInputEnabled(false);
        renderHeader();
        messagesEl.innerHTML = `<div class="chat-status">${escapeHtml(message)}</div>`;
    }

    async function openConversation(conversationId: string): Promise<void> {
        active = { id: conversationId, isGroup: false, title: null, myRole: "member", participants: [] };
        messages = [];
        hasOlder = false;
        groupPanel.hidden = true;
        typing.clear();
        renderTyping();
        renderContacts();
        renderHeader();

        messagesEl.innerHTML = '<div class="chat-status">Carregando...</div>';
        setInputEnabled(true);

        try {
            const [page] = await Promise.all([
                api<{ data: Message[]; hasMore: boolean }>(
                    `/conversations/${encodeURIComponent(conversationId)}/messages?limit=${HISTORY_PAGE}`,
                ),
                loadDetails(conversationId),
            ]);
            if (active?.id !== conversationId) return;
            messages = page.data;
            hasOlder = page.hasMore;
            historyArmed = false;
            renderMessages("bottom");
            messagesEl.classList.remove("is-changing");
            requestAnimationFrame(() => messagesEl.classList.add("is-changing"));
            await markRead(conversationId);
        } catch (err) {
            messagesEl.innerHTML = '<div class="chat-status"></div>';
            const status = messagesEl.querySelector(".chat-status");
            if (status) status.textContent = errorText(err, "Erro ao carregar mensagens.");
        }
    }

    /** Histórico: busca a página anterior à primeira mensagem na tela. */
    async function loadOlder(): Promise<void> {
        const conversationId = active?.id;
        const first = messages.find((m) => !m._state);
        if (!conversationId || !first || !hasOlder || loadingOlder) return;
        loadingOlder = true;
        try {
            const page = await api<{ data: Message[]; hasMore: boolean }>(
                `/conversations/${encodeURIComponent(conversationId)}/messages?limit=${HISTORY_PAGE}&beforeId=${encodeURIComponent(first.message_id)}`,
            );
            if (active?.id !== conversationId) return;
            const known = new Set(messages.map((m) => m.message_id));
            messages = page.data.filter((m) => !known.has(m.message_id)).concat(messages);
            hasOlder = page.hasMore;
            historyArmed = false;
            renderMessages("keep");
        } catch {
            // Tenta de novo no próximo scroll.
        } finally {
            loadingOlder = false;
        }
    }

    async function markRead(conversationId: string): Promise<void> {
        // Só conta como lida se a pessoa está vendo a conversa.
        if (!isOpen() || document.hidden) return;
        try {
            await api(`/conversations/${encodeURIComponent(conversationId)}/read`, { method: "POST" });
            const conversation = conversations.find((c) => c.conversation_id === conversationId);
            if (conversation && conversation.unread_count > 0) {
                unreadTotal = Math.max(0, unreadTotal - conversation.unread_count);
                conversation.unread_count = 0;
                renderContacts();
                renderBadge();
            }
        } catch {
            // O badge se corrige na próxima atualização.
        }
    }

    /** Busca só o que chegou depois da última mensagem confirmada na tela. */
    async function fetchNewMessages(): Promise<void> {
        const conversationId = active?.id;
        if (!conversationId) return;
        const confirmed = messages.filter((m) => !m._state);
        const last = confirmed[confirmed.length - 1];
        try {
            const query = last ? `after=${encodeURIComponent(last.created_at)}` : `limit=${HISTORY_PAGE}`;
            const { data } = await api<{ data: Message[] }>(
                `/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
            );
            if (active?.id !== conversationId) return;
            // Descarta o que já está na tela: o eco da própria mensagem
            // confirmada chegaria duplicado.
            const known = new Set(messages.map((m) => m.message_id));
            const fresh = data.filter((m) => !known.has(m.message_id));
            if (fresh.length === 0) return;
            const pending = messages.filter((m) => m._state);
            messages = confirmed.concat(fresh, pending);
            // Quem mandou a mensagem parou de digitar.
            for (const m of fresh) typing.delete(m.sender_id);
            renderTyping();
            renderMessages();
            await markRead(conversationId);
        } catch {
            // O próximo evento (ou tick) tenta de novo.
        }
    }

    // =====================================================================
    // Tempo real (e o polling de reserva)
    // =====================================================================

    onRealtime("message:new", (data) => {
        if (data.conversationId === active?.id) void fetchNewMessages();
        void loadConversations();
    });
    onRealtime("message:deleted", (data) => {
        if (data.conversationId === active?.id) {
            const message = messages.find((m) => m.message_id === data.messageId);
            if (message) {
                message.is_deleted = true;
                message.content = null;
                renderMessages();
            }
        }
        void loadConversations();
    });
    onRealtime("conversation:read", (data) => {
        if (data.userId === currentUserId) {
            // Li em outra aba: o badge desta acompanha.
            void loadConversations();
            return;
        }
        if (!active || data.conversationId !== active.id) return;
        const participant = active.participants.find((p) => p.user_id === data.userId);
        if (participant && typeof data.lastReadAt === "string") {
            participant.last_read_at = data.lastReadAt;
            renderMessages();
        }
    });
    onRealtime("conversation:updated", (data) => {
        void loadConversations();
        if (!active || data.conversationId !== active.id) return;
        const conversationId = active.id;
        void loadDetails(conversationId).then((stillIn) => {
            if (!stillIn && active?.id === conversationId) {
                leaveActive("Você não participa mais desta conversa.");
            } else if (!groupPanel.hidden) {
                renderGroupPanel();
            }
        });
    });
    onRealtime("typing", (data) => {
        if (data.conversationId !== active?.id || typeof data.userId !== "string") return;
        typing.set(data.userId, { name: String(data.name ?? "Alguém"), until: Date.now() + TYPING_SHOW_MS });
        renderTyping();
    });
    onRealtimeStatus((open) => {
        // Voltou depois de cair: busca o que pode ter passado nesse meio-tempo.
        if (open) {
            void loadConversations();
            void fetchNewMessages();
        }
        scheduleNextTick();
    });

    function scheduleNextTick(): void {
        if (pollTimer !== null) {
            window.clearTimeout(pollTimer);
            pollTimer = null;
        }

        // Com o stream de pé não há polling; aba em background também não.
        if (document.hidden || isRealtimeOpen()) return;

        pollTimer = window.setTimeout(async () => {
            if (isOpen()) await fetchNewMessages();
            await loadConversations();
            scheduleNextTick();
        }, isOpen() ? POLL_OPEN_MS : POLL_CLOSED_MS);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (pollTimer !== null) {
                window.clearTimeout(pollTimer);
                pollTimer = null;
            }
        } else {
            void loadConversations();
            if (active && isOpen()) void markRead(active.id);
            scheduleNextTick();
        }
    });

    // =====================================================================
    // Envio, reenvio, apagar, digitando
    // =====================================================================

    async function deliver(message: Message): Promise<void> {
        const conversationId = message.conversation_id;
        message._state = "pending";
        renderMessages("bottom");
        try {
            const { message: saved } = await api<{ message: Message }>(
                `/conversations/${encodeURIComponent(conversationId)}/messages`,
                { method: "POST", body: JSON.stringify({ content: message.content }) },
            );
            if (active?.id !== conversationId) return;
            const index = messages.findIndex((m) => m.message_id === message.message_id);
            // O evento SSE pode ter trazido a mesma mensagem antes da resposta.
            const already = messages.some((m) => m.message_id === saved.message_id);
            if (index !== -1) {
                if (already) messages.splice(index, 1);
                else messages[index] = saved;
            }
            lastTypingSent = 0;
            renderMessages();
            void loadConversations();
        } catch (err) {
            message._state = "failed";
            renderMessages();
            console.error("Falha ao enviar mensagem:", err);
        }
    }

    form.addEventListener("submit", (event: SubmitEvent) => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content || !active) return;

        // Render otimista: aparece na hora, marcada como enviando, e é
        // substituída pela versão confirmada do servidor.
        const optimistic: Message = {
            message_id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            conversation_id: active.id,
            sender_id: currentUserId!,
            kind: "text",
            content,
            is_deleted: false,
            created_at: new Date().toISOString(),
            sender_username: null,
            sender_display_name: null,
            sender_avatar_url: null,
        };
        messages.push(optimistic);
        input.value = "";
        void deliver(optimistic);
    });

    input.addEventListener("input", () => {
        if (!active || !input.value.trim()) return;
        const now = Date.now();
        if (now - lastTypingSent < TYPING_SEND_MS) return;
        lastTypingSent = now;
        void api(`/conversations/${encodeURIComponent(active.id)}/typing`, { method: "POST" }).catch(() => {});
    });

    messagesEl.addEventListener("click", async (event: MouseEvent) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-action]");
        const id = button?.dataset.id;
        const message = id ? messages.find((m) => m.message_id === id) : undefined;
        if (!button || !message || !active) return;
        event.stopPropagation();

        switch (button.dataset.action) {
            case "retry":
                void deliver(message);
                return;
            case "discard":
                messages = messages.filter((m) => m !== message);
                renderMessages();
                return;
            case "delete": {
                const ok = await confirmDialog({
                    title: "Apagar mensagem?",
                    message: "Ela some para todos e fica no lugar o aviso “mensagem apagada”.",
                    confirmLabel: "Apagar",
                    danger: true,
                });
                if (!ok) return;
                try {
                    await api(
                        `/conversations/${encodeURIComponent(message.conversation_id)}/messages/${encodeURIComponent(message.message_id)}`,
                        { method: "DELETE" },
                    );
                    message.is_deleted = true;
                    message.content = null;
                    renderMessages();
                    void loadConversations();
                } catch (err) {
                    toast(errorText(err, "Não foi possível apagar."), "error");
                }
                return;
            }
        }
    });

    messagesEl.addEventListener("scroll", () => {
        if (messagesEl.scrollTop > 120) historyArmed = true;
        else if (messagesEl.scrollTop < 40 && historyArmed) void loadOlder();
    });

    // =====================================================================
    // Grupo: detalhes, renomear, adicionar, remover, sair
    // =====================================================================

    function participantName(p: Participant): string {
        return p.display_name?.trim() || p.username;
    }

    function renderGroupPanel(): void {
        if (!active?.isGroup) {
            groupPanel.hidden = true;
            return;
        }
        const conversationId = active.id;
        const isAdmin = active.myRole === "admin";
        groupPanel.replaceChildren();

        const head = el("div", "chat-group-head");
        const title = el("strong", "", "Detalhes do grupo");
        const close = el("button", "chat-conv-btn", "✕");
        close.type = "button";
        close.setAttribute("aria-label", "Fechar detalhes");
        close.addEventListener("click", () => {
            groupPanel.hidden = true;
        });
        head.append(title, close);
        groupPanel.append(head);

        if (isAdmin) {
            const rename = el("form", "chat-group-rename");
            const field = el("input", "chat-group-input");
            field.value = active.title ?? "";
            field.maxLength = 80;
            field.setAttribute("aria-label", "Nome do grupo");
            const save = el("button", "chat-primary-btn", "Renomear");
            save.type = "submit";
            rename.append(field, save);
            rename.addEventListener("submit", async (event) => {
                event.preventDefault();
                const value = field.value.trim();
                if (!value || value === active?.title) return;
                save.disabled = true;
                try {
                    await api(`/conversations/${encodeURIComponent(conversationId)}`, {
                        method: "PATCH",
                        body: JSON.stringify({ title: value }),
                    });
                    toast("Grupo renomeado.");
                } catch (err) {
                    toast(errorText(err, "Não foi possível renomear."), "error");
                } finally {
                    save.disabled = false;
                }
            });
            groupPanel.append(rename);
        }

        const list = el("ul", "chat-group-members");
        for (const p of active.participants) {
            const item = el("li", "chat-group-member");
            const label = el("span", "", participantName(p) + (p.user_id === currentUserId ? " (você)" : ""));
            item.append(label);
            if (p.role === "admin") item.append(el("span", "chat-group-role", "admin"));
            if (isAdmin && p.user_id !== currentUserId) {
                const remove = el("button", "message-action", "remover");
                remove.type = "button";
                remove.addEventListener("click", async () => {
                    const ok = await confirmDialog({
                        title: "Remover do grupo?",
                        message: `${participantName(p)} deixa de ver as mensagens do grupo.`,
                        confirmLabel: "Remover",
                        danger: true,
                    });
                    if (!ok) return;
                    try {
                        await api(
                            `/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(p.user_id)}`,
                            { method: "DELETE" },
                        );
                    } catch (err) {
                        toast(errorText(err, "Não foi possível remover."), "error");
                    }
                });
                item.append(remove);
            }
            list.append(item);
        }
        groupPanel.append(el("p", "chat-group-label", `${active.participants.length} pessoas`), list);

        if (isAdmin) {
            const addInput = el("input", "chat-group-input");
            addInput.placeholder = "Adicionar pessoa: nome ou @usuário";
            addInput.maxLength = 50;
            addInput.setAttribute("aria-label", "Adicionar pessoa ao grupo");
            const results = el("div", "chat-search-results");
            let timer: number | null = null;
            addInput.addEventListener("input", () => {
                if (timer !== null) window.clearTimeout(timer);
                const term = addInput.value.trim();
                if (term.length < 2) {
                    results.replaceChildren();
                    return;
                }
                timer = window.setTimeout(async () => {
                    const found = await searchUsers(term);
                    const inGroup = new Set(active?.participants.map((p) => p.user_id));
                    results.replaceChildren(
                        ...found
                            .filter((u) => !inGroup.has(u.user_id))
                            .map((u) => {
                                const button = el("button", "chat-search-item", u.display_name?.trim() || u.username);
                                button.type = "button";
                                button.addEventListener("click", async () => {
                                    button.disabled = true;
                                    try {
                                        await api(`/conversations/${encodeURIComponent(conversationId)}/participants`, {
                                            method: "POST",
                                            body: JSON.stringify({ userIds: [u.user_id] }),
                                        });
                                        addInput.value = "";
                                        results.replaceChildren();
                                    } catch (err) {
                                        toast(errorText(err, "Não foi possível adicionar."), "error");
                                        button.disabled = false;
                                    }
                                });
                                return button;
                            }),
                    );
                }, 300);
            });
            groupPanel.append(addInput, results);
        }

        const leave = el("button", "chat-danger-btn", "Sair do grupo");
        leave.type = "button";
        leave.addEventListener("click", async () => {
            const ok = await confirmDialog({
                title: "Sair do grupo?",
                message: isAdmin
                    ? "Você deixa de receber as mensagens. Como você é admin, a pessoa mais antiga do grupo assume."
                    : "Você deixa de receber as mensagens do grupo.",
                confirmLabel: "Sair",
                danger: true,
            });
            if (!ok) return;
            try {
                await api(
                    `/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(currentUserId!)}`,
                    { method: "DELETE" },
                );
                leaveActive("Você saiu do grupo.");
                void loadConversations();
            } catch (err) {
                toast(errorText(err, "Não foi possível sair."), "error");
            }
        });
        groupPanel.append(leave);
        groupPanel.hidden = false;
    }

    groupBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (groupPanel.hidden) renderGroupPanel();
        else groupPanel.hidden = true;
    });

    // =====================================================================
    // Nova conversa / novo grupo
    // =====================================================================

    async function searchUsers(term: string): Promise<UserResult[]> {
        try {
            const { data } = await api<{ data: UserResult[] }>(`/users?search=${encodeURIComponent(term)}`);
            return data;
        } catch {
            return [];
        }
    }

    function setSearchMode(mode: "direct" | "group"): void {
        searchMode = mode;
        widget.querySelectorAll<HTMLButtonElement>(".chat-mode").forEach((b) => {
            const on = b.dataset.mode === mode;
            b.classList.toggle("active", on);
            b.setAttribute("aria-pressed", String(on));
        });
        groupTitleInput.hidden = mode !== "group";
        groupChips.hidden = mode !== "group";
        groupCreate.hidden = mode !== "group";
        renderGroupChips();
    }

    function renderGroupChips(): void {
        groupChips.replaceChildren(
            ...groupSelection.map((u) => {
                const chip = el("button", "chat-chip", `${u.display_name?.trim() || u.username} ✕`);
                chip.type = "button";
                chip.setAttribute("aria-label", `Tirar ${u.display_name?.trim() || u.username}`);
                chip.addEventListener("click", (event) => {
                    event.stopPropagation();
                    groupSelection = groupSelection.filter((s) => s.user_id !== u.user_id);
                    renderGroupChips();
                });
                return chip;
            }),
        );
        groupCreate.disabled = groupSelection.length === 0;
    }

    widget.querySelector(".chat-search-modes")?.addEventListener("click", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(".chat-mode");
        if (button?.dataset.mode) setSearchMode(button.dataset.mode as "direct" | "group");
    });

    newBtn.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        widget.classList.toggle("searching");
        if (widget.classList.contains("searching")) {
            searchInput.value = "";
            groupTitleInput.value = "";
            groupSelection = [];
            searchResults.innerHTML = "";
            setSearchMode("direct");
            searchInput.focus();
        }
    });

    searchInput.addEventListener("input", () => {
        if (searchTimer !== null) window.clearTimeout(searchTimer);
        const term = searchInput.value.trim();

        if (term.length < 2) {
            searchResults.innerHTML = '<div class="chat-search-empty">Digite ao menos 2 caracteres</div>';
            return;
        }

        // Debounce: sem isso cada tecla vira uma query com ILIKE.
        searchTimer = window.setTimeout(async () => {
            const data = await searchUsers(term);
            searchResults.innerHTML =
                data.length > 0
                    ? data
                          .map(
                              (user) => `
                        <button type="button" class="chat-search-item" data-user="${escapeHtml(user.user_id)}"
                                data-name="${escapeHtml(user.display_name?.trim() || user.username)}" data-username="${escapeHtml(user.username)}">
                            ${escapeHtml(user.display_name?.trim() || user.username)}
                            <span class="chat-search-empty">@${escapeHtml(user.username)}</span>
                        </button>`,
                          )
                          .join("")
                    : '<div class="chat-search-empty">Ninguém encontrado</div>';
        }, 300);
    });

    searchResults.addEventListener("click", async (event: MouseEvent) => {
        event.stopPropagation();
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".chat-search-item");
        const userId = button?.dataset.user;
        if (!button || !userId) return;

        if (searchMode === "group") {
            if (!groupSelection.some((u) => u.user_id === userId)) {
                groupSelection.push({
                    user_id: userId,
                    username: button.dataset.username ?? "",
                    display_name: button.dataset.name ?? null,
                });
                renderGroupChips();
            }
            searchInput.value = "";
            searchResults.innerHTML = "";
            searchInput.focus();
            return;
        }

        button.disabled = true;
        await openWithUser(userId).catch((err) => {
            searchResults.innerHTML = '<div class="chat-search-empty"></div>';
            const empty = searchResults.querySelector(".chat-search-empty");
            if (empty) empty.textContent = errorText(err, "Erro ao abrir conversa.");
        });
    });

    groupCreate.addEventListener("click", async (event) => {
        event.stopPropagation();
        const title = groupTitleInput.value.trim();
        if (!title) {
            groupTitleInput.focus();
            toast("Dê um nome ao grupo.", "error");
            return;
        }
        groupCreate.disabled = true;
        try {
            const { conversationId } = await api<{ conversationId: string }>("/conversations/groups", {
                method: "POST",
                body: JSON.stringify({ title, userIds: groupSelection.map((u) => u.user_id) }),
            });
            widget.classList.remove("searching");
            await loadConversations();
            await openConversation(conversationId);
        } catch (err) {
            toast(errorText(err, "Não foi possível criar o grupo."), "error");
            groupCreate.disabled = false;
        }
    });

    /** Abre (ou cria) a conversa 1:1 com alguém e mostra o widget nela. */
    async function openWithUser(userId: string): Promise<void> {
        const { conversationId } = await api<{ conversationId: string }>("/conversations", {
            method: "POST",
            body: JSON.stringify({ userId }),
        });
        widget.classList.remove("searching");
        widget.classList.add("open");
        await loadConversations();
        await openConversation(conversationId);
        input.focus();
        scheduleNextTick();
    }

    // Outras páginas (botão "Enviar mensagem" do perfil) — ver chat-bus.ts.
    window.addEventListener(OPEN_CHAT_EVENT, (event) => {
        const detail = (event as CustomEvent<OpenChatDetail>).detail;
        if (detail?.userId) {
            void openWithUser(detail.userId).catch((err) => toast(errorText(err, "Não foi possível abrir a conversa."), "error"));
        }
    });

    // =====================================================================
    // Abrir / fechar
    // =====================================================================

    contactsEl.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        const target = event.target as Element | null;
        if (target?.closest("#chatContactsMore")) {
            void loadConversations(true);
            return;
        }
        const button = target?.closest<HTMLButtonElement>(".contact-item");
        const conversationId = button?.dataset.conversation;
        if (conversationId && conversationId !== active?.id) {
            void openConversation(conversationId);
        }
    });

    toggle.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        widget.classList.toggle("open");

        if (isOpen()) {
            void loadConversations().then(() => {
                // Abre direto na primeira conversa, como o protótipo fazia.
                if (!active && conversations.length > 0) {
                    void openConversation(conversations[0].conversation_id);
                } else {
                    renderMessages();
                    if (active) void markRead(active.id);
                }
            });
        }
        scheduleNextTick();
    });

    closeBtn.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        widget.classList.remove("open");
        widget.classList.remove("searching");
        scheduleNextTick();
    });

    document.addEventListener("click", (event: MouseEvent) => {
        const target = event.target;
        if (!isOpen() || !(target instanceof Element)) return;
        // Diálogos (apagar, remover, sair) ficam fora do widget mas fazem parte dele.
        if (widget.contains(target) || target.closest(".dialog-overlay")) return;
        widget.classList.remove("open");
        widget.classList.remove("searching");
        scheduleNextTick();
    });

    // =====================================================================
    // Boot
    // =====================================================================

    renderMessages();
    void loadConversations();
    scheduleNextTick();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function must<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`chat-widget: elemento #${id} não encontrado`);
    return element as T;
}

export {};
