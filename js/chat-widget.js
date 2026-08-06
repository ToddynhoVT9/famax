(function () {
    const blockedPages = ['login.html', 'cadastro.html', 'termos-de-uso.html', 'recuperar-senha.html', 'index.html'];
    const currentPage = window.location.pathname.split('/').pop().toLowerCase();

    if (blockedPages.includes(currentPage)) {
        return;
    }

    const contacts = [
        { id: 'pessoa1', name: 'Pessoa 1', avatar: '1', messages: [{ sender: 'other', text: 'Olá! Tudo bem?' }] },
        { id: 'pessoa2', name: 'Pessoa 2', avatar: '2', messages: [{ sender: 'other', text: 'Você viu a nova comunidade?' }] },
        { id: 'pessoa3', name: 'Pessoa 3', avatar: '3', messages: [{ sender: 'other', text: 'Podemos conversar mais tarde?' }] }
    ];

    const style = document.createElement('style');
    style.textContent = `
        .chat-widget {
            position: fixed;
            bottom: 16px;
            right: 16px;
            z-index: 1400;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            pointer-events: none;
        }

        .chat-toggle {
            width: 56px;
            height: 56px;
            border: none;
            border-radius: 50%;
            background: linear-gradient(135deg, #f5f5f5, #bdbdbd);
            color: #222;
            font-size: 1.4rem;
            cursor: pointer;
            box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
            pointer-events: auto;
        }

        .chat-panel {
            display: none;
            width: min(360px, calc(100vw - 20px));
            height: min(500px, calc(100vh - 90px));
            margin-bottom: 10px;
            background: #fff;
            color: #111;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
            pointer-events: auto;
            flex-direction: column;
        }

        .chat-widget.open .chat-panel {
            display: flex;
        }

        .chat-header {
            background: #828282;
            color: #fff;
            padding: 14px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .chat-header h3 {
            margin: 0;
            font-size: 1rem;
        }

        .chat-header p {
            margin: 4px 0 0;
            font-size: 0.8rem;
            opacity: 0.9;
        }

        .chat-close {
            border: none;
            background: transparent;
            color: #fff;
            font-size: 1rem;
            cursor: pointer;
        }

        .chat-body {
            display: flex;
            flex: 1;
            min-height: 0;
        }

        .chat-contacts {
            width: 104px;
            background: #f3f4f6;
            border-right: 1px solid #e5e7eb;
            padding: 8px;
            overflow-y: auto;
        }

        .contact-item {
            width: 100%;
            border: none;
            background: transparent;
            padding: 10px 8px;
            border-radius: 10px;
            margin-bottom: 8px;
            text-align: left;
            cursor: pointer;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            color: #222;
        }

        .contact-item.active {
            background: #e5e7eb;
        }

        .contact-avatar {
            width: 38px;
            height: 38px;
            border-radius: 50%;
            background: #828282;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
        }

        .contact-name {
            font-size: 0.8rem;
            font-weight: 600;
        }

        .chat-conversation {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
        }

        .chat-messages {
            flex: 1;
            padding: 12px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
            background: #fafafa;
            transition: transform 0.25s ease, opacity 0.25s ease;
        }

        .chat-messages.is-changing {
            animation: chatSlideIn 0.25s ease;
        }

        @keyframes chatSlideIn {
            from {
                transform: translateX(18px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }

        .message-bubble {
            max-width: 80%;
            padding: 10px 12px;
            border-radius: 12px;
            font-size: 0.9rem;
            line-height: 1.3;
            word-break: break-word;
        }

        .message-bubble.me {
            align-self: flex-end;
            background: #828282;
            color: #fff;
        }

        .message-bubble.other {
            align-self: flex-start;
            background: #fff;
            color: #111;
            border: 1px solid #e5e7eb;
        }

        .chat-input-row {
            display: flex;
            gap: 8px;
            padding: 10px;
            border-top: 1px solid #e5e7eb;
            background: #fff;
        }

        .chat-input-row input {
            flex: 1;
            border: 1px solid #d1d5db;
            border-radius: 999px;
            padding: 10px 12px;
            outline: none;
            font-size: 0.9rem;
        }

        .chat-input-row button {
            border: none;
            border-radius: 999px;
            padding: 10px 12px;
            background: #828282;
            color: #fff;
            cursor: pointer;
        }

        @media (max-width: 640px) {
            .chat-widget {
                bottom: 12px;
                right: 12px;
                left: 12px;
                align-items: stretch;
            }

            .chat-toggle {
                width: 52px;
                height: 52px;
                align-self: flex-end;
            }

            .chat-panel {
                width: 100%;
                height: min(78vh, 520px);
                margin-bottom: 8px;
            }

            .chat-body {
                flex-direction: column;
            }

            .chat-contacts {
                width: 100%;
                max-height: 112px;
                border-right: none;
                border-bottom: 1px solid #e5e7eb;
                display: flex;
                gap: 8px;
                overflow-x: auto;
            }

            .contact-item {
                min-width: 74px;
            }

            .chat-input-row {
                padding: 8px;
            }
        }
    `;
    document.head.appendChild(style);

    const widget = document.createElement('div');
    widget.className = 'chat-widget';
    widget.id = 'chatWidget';
    widget.innerHTML = `
        <button class="chat-toggle" id="chatToggle" aria-label="Abrir chat">💬</button>
        <div class="chat-panel" id="chatPanel" role="dialog" aria-label="Chat bate-papo">
            <div class="chat-header">
                <div>
                    <h3>Mensagens</h3>
                    <p>Converse com seus amigos</p>
                </div>
                <button class="chat-close" id="chatClose" aria-label="Fechar chat">✕</button>
            </div>
            <div class="chat-body">
                <aside class="chat-contacts" id="chatContacts"></aside>
                <section class="chat-conversation">
                    <div class="chat-messages" id="chatMessages"></div>
                    <form class="chat-input-row" id="chatForm">
                        <input id="chatInput" type="text" placeholder="Digite uma mensagem..." maxlength="160" />
                        <button type="submit">Enviar</button>
                    </form>
                </section>
            </div>
        </div>
    `;

    document.body.appendChild(widget);

    const chatToggle = document.getElementById('chatToggle');
    const chatClose = document.getElementById('chatClose');
    const chatContacts = document.getElementById('chatContacts');
    const chatMessages = document.getElementById('chatMessages');
    const chatForm = document.getElementById('chatForm');
    const chatInput = document.getElementById('chatInput');
    let activeContactId = contacts[0].id;

    function renderContacts() {
        chatContacts.innerHTML = contacts.map(contact => `
            <button class="contact-item ${contact.id === activeContactId ? 'active' : ''}" data-contact="${contact.id}">
                <span class="contact-avatar">${contact.avatar}</span>
                <span class="contact-name">${contact.name}</span>
            </button>
        `).join('');
    }

    function renderMessages() {
        const contact = contacts.find(item => item.id === activeContactId);
        if (!contact) return;

        chatMessages.classList.remove('is-changing');
        chatMessages.innerHTML = contact.messages.map(message => `
            <div class="message-bubble ${message.sender === 'me' ? 'me' : 'other'}">${message.text}</div>
        `).join('');
        chatMessages.scrollTop = chatMessages.scrollHeight;
        requestAnimationFrame(() => {
            chatMessages.classList.add('is-changing');
        });
    }

    chatContacts.addEventListener('click', (event) => {
        const button = event.target.closest('.contact-item');
        if (!button) return;
        event.stopPropagation();
        activeContactId = button.dataset.contact;
        renderContacts();
        renderMessages();
    });

    chatToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        widget.classList.toggle('open');
        if (widget.classList.contains('open')) {
            renderContacts();
            renderMessages();
        }
    });

    chatClose.addEventListener('click', (event) => {
        event.stopPropagation();
        widget.classList.remove('open');
    });

    chatForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;

        const contact = contacts.find(item => item.id === activeContactId);
        if (!contact) return;

        contact.messages.push({ sender: 'me', text });
        renderMessages();
        chatInput.value = '';

        window.setTimeout(() => {
            contact.messages.push({ sender: 'other', text: `Resposta automática de ${contact.name}: ${text}` });
            renderMessages();
        }, 700);
    });

    document.addEventListener('click', (event) => {
        if (widget.classList.contains('open') && !widget.contains(event.target)) {
            widget.classList.remove('open');
        }
    });

    renderContacts();
    renderMessages();
})();
