/**
 * FAMAX — Esqueletos de carregamento e estados vazios (Shared)
 *
 * skeleton(): blocos cinza no formato do que vai chegar (post, card, comentário,
 * mensagem), no lugar de um "Carregando..." solto — a página não pula quando
 * o conteúdo chega. Para leitor de tela o bloco é um único "Carregando..."
 * (role="status"); as formas em si ficam escondidas (aria-hidden).
 *
 * emptyState(): lista vazia com uma frase e, quando faz sentido, uma ação
 * ("Criar comunidade", "Publicar"). Tudo por textContent.
 */

export type SkeletonKind = "post" | "card" | "comment" | "message";

/** Linhas de cada forma (larguras em %); a primeira de "post" é o título. */
const SHAPES: Record<SkeletonKind, number[]> = {
    post: [55, 95, 88, 40],
    card: [70, 45],
    comment: [30, 90, 65],
    message: [60],
};

export function skeleton(kind: SkeletonKind, count = 3, label = "Carregando..."): HTMLElement {
    const group = document.createElement("div");
    group.className = "fx-skel-group";
    group.setAttribute("role", "status");
    group.setAttribute("aria-busy", "true");

    const text = document.createElement("span");
    text.className = "visually-hidden";
    text.textContent = label;
    group.append(text);

    for (let i = 0; i < count; i++) {
        const item = document.createElement("div");
        item.className = kind === "message" ? "fx-skel fx-skel--message" : "fx-skel";
        item.setAttribute("aria-hidden", "true");
        // Mensagens alternam lados, como numa conversa de verdade.
        if (kind === "message" && i % 2 === 1) item.classList.add("fx-skel--mine");
        SHAPES[kind].forEach((width, index) => {
            const line = document.createElement("span");
            // A primeira linha do post é o título, mais alta.
            line.className = kind === "post" && index === 0 ? "fx-skel-line fx-skel-line--title" : "fx-skel-line";
            line.style.width = `${width}%`;
            item.append(line);
        });
        group.append(item);
    }
    return group;
}

export interface EmptyAction {
    label: string;
    /** Link (navega) ou função (ex.: abrir o modal de novo post). */
    href?: string;
    onClick?: () => void;
}

export function emptyState(title: string, text?: string, action?: EmptyAction): HTMLElement {
    const box = document.createElement("div");
    box.className = "fx-empty";

    const heading = document.createElement("p");
    heading.className = "fx-empty-title";
    heading.textContent = title;
    box.append(heading);

    if (text) {
        const body = document.createElement("p");
        body.className = "fx-empty-text";
        body.textContent = text;
        box.append(body);
    }

    if (action) {
        let control: HTMLAnchorElement | HTMLButtonElement;
        if (action.href) {
            control = document.createElement("a");
            control.href = action.href;
        } else {
            control = document.createElement("button");
            control.type = "button";
            if (action.onClick) control.addEventListener("click", action.onClick);
        }
        // Button primary em pílula (hoje era azul): a ação do estado vazio.
        control.className = "fx-btn fx-btn--primary fx-btn--pill";
        control.textContent = action.label;
        box.append(control);
    }
    return box;
}
