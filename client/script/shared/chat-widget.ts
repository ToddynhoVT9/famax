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
 * Transporte: polling com cursor (ver §3.1 do plano). O tick pausa quando a
 * aba está em background — sem isso, cada aba aberta geraria 20 req/min para
 * sempre.
 */
// Importado aqui, não via <link> em cada página: assim o estilo acompanha o
// widget em qualquer HTML que carregue este módulo.
import "../../css/chat-widget.css";
import { api, getCurrentUserId, getToken } from "./api.js";
import { escapeHtml, initials, shortTime } from "./dom.js";

const POLL_OPEN_MS = 3_000;
const POLL_CLOSED_MS = 15_000;

interface Conversation {
    conversation_id: string;
    last_message_at: string;
    other_user_id: string;
    other_username: string;
    other_display_name: string | null;
    last_message_content: string | null;
    unread_count: number;
}

interface Message {
    message_id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    created_at: string;
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
                    <p>Converse com seus amigos</p>
                </div>
                <div class="chat-header-actions">
                    <button class="chat-header-btn" id="chatNewBtn" aria-label="Nova conversa" title="Nova conversa">＋</button>
                    <button class="chat-header-btn" id="chatClose" aria-label="Fechar chat">✕</button>
                </div>
            </div>
            <div class="chat-search" id="chatSearch">
                <input id="chatSearchInput" type="text" placeholder="Buscar pessoa pelo nome ou @usuário" maxlength="50" />
                <div class="chat-search-results" id="chatSearchResults"></div>
            </div>
            <div class="chat-body">
                <aside class="chat-contacts" id="chatContacts"></aside>
                <section class="chat-conversation">
                    <div class="chat-messages" id="chatMessages"></div>
                    <form class="chat-input-row" id="chatForm">
                        <input id="chatInput" type="text" placeholder="Digite uma mensagem..." maxlength="2000" disabled />
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

    let conversations: Conversation[] = [];
    let activeId: string | null = null;
    let messages: Message[] = [];
    /** created_at da última mensagem conhecida — cursor do polling. */
    let cursor: string | null = null;
    let pollTimer: number | null = null;
    let searchTimer: number | null = null;

    // --- Render -----------------------------------------------------------

    const contactName = (conversation: Conversation): string =>
        conversation.other_display_name?.trim() || conversation.other_username;

    function renderContacts(): void {
        if (conversations.length === 0) {
            contactsEl.innerHTML =
                '<div class="chat-search-empty">Nenhuma conversa</div>';
            return;
        }

        contactsEl.innerHTML = conversations
            .map((conversation) => {
                const name = contactName(conversation);
                const unread =
                    conversation.unread_count > 0
                        ? `<span class="contact-unread">${conversation.unread_count > 99 ? "99+" : conversation.unread_count}</span>`
                        : "";

                return `
                    <button type="button" class="contact-item ${conversation.conversation_id === activeId ? "active" : ""}"
                            data-conversation="${escapeHtml(conversation.conversation_id)}" title="${escapeHtml(name)}">
                        ${unread}
                        <span class="contact-avatar">${escapeHtml(initials(name))}</span>
                        <span class="contact-name">${escapeHtml(name)}</span>
                    </button>
                `;
            })
            .join("");
    }

    function renderMessages(animate = false): void {
        if (!activeId) {
            messagesEl.innerHTML =
                '<div class="chat-status">Escolha uma conversa ou use ＋ para começar uma nova.</div>';
            return;
        }

        if (messages.length === 0) {
            messagesEl.innerHTML =
                '<div class="chat-status">Nenhuma mensagem ainda. Diga oi!</div>';
            return;
        }

        messagesEl.classList.remove("is-changing");
        messagesEl.innerHTML = messages
            .map((message) => {
                const mine = message.sender_id === currentUserId;
                const state = (message as Message & { _state?: string })._state;
                const extra = state === "pending" ? " pending" : state === "failed" ? " failed" : "";

                return `
                    <div class="message-bubble ${mine ? "me" : "other"}${extra}">${escapeHtml(message.content)}<span class="message-time">${escapeHtml(
                        state === "failed" ? "não enviada" : shortTime(message.created_at),
                    )}</span></div>
                `;
            })
            .join("");

        messagesEl.scrollTop = messagesEl.scrollHeight;
        if (animate) {
            requestAnimationFrame(() => messagesEl.classList.add("is-changing"));
        }
    }

