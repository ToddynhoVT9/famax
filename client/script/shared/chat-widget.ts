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
 *
 * Moldura R: o ícone que abre o chat fica no header (#headerChatSlot, do
 * layout.ts), não mais flutuando no canto, onde cobria a última ação da
 * página. O painel abre de três jeitos, conforme a faixa (modoChat): ao lado
 * do conteúdo no desktop, por cima com véu no compacto e em tela cheia, com
 * Voltar, no tablet e no celular.
 */
// Importado aqui, não via <link> em cada página: assim o estilo acompanha o
// widget em qualquer HTML que carregue este módulo.
import "../../css/chat-widget.css";
import { api, getCurrentUserId, getToken } from "./api.js";
import { avatarColor, escapeHtml, initials, shortTime } from "./dom.js";
import { confirmDialog, toast } from "./dialog.js";
import { isRealtimeOpen, onRealtime, onRealtimeStatus } from "./realtime.js";
import { OPEN_CHAT_EVENT, type OpenChatDetail } from "./chat-bus.js";
import { skeleton } from "./skeleton.js";
import "./char-counter.js";
import { trapFocus } from "./focus-trap.js";
import { ICONS } from "./icons.js";
import { openSheet, whenLayoutReady } from "./layout.js";
import type { Conversation, Message as ApiMessage, Participant } from "../../../shared/api-types.js";
import type { UserSummary as UserResult } from "../../../shared/api-types.js";

/** Polling de reserva (stream fora): widget aberto / fechado. */
const POLL_OPEN_MS = 5_000;
const POLL_CLOSED_MS = 30_000;
/** No máximo um aviso de "digitando" a cada 3 s; some 4 s depois do último. */
const TYPING_SEND_MS = 3_000;
const TYPING_SHOW_MS = 4_000;
const HISTORY_PAGE = 30;

/** Mensagem como vem da API + o estado local de envio. */
interface Message extends ApiMessage {
    /** Só no cliente: enviando / falhou. */
    _state?: "pending" | "failed";
}

