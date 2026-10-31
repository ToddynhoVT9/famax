/**
 * FAMAX — Ícones de traço (Shared)
 *
 * Desenho fixo, sem dado de usuário: pode ir por innerHTML. Usados pela
 * moldura (layout.ts), pelo post, pela pesquisa e pelos avisos. Ficam num
 * módulo próprio para quem é importado pelo layout.ts (notifications.ts)
 * poder usá-los sem import circular.
 */

const svg = (paths: string): string =>
    `<svg class="r-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICONS = {
    menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    chevron: svg('<path d="M6 9l6 6 6-6"/>'),
    bell: svg('<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'),
    chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
    home: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
    search: svg('<circle cx="10" cy="10" r="6"/><path d="M15 15l6 6"/>'),
    communities: svg(
        '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/>' +
            '<circle cx="17" cy="9" r="2.5"/><path d="M16 14c2.8 0 5 2 5 5"/>',
    ),
    you: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5c1.5-2 3.3-3 5.5-3s4 1 5.5 3"/>'),
    login: svg('<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    // Post (post-thread.ts), lightbox e paginação da pesquisa.
    dots: svg('<path d="M5 12h.01M12 12h.01M19 12h.01"/>').replace('class="r-ico"', 'class="r-ico r-ico--dots"'),
    comment: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
    bookmark: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
    link: svg(
        '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/>' +
            '<path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    ),
    prev: svg('<path d="M15 6l-6 6 6 6"/>'),
    next: svg('<path d="M9 6l6 6-6 6"/>'),
    // "Marcar todas como lidas" no celular (notificações).
    checks: svg('<path d="M2 13l4 4L16 7"/><path d="M11 16l1 1L22 7"/>'),
    // Local do evento (comunidade).
    place: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
};