    function renderBadge(): void {
        const total = conversations.reduce((sum, c) => sum + c.unread_count, 0);
        badge.textContent = total > 99 ? "99+" : String(total);
        badge.classList.toggle("show", total > 0);
    }

    // --- Dados ------------------------------------------------------------

    async function loadConversations(): Promise<void> {
        try {
            const { data } = await api<{ data: Conversation[] }>("/conversations");
            conversations = data;
            renderContacts();
            renderBadge();
        } catch {
            // Rede instável não deve quebrar a página que hospeda o widget.
        }
    }

    async function openConversation(conversationId: string): Promise<void> {
        activeId = conversationId;
        messages = [];
        cursor = null;
        renderContacts();

        messagesEl.innerHTML = '<div class="chat-status">Carregando...</div>';
        input.disabled = false;
        sendBtn.disabled = false;

        try {
            const { data } = await api<{ data: Message[] }>(
                `/conversations/${conversationId}/messages?limit=50`,
            );
            messages = data;
            cursor = data.length > 0 ? data[data.length - 1].created_at : null;
            renderMessages(true);
            await markRead(conversationId);
        } catch (err) {
            messagesEl.innerHTML = '<div class="chat-status"></div>';
            const status = messagesEl.querySelector(".chat-status");
            if (status) {
                status.textContent =
                    err instanceof Error ? err.message : "Erro ao carregar mensagens.";
            }
        }
    }

    async function markRead(conversationId: string): Promise<void> {
        try {
            await api(`/conversations/${conversationId}/read`, { method: "POST" });
            const conversation = conversations.find(
                (c) => c.conversation_id === conversationId,
            );
            if (conversation) {
                conversation.unread_count = 0;
                renderContacts();
                renderBadge();
            }
        } catch {
            // O badge se corrige no próximo tick.
        }
    }

    /** Busca só o delta desde o cursor — é o que mantém o tick barato. */
    async function pollActiveMessages(): Promise<void> {
        if (!activeId || !cursor) return;

        try {
            const { data } = await api<{ data: Message[] }>(
                `/conversations/${activeId}/messages?after=${encodeURIComponent(cursor)}`,
            );
            if (data.length === 0) return;

            // Descarta o que já está na tela: o eco da própria mensagem
            // confirmada chegaria duplicado.
            const known = new Set(messages.map((m) => m.message_id));
            const fresh = data.filter((m) => !known.has(m.message_id));
            if (fresh.length === 0) return;

            messages = messages.concat(fresh);
            cursor = fresh[fresh.length - 1].created_at;
            renderMessages();
            await markRead(activeId);
        } catch {
            // Ignora falhas de tick; o próximo tenta de novo.
        }
    }

    // --- Polling ----------------------------------------------------------