interface ActiveConversation {
    id: string;
    isGroup: boolean;
    title: string | null;
    myRole: "admin" | "member";
    participants: Participant[];
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
        <div class="chat-veil" id="chatVeil"></div>
        <div class="fx-chat-panel" id="chatPanel" role="dialog" aria-label="Chat bate-papo">
            <div class="fx-chat-head">
                <div class="chat-title">
                    <!-- Tela cheia (tablet e celular): Voltar no lugar do ✕. -->
                    <button type="button" class="fx-btn fx-btn--icon chat-back" id="chatBack" aria-label="Voltar">${ICONS.back}</button>
                    <div>
                        <h3>Mensagens</h3>
                        <p id="chatSubtitle">Converse com seus amigos</p>
                    </div>
                </div>
                <div class="chat-header-actions">
                    <button type="button" class="fx-btn fx-btn--icon" id="chatNewBtn" aria-label="Nova conversa" title="Nova conversa ou grupo">${ICONS.plus}</button>
                    <button type="button" class="fx-btn fx-btn--icon chat-close" id="chatClose" aria-label="Fechar chat">${ICONS.close}</button>
                </div>
            </div>
            <div class="fx-chat-search" id="chatSearch">
                <div class="chat-search-modes" role="group" aria-label="Tipo de conversa">
                    <button type="button" class="fx-chip fx-chip--paper" data-mode="direct" aria-pressed="true">Conversa</button>
                    <button type="button" class="fx-chip fx-chip--paper" data-mode="group" aria-pressed="false">Grupo</button>
                </div>
                <input class="fx-input fx-input--paper fx-input--pill" id="chatGroupTitle" type="text" placeholder="Nome do grupo" maxlength="80" hidden />
                <div class="fx-chat-chips" id="chatGroupChips" hidden></div>
                <input class="fx-input fx-input--paper fx-input--pill" id="chatSearchInput" type="text" placeholder="Buscar pessoa pelo nome ou @usuário" maxlength="50" />
                <div class="fx-chat-results" id="chatSearchResults"></div>
                <button type="button" class="fx-btn fx-btn--chrome fx-btn--sm fx-btn--pill" id="chatGroupCreate" hidden>Criar grupo</button>
            </div>
            <div class="fx-chat-body">
                <nav class="fx-contacts" id="chatContacts" aria-label="Conversas"></nav>
                <section class="fx-chat-conv">
                    <div class="fx-chat-conv-head" id="chatConvHeader" hidden>
                        <span class="chat-conv-title" id="chatConvTitle"></span>
                        <button type="button" class="fx-btn fx-btn--icon fx-btn--icon-paper" id="chatGroupBtn" hidden aria-label="Detalhes do grupo" title="Detalhes do grupo">${ICONS.info}</button>
                    </div>
                    <div class="fx-chat-msgs" id="chatMessages" aria-live="polite"></div>
                    <div class="chat-group-panel" id="chatGroupPanel" hidden></div>
                    <div class="fx-typing" id="chatTyping" hidden></div>
                    <form class="fx-chat-input" id="chatForm">
                        <input class="fx-input fx-input--paper fx-input--pill" id="chatInput" type="text" placeholder="Digite uma mensagem..." maxlength="2000" data-char-counter="near" disabled aria-label="Mensagem" />
                        <button type="submit" class="fx-btn fx-btn--chrome fx-btn--pill" id="chatSend" disabled>Enviar</button>
                    </form>
                </section>
            </div>
        </div>
    `;
    document.body.appendChild(widget);

    // O ícone do chat vai para o header (layout.ts reserva o lugar, entre o
    // sino e o avatar). Fica no widget até o header existir: no build, este
    // módulo pode rodar antes do initLayout da página (ver whenLayoutReady).
    const toggle = el("button", "fx-btn fx-btn--icon r-chat-btn");
    toggle.type = "button";
    toggle.id = "chatToggle";
    toggle.setAttribute("aria-label", "Abrir chat");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "chatPanel");
    toggle.innerHTML = `${ICONS.chat}<span class="fx-counter-badge" id="chatUnreadBadge" aria-hidden="true" hidden></span>`;
    widget.append(toggle);
    whenLayoutReady(() => document.getElementById("headerChatSlot")?.append(toggle));

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
        c.isGroup
            ? c.title?.trim() || "Grupo"
            : c.otherDisplayName?.trim() || c.otherUsername || "Conversa";

    function avatarHtml(id: string | null, name: string, url: string | null, className: string): string {
        if (url) {
            return `<span class="${className}"><img src="${escapeHtml(url)}" alt="" /></span>`;
        }
        return `<span class="${className} ${avatarColor(id)}">${escapeHtml(initials(name))}</span>`;
    }

    function renderContacts(): void {
        if (conversations.length === 0) {
            contactsEl.innerHTML = '<p class="fx-chat-empty">Nenhuma conversa</p>';
            return;
        }

        contactsEl.innerHTML =
            conversations
                .map((conversation) => {
                    const name = conversationName(conversation);
                    const unread =
                        conversation.unreadCount > 0
                            ? `<span class="fx-counter-badge">${conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>`
                            : "";
                    const avatar = conversation.isGroup
                        ? `<span class="fx-avatar fx-avatar--md chat-avatar-group" aria-hidden="true">👥</span>`
                        : avatarHtml(conversation.otherUserId, name, conversation.otherAvatarUrl, "fx-avatar fx-avatar--md");
                    const current = conversation.conversationId === active?.id ? ' aria-current="true"' : "";
                    return `
                    <button type="button" class="fx-contact"${current}
                            data-conversation="${escapeHtml(conversation.conversationId)}" title="${escapeHtml(name)}">
                        ${unread}
                        ${avatar}
                        <span class="fx-contact-name">${escapeHtml(name)}</span>
                    </button>`;
                })
                .join("") +
            (conversationsCursor
                ? '<button type="button" class="fx-btn fx-btn--link chat-contacts-more" id="chatContactsMore">Mais</button>'
                : "");
    }

    function renderHeader(): void {
        if (!active) {
            convHeader.hidden = true;
            return;
        }
        const conversation = conversations.find((c) => c.conversationId === active!.id);
        const others = active.participants.filter((p) => p.userId !== currentUserId);
        const name = active.isGroup
            ? active.title?.trim() || "Grupo"
            : conversation
              ? conversationName(conversation)
              : others[0]?.displayName?.trim() || others[0]?.username || "Conversa";
        convTitle.textContent = active.isGroup ? `${name} · ${active.participants.length} pessoas` : name;
        groupBtn.hidden = !active.isGroup;
        convHeader.hidden = false;
    }

    /** Quantos outros participantes já leram até esta mensagem. */
    function seenCount(message: Message): number {
        if (!active) return 0;
        const at = new Date(message.createdAt).getTime();
        return active.participants.filter(
            (p) => p.userId !== currentUserId && new Date(p.lastReadAt).getTime() >= at,
        ).length;
    }

    function messageHtml(message: Message, previous: Message | undefined, seenLabel: string | null): string {
        if (message.kind === "system") {
            return `<div class="fx-msg-system">${escapeHtml(message.content ?? "")}</div>`;
        }
        const mine = message.senderId === currentUserId;
        const id = escapeHtml(message.messageId);

        // O estado vai em palavras na linha da hora, sempre na cor cheia da
        // bolha (com opacidade a hora e o "enviando..." ficavam abaixo de 4.5:1).
        let body: string;
        let meta: string;
        if (message.isDeleted) {
            body = "mensagem apagada";
            meta = escapeHtml(shortTime(message.createdAt));
        } else {
            body = escapeHtml(message.content ?? "");
            if (message._state === "failed") {
                meta = `não enviada ·
                    <button type="button" class="chat-link" data-action="retry" data-id="${id}">Tentar de novo</button> ·
                    <button type="button" class="chat-link" data-action="discard" data-id="${id}">Descartar</button>`;
            } else if (message._state === "pending") {
                meta = "enviando...";
            } else {
                meta = escapeHtml(shortTime(message.createdAt));
            }
        }

        const classes = ["fx-bubble", mine ? "fx-bubble--me" : "fx-bubble--other"];
        if (message.isDeleted) classes.push("fx-bubble--deleted");
        if (message._state) classes.push(`is-${message._state}`);
        const bubble = `<div class="${classes.join(" ")}">${body}<span class="fx-msg-time">${meta}</span></div>`;
        const seen = seenLabel ? `<div class="fx-msg-seen">${escapeHtml(seenLabel)}</div>` : "";

        // Grupo: avatar e nome de quem mandou (só no começo de uma sequência).
        if (!mine && active?.isGroup) {
            const name = message.senderDisplayName?.trim() || message.senderUsername || "Alguém";
            const firstOfRun = previous?.senderId !== message.senderId || previous?.kind === "system";
            return `
                <div class="fx-msg-row${firstOfRun ? "" : " is-continued"}">
                    ${firstOfRun ? avatarHtml(message.senderId, name, message.senderAvatarUrl, "fx-avatar fx-avatar--xs") : '<span class="chat-avatar-space"></span>'}
                    <div class="fx-msg-stack">
                        ${firstOfRun ? `<span class="fx-msg-sender">${escapeHtml(name)}</span>` : ""}
                        ${bubble}
                    </div>
                </div>`;
        }

        // Sua mensagem já enviada: o ⋯ ao lado da bolha, com "Apagar". A
        // pendente, a que falhou e a apagada não têm o que apagar.
        if (mine && !message._state && !message.isDeleted) {
            return `
                <div class="fx-msg-row chat-msg-row-me">
                    ${bubble}
                    <div class="chat-msg-menu" data-msg-menu>
                        <button type="button" class="fx-btn fx-btn--icon fx-btn--icon-paper" data-action="msg-menu" data-id="${id}"
                                aria-haspopup="menu" aria-expanded="false" aria-label="Opções da mensagem">${ICONS.dots}</button>
                        <div class="fx-menu" role="menu" aria-label="Opções da mensagem" hidden>
                            <button type="button" class="fx-menu-item fx-menu-item--danger" role="menuitem" data-action="delete" data-id="${id}">Apagar</button>
                        </div>
                    </div>
                </div>${seen}`;
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
            if (m.senderId !== currentUserId || m.kind !== "text" || m._state || m.isDeleted) continue;
            const count = seenCount(m);
            if (count > 0) {
                seenIndex = i;
                seenLabel = active.isGroup ? `Visto por ${count}` : "Visto";
            }
            break;
        }

        // O redesenho troca todos os botões: o foco num deles (⋯, "Tentar de
        // novo") volta ao mesmo botão da mensagem, se ele continuar existindo.
        const focused = messagesEl.contains(document.activeElement)
            ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-action][data-id]")
            : null;
        const refocus = focused ? { action: focused.dataset.action, id: focused.dataset.id } : null;

        const top = hasOlder
            ? '<div class="chat-history-hint">Role para cima para ver mensagens anteriores</div>'
            : '<div class="chat-history-hint">Início da conversa</div>';
        messagesEl.innerHTML =
            top +
            messages
                .map((message, index) => messageHtml(message, messages[index - 1], index === seenIndex ? seenLabel : null))
                .join("");

        if (refocus) {
            const find = (action: string | undefined): HTMLElement | undefined =>
                Array.from(messagesEl.querySelectorAll<HTMLElement>("[data-action][data-id]")).find(
                    (b) => b.dataset.action === action && b.dataset.id === refocus.id && b.getClientRects().length > 0,
                );
            // O menu aberto fecha no redesenho: quem estava num item volta ao ⋯.
            (find(refocus.action) ?? find("msg-menu"))?.focus();
        }

        if (scroll === "bottom" || (scroll === "auto" && nearBottom)) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (scroll === "keep") {
            messagesEl.scrollTop = messagesEl.scrollHeight - previousHeight + previousTop;
        }
    }

    function renderBadge(): void {
        badge.textContent = unreadTotal > 99 ? "99+" : String(unreadTotal);
        badge.hidden = unreadTotal === 0;
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
            const page = await api.conversations.list({ limit: 30, cursor: more ? conversationsCursor : null });
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
            const { conversation, participants } = await api.conversations.get(conversationId);
            if (active?.id !== conversationId) return true;
            active = {
                id: conversationId,
                isGroup: conversation.isGroup,
                title: conversation.title,
                myRole: conversation.myRole,
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

        messagesEl.replaceChildren(skeleton("message", 4, "Carregando mensagens..."));
        setInputEnabled(true);

        try {
            const [page] = await Promise.all([
                api.conversations.messages(conversationId, { limit: HISTORY_PAGE }),
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
            if (status) status.textContent = errorText(err, "Não foi possível carregar as mensagens.");
        }
    }

    /** Histórico: busca a página anterior à primeira mensagem na tela. */
    async function loadOlder(): Promise<void> {
        const conversationId = active?.id;
        const first = messages.find((m) => !m._state);
        if (!conversationId || !first || !hasOlder || loadingOlder) return;
        loadingOlder = true;
        try {
            const page = await api.conversations.messages(conversationId, { limit: HISTORY_PAGE, beforeId: first.messageId });
            if (active?.id !== conversationId) return;
            const known = new Set(messages.map((m) => m.messageId));
            messages = page.data.filter((m) => !known.has(m.messageId)).concat(messages);
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
            await api.conversations.markRead(conversationId);
            const conversation = conversations.find((c) => c.conversationId === conversationId);
            if (conversation && conversation.unreadCount > 0) {
                unreadTotal = Math.max(0, unreadTotal - conversation.unreadCount);
                conversation.unreadCount = 0;
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
            const query = last ? `after=${encodeURIComponent(last.createdAt)}` : `limit=${HISTORY_PAGE}`;
            const { data } = await api.conversations.messages(conversationId, last ? { after: last.createdAt } : { limit: HISTORY_PAGE });
            if (active?.id !== conversationId) return;
            // Descarta o que já está na tela: o eco da própria mensagem
            // confirmada chegaria duplicado.
            const known = new Set(messages.map((m) => m.messageId));
            const fresh = data.filter((m) => !known.has(m.messageId));
            if (fresh.length === 0) return;
            const pending = messages.filter((m) => m._state);
            messages = confirmed.concat(fresh, pending);
            // Quem mandou a mensagem parou de digitar.
            for (const m of fresh) typing.delete(m.senderId);
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
            const message = messages.find((m) => m.messageId === data.messageId);
            if (message) {
                message.isDeleted = true;
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
        const participant = active.participants.find((p) => p.userId === data.userId);
        if (participant && typeof data.lastReadAt === "string") {
            participant.lastReadAt = data.lastReadAt;
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
        const conversationId = message.conversationId;
        message._state = "pending";
        renderMessages("bottom");
        try {
            const { message: saved } = await api.conversations.send(conversationId, message.content ?? "");
            if (active?.id !== conversationId) return;
            const index = messages.findIndex((m) => m.messageId === message.messageId);
            // O evento SSE pode ter trazido a mesma mensagem antes da resposta.
            const already = messages.some((m) => m.messageId === saved.messageId);
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
            console.error("Não foi possível enviar.", err);
        }
    }

    form.addEventListener("submit", (event: SubmitEvent) => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content || !active) return;

        // Render otimista: aparece na hora, marcada como enviando, e é
        // substituída pela versão confirmada do servidor.
        const optimistic: Message = {
            messageId: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            conversationId: active.id,
            senderId: currentUserId!,
            kind: "text",
            content,
            isDeleted: false,
            createdAt: new Date().toISOString(),
            senderUsername: null,
            senderDisplayName: null,
            senderAvatarUrl: null,
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
        void api.conversations.typing(active.id).catch(() => {});
    });

    // ----- ⋯ da mensagem -----------------------------------------------------
    // Em lista de 1024px para cima; abaixo, numa folha inferior, como o ⋯ do
    // post aberto (post-thread.ts).
    const sheetMedia = window.matchMedia("(max-width: 1023px)");

    function closeMessageMenus(except?: Element): void {
        messagesEl.querySelectorAll<HTMLElement>('[data-msg-menu] > [role="menu"]:not([hidden])').forEach((menu) => {
            if (except && menu.parentElement?.contains(except)) return;
            // O foco num item que vai sumir volta ao ⋯ (e a confirmação que o
            // item abrir devolve o foco a ele).
            const toggle = menu.previousElementSibling as HTMLElement | null;
            if (menu.contains(document.activeElement)) toggle?.focus();
            menu.hidden = true;
            menu.classList.remove("is-up");
            toggle?.setAttribute("aria-expanded", "false");
        });
    }

    function toggleMessageMenu(button: HTMLElement): void {
        const menu = button.nextElementSibling as HTMLElement | null;
        if (!menu) return;
        closeMessageMenus(button);
        if (sheetMedia.matches) {
            // Os itens da folha são cópias: o clique fecha a folha (o foco
            // volta ao ⋯) e repete o clique no item original, que segue pela
            // delegação abaixo como na lista.
            const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((original) => {
                const copy = original.cloneNode(true) as HTMLElement;
                copy.addEventListener("click", () => {
                    close();
                    original.click();
                });
                return copy;
            });
            const title = el("span", "r-sheet-name", "Opções da mensagem");
            const close = openSheet({ label: "Opções da mensagem", menuLabel: "Opções da mensagem", head: [title], items, opener: button });
            return;
        }
        menu.hidden = !menu.hidden;
        button.setAttribute("aria-expanded", String(!menu.hidden));
        if (menu.hidden) return;
        // Perto do fim da área das mensagens, o menu abre para cima.
        menu.classList.toggle("is-up", menu.getBoundingClientRect().bottom > messagesEl.getBoundingClientRect().bottom);
    }

    // Clique fora fecha (na captura: o widget para a propagação de vários cliques).
    document.addEventListener(
        "click",
        (event) => {
            const target = event.target as Element | null;
            closeMessageMenus(target?.closest("[data-msg-menu]") ?? undefined);
        },
        true,
    );

    // Esc com o menu aberto fecha só o menu. Registrado antes da armadilha de
    // foco do painel (que fecharia o chat), por isso corre primeiro e a para.
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Escape") return;
            if (!messagesEl.querySelector('[data-msg-menu] > [role="menu"]:not([hidden])')) return;
            event.stopImmediatePropagation();
            const open = messagesEl.querySelector<HTMLElement>('[data-msg-menu] > [role="menu"]:not([hidden])');
            const toggle = open?.previousElementSibling as HTMLElement | null;
            closeMessageMenus();
            toggle?.focus();
        },
        true,
    );

    messagesEl.addEventListener("click", async (event: MouseEvent) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-action]");
        const id = button?.dataset.id;
        const message = id ? messages.find((m) => m.messageId === id) : undefined;
        if (!button || !message || !active) return;
        event.stopPropagation();

        switch (button.dataset.action) {
            case "msg-menu":
                toggleMessageMenu(button);
                return;
            case "retry":
                void deliver(message);
                return;
            case "discard":
                messages = messages.filter((m) => m !== message);
                renderMessages();
                return;
            case "delete": {
                closeMessageMenus();
                const ok = await confirmDialog({
                    title: "Apagar mensagem?",
                    message: "Ela some para todos e fica no lugar o aviso “mensagem apagada”.",
                    confirmLabel: "Apagar",
                    danger: true,
                });
                if (!ok) return;
                try {
                    await api.conversations.deleteMessage(message.conversationId, message.messageId);
                    message.isDeleted = true;
                    message.content = null;
                    renderMessages();
                    // A apagada não tem mais o ⋯: o foco vai para o campo.
                    input.focus();
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
        return p.displayName?.trim() || p.username;
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
        const title = el("h4", "", "Detalhes do grupo");
        const close = el("button", "fx-btn fx-btn--icon fx-btn--icon-paper");
        close.innerHTML = ICONS.close;
        close.type = "button";
        close.setAttribute("aria-label", "Fechar detalhes");
        close.addEventListener("click", () => {
            groupPanel.hidden = true;
        });
        head.append(title, close);
        groupPanel.append(head);

        if (isAdmin) {
            const rename = el("form", "chat-group-rename");
            const field = el("input", "fx-input fx-input--paper fx-input--pill");
            field.value = active.title ?? "";
            field.maxLength = 80;
            field.setAttribute("aria-label", "Nome do grupo");
            const save = el("button", "fx-btn fx-btn--chrome fx-btn--sm fx-btn--pill", "Renomear");
            save.type = "submit";
            rename.append(field, save);
            rename.addEventListener("submit", async (event) => {
                event.preventDefault();
                const value = field.value.trim();
                if (!value || value === active?.title) return;
                save.disabled = true;
                try {
                    await api.conversations.rename(conversationId, value);
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
            const label = el("span", "", participantName(p) + (p.userId === currentUserId ? " (você)" : ""));
            item.append(label);
            if (p.role === "admin") item.append(el("span", "chat-group-role", "admin"));
            if (isAdmin && p.userId !== currentUserId) {
                const remove = el("button", "chat-link chat-link--danger", "Remover");
                remove.type = "button";
                remove.setAttribute("aria-label", `Remover ${participantName(p)}`);
                remove.addEventListener("click", async () => {
                    const ok = await confirmDialog({
                        title: "Remover do grupo?",
                        message: `${participantName(p)} deixa de ver as mensagens do grupo.`,
                        confirmLabel: "Remover",
                        danger: true,
                    });
                    if (!ok) return;
                    try {
                        await api.conversations.removeParticipant(conversationId, p.userId);
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
            const addInput = el("input", "fx-input fx-input--paper fx-input--pill");
            addInput.placeholder = "Adicionar pessoa: nome ou @usuário";
            addInput.maxLength = 50;
            addInput.setAttribute("aria-label", "Adicionar pessoa ao grupo");
            const results = el("div", "fx-chat-results");
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
                    const inGroup = new Set(active?.participants.map((p) => p.userId));
                    results.replaceChildren(
                        ...found
                            .filter((u) => !inGroup.has(u.userId))
                            .map((u) => {
                                const button = el("button", "fx-chat-result");
                                button.innerHTML = resultHtml(u);
                                button.type = "button";
                                button.addEventListener("click", async () => {
                                    button.disabled = true;
                                    try {
                                        await api.conversations.addParticipants(conversationId, [u.userId]);
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

        const leave = el("button", "fx-btn fx-btn--outline-danger fx-btn--sm fx-btn--pill chat-group-leave", "Sair do grupo");
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
                await api.conversations.removeParticipant(conversationId, currentUserId!);
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

    /** Linha do resultado: avatar, nome e @usuário (já escapados). */
    function resultHtml(user: UserResult): string {
        const name = user.displayName?.trim() || user.username;
        return `${avatarHtml(user.userId, name, null, "fx-avatar fx-avatar--xs")}
                <span>${escapeHtml(name)} <span class="chat-result-handle">@${escapeHtml(user.username)}</span></span>`;
    }

    async function searchUsers(term: string): Promise<UserResult[]> {
        try {
            const { data } = await api.users.search(term);
            return data;
        } catch {
            return [];
        }
    }

    function setSearchMode(mode: "direct" | "group"): void {
        searchMode = mode;
        widget.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
            const on = b.dataset.mode === mode;
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
                const chip = el("button", "fx-chat-chip", `${u.displayName?.trim() || u.username} ×`);
                chip.type = "button";
                chip.setAttribute("aria-label", `Tirar ${u.displayName?.trim() || u.username}`);
                chip.addEventListener("click", (event) => {
                    event.stopPropagation();
                    groupSelection = groupSelection.filter((s) => s.userId !== u.userId);
                    renderGroupChips();
                });
                return chip;
            }),
        );
        groupCreate.disabled = groupSelection.length === 0;
    }

    widget.querySelector(".chat-search-modes")?.addEventListener("click", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-mode]");
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
            searchResults.innerHTML = '<p class="fx-chat-empty">Digite ao menos 2 caracteres</p>';
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
                        <button type="button" class="fx-chat-result" data-user="${escapeHtml(user.userId)}"
                                data-name="${escapeHtml(user.displayName?.trim() || user.username)}" data-username="${escapeHtml(user.username)}">
                            ${resultHtml(user)}
                        </button>`,
                          )
                          .join("")
                    : '<p class="fx-chat-empty">Ninguém encontrado</p>';
        }, 300);
    });

    searchResults.addEventListener("click", async (event: MouseEvent) => {
        event.stopPropagation();
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".fx-chat-result");
        const userId = button?.dataset.user;
        if (!button || !userId) return;

        if (searchMode === "group") {
            if (!groupSelection.some((u) => u.userId === userId)) {
                groupSelection.push({
                    userId: userId,
                    username: button.dataset.username ?? "",
                    displayName: button.dataset.name ?? null,
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
            searchResults.innerHTML = '<p class="fx-chat-empty"></p>';
            const empty = searchResults.querySelector(".fx-chat-empty");
            if (empty) empty.textContent = errorText(err, "Não foi possível abrir a conversa.");
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
            const { conversationId } = await api.conversations.createGroup(title, groupSelection.map((u) => u.userId));
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
        const { conversationId } = await api.conversations.open(userId);
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
        const button = target?.closest<HTMLButtonElement>(".fx-contact");
        const conversationId = button?.dataset.conversation;
        if (conversationId && conversationId !== active?.id) {
            void openConversation(conversationId);
        }
    });

    toggle.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        widget.classList.toggle("open");

        if (isOpen()) {
            // Foco para dentro do painel (teclado e leitor de tela vão junto).
            closeControl().focus();
            void loadConversations().then(() => {
                // Abre direto na primeira conversa, como o protótipo fazia.
                if (!active && conversations.length > 0) {
                    void openConversation(conversations[0].conversationId);
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
        toggle.focus();
    });

    // Esc dentro do painel fecha (um diálogo aberto por cima trata o próprio Esc).
    widget.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Escape" || !isOpen() || document.querySelector(".fx-overlay:not([hidden])")) return;
        closeBtn.click();
    });

    // Ao lado (desktop), por cima com véu (compacto) ou em tela cheia (tablet
    // e celular). Por cima e em tela cheia o painel cobre a página: vira
    // modal, com o foco preso dentro. Ao lado ele divide a tela com a página.
    type ModoChat = "ao-lado" | "por-cima" | "tela-cheia";
    const desktop = window.matchMedia("(min-width: 1280px)");
    const compacto = window.matchMedia("(min-width: 1024px)");
    const modoChat = (): ModoChat => (desktop.matches ? "ao-lado" : compacto.matches ? "por-cima" : "tela-cheia");
    const panel = must<HTMLElement>("chatPanel");
    // Em tela cheia quem fecha é o Voltar; nos outros modos, o ✕ (CSS esconde o outro).
    const closeControl = (): HTMLButtonElement =>
        modoChat() === "tela-cheia" ? must<HTMLButtonElement>("chatBack") : closeBtn;
    let releasePanel: (() => void) | null = null;
    const syncPanelTrap = (): void => {
        widget.dataset.modo = modoChat();
        const trap = isOpen() && modoChat() !== "ao-lado";
        if (trap && !releasePanel) {
            panel.setAttribute("aria-modal", "true");
            const inside = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement) : closeControl();
            releasePanel = trapFocus(panel, { onEscape: () => closeBtn.click(), initialFocus: inside });
        } else if (!trap && releasePanel) {
            panel.removeAttribute("aria-modal");
            const release = releasePanel;
            releasePanel = null;
            release();
        }
    };
    desktop.addEventListener("change", syncPanelTrap);
    compacto.addEventListener("change", syncPanelTrap);
    widget.dataset.modo = modoChat();

    // Voltar (tela cheia) e o véu (por cima) fecham como o ✕.
    must<HTMLButtonElement>("chatBack").addEventListener("click", () => closeBtn.click());
    must<HTMLElement>("chatVeil").addEventListener("click", () => closeBtn.click());

    // aria-expanded do botão acompanha a classe "open", venha de onde vier.
    new MutationObserver(() => {
        const open = isOpen();
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Fechar chat" : "Abrir chat");
        document.body.classList.toggle("chat-is-open", open);
        syncPanelTrap();
    }).observe(widget, { attributes: true, attributeFilter: ["class"] });

    // Clique fora não fecha: ao lado, o painel fica aberto enquanto a pessoa
    // usa a página; por cima, quem fecha é o véu; em tela cheia não há "fora".

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