    function scheduleNextTick(): void {
        if (pollTimer !== null) {
            window.clearTimeout(pollTimer);
            pollTimer = null;
        }

        // Aba em background não gera tráfego.
        if (document.hidden) return;

        const isOpen = widget.classList.contains("open");
        const delay = isOpen ? POLL_OPEN_MS : POLL_CLOSED_MS;

        pollTimer = window.setTimeout(async () => {
            if (widget.classList.contains("open")) {
                await pollActiveMessages();
            }
            await loadConversations();
            scheduleNextTick();
        }, delay);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (pollTimer !== null) {
                window.clearTimeout(pollTimer);
                pollTimer = null;
            }
        } else {
            void loadConversations();
            scheduleNextTick();
        }
    });

    // --- Envio ------------------------------------------------------------

    form.addEventListener("submit", async (event: SubmitEvent) => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content || !activeId) return;

        const conversationId = activeId;

        // Render otimista: a mensagem aparece imediatamente, marcada como
        // pendente, e é substituída pela versão confirmada do servidor.
        const tempId = `temp-${Date.now()}`;
        const optimistic: Message & { _state?: string } = {
            message_id: tempId,
            conversation_id: conversationId,
            sender_id: currentUserId!,
            content,
            created_at: new Date().toISOString(),
            _state: "pending",
        };
        messages.push(optimistic);
        renderMessages();
        input.value = "";

        try {
            const { message } = await api<{ message: Message }>(
                `/conversations/${conversationId}/messages`,
                { method: "POST", body: JSON.stringify({ content }) },
            );

            const index = messages.findIndex((m) => m.message_id === tempId);
            if (index !== -1) messages[index] = message;
            if (conversationId === activeId) {
                cursor = message.created_at;
                renderMessages();
            }
            void loadConversations();
        } catch (err) {
            const failed = messages.find((m) => m.message_id === tempId) as
                | (Message & { _state?: string })
                | undefined;
            if (failed) failed._state = "failed";
            renderMessages();
            console.error("Falha ao enviar mensagem:", err);
        }
    });

    // --- Nova conversa ----------------------------------------------------

    newBtn.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        widget.classList.toggle("searching");
        if (widget.classList.contains("searching")) {
            searchInput.value = "";
            searchResults.innerHTML = "";
            searchInput.focus();
        }
    });

    searchInput.addEventListener("input", () => {
        if (searchTimer !== null) window.clearTimeout(searchTimer);
        const term = searchInput.value.trim();

        if (term.length < 2) {
            searchResults.innerHTML =
                '<div class="chat-search-empty">Digite ao menos 2 caracteres</div>';
            return;
        }

        // Debounce: sem isso cada tecla vira uma query com ILIKE.
        searchTimer = window.setTimeout(async () => {
            try {
                const { data } = await api<{ data: UserResult[] }>(
                    `/users?search=${encodeURIComponent(term)}`,
                );

                searchResults.innerHTML =
                    data.length > 0
                        ? data
                              .map(
                                  (user) => `
                            <button type="button" class="chat-search-item" data-user="${escapeHtml(user.user_id)}">
                                ${escapeHtml(user.display_name?.trim() || user.username)}
                                <span class="chat-search-empty">@${escapeHtml(user.username)}</span>
                            </button>`,
                              )
                              .join("")
                        : '<div class="chat-search-empty">Ninguém encontrado</div>';
            } catch {
                searchResults.innerHTML =
                    '<div class="chat-search-empty">Erro na busca</div>';
            }
        }, 300);
    });

    searchResults.addEventListener("click", async (event: MouseEvent) => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
            ".chat-search-item",
        );
        const userId = button?.dataset.user;
        if (!userId) return;

        button!.disabled = true;
        try {
            const { conversationId } = await api<{ conversationId: string }>(
                "/conversations",
                { method: "POST", body: JSON.stringify({ userId }) },
            );

            widget.classList.remove("searching");
            await loadConversations();
            await openConversation(conversationId);
        } catch (err) {
            searchResults.innerHTML = '<div class="chat-search-empty"></div>';
            const empty = searchResults.querySelector(".chat-search-empty");
            if (empty) {
                empty.textContent =
                    err instanceof Error ? err.message : "Erro ao abrir conversa.";
            }
        }
    });

    // --- Abrir / fechar ---------------------------------------------------

    contactsEl.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
            ".contact-item",
        );
        const conversationId = button?.dataset.conversation;
        if (conversationId && conversationId !== activeId) {
            void openConversation(conversationId);
        }
    });

    toggle.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        widget.classList.toggle("open");

        if (widget.classList.contains("open")) {
            void loadConversations().then(() => {
                // Abre direto na primeira conversa, como o protótipo fazia.
                if (!activeId && conversations.length > 0) {
                    void openConversation(conversations[0].conversation_id);
                } else {
                    renderMessages();
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
        if (
            widget.classList.contains("open") &&
            event.target instanceof Node &&
            !widget.contains(event.target)
        ) {
            widget.classList.remove("open");
            widget.classList.remove("searching");
            scheduleNextTick();
        }
    });

    // --- Boot -------------------------------------------------------------

    renderMessages();
    void loadConversations();
    scheduleNextTick();
}

function must<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`chat-widget: elemento #${id} não encontrado`);
    return element as T;
}

export {};
