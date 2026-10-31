/**
 * FAMAX — Janela de formulário (Shared)
 *
 * A janela da R (r-win, no components.css): cabeçalho com o título e o ✕,
 * corpo que rola por dentro e rodapé com as ações. Até 700px de largura e
 * 90% da altura da tela; título e ações ficam sempre à vista.
 *
 * No celular (até 599px) vira tela cheia: ✕ à esquerda, o título e a ação
 * principal à direita, no topo; o rodapé sai. A ação principal é o mesmo
 * botão, que muda de lugar com a faixa (nada é duplicado nem enviado duas
 * vezes).
 *
 * Foco preso (focus-trap.ts): Esc e ✕ pedem para fechar (onRequestClose
 * decide); ao fechar, o foco volta a quem abriu. A página de trás não rola
 * enquanto a janela está aberta. Usada pelo criar post e pela janela de
 * evento (createFormWindow, montada aqui) e pelas janelas escritas no HTML
 * das configurações e do cadastro (bindWindowActions e lockPageScroll).
 */
import { trapFocus } from "./focus-trap.js";
import { ICONS } from "./icons.js";
import { followKeyboard } from "./keyboard.js";

export interface WindowOptions {
    title: string;
    /** Linha abaixo do título ("Em Hardware e montagem"). */
    subtitle?: string;
    /** Esc, ✕ e clique no véu: quem chama decide se fecha (rascunho, confirmação...). */
    onRequestClose: () => void;
}

export interface FormWindow {
    /** A janela (<form>): o submit dela é o da ação principal. */
    form: HTMLFormElement;
    body: HTMLElement;
    /**
     * Põe as ações no rodapé: as secundárias e, por último, a principal. No
     * celular a principal sobe para o topo. Liga o foco preso: chamar depois
     * de montar o corpo, com o campo que recebe o foco primeiro.
     */
    open(actions: { primary: HTMLButtonElement; secondary?: HTMLElement[]; initialFocus?: HTMLElement | null }): void;
    /** Tira a janela e devolve o foco a quem abriu. */
    close(): void;
}

const PHONE = window.matchMedia("(max-width: 599px)");
let ids = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Janela escrita no HTML (veil.r-win-veil > .r-win, com .r-win-head,
 * .r-win-body e .r-win-foot; ou passos .r-win-step, cada um com as três
 * partes): a ação principal de cada parte ([data-win-primary]) fica no
 * rodapé, e no celular sobe para o cabeçalho. Devolve a função que desliga.
 */
export function bindWindowActions(win: HTMLElement): () => void {
    const place = (): void => {
        win.querySelectorAll<HTMLElement>("[data-win-primary]").forEach((button) => {
            const scope = button.closest<HTMLElement>(".r-win-step") ?? win;
            const target = scope.querySelector(PHONE.matches ? ".r-win-head" : ".r-win-foot");
            if (target && button.parentElement !== target) target.append(button);
        });
    };
    place();
    PHONE.addEventListener("change", place);
    return () => PHONE.removeEventListener("change", place);
}

/** A página de trás não rola com uma janela aberta. Devolve a função que destrava. */
export function lockPageScroll(): () => void {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
        root.style.overflow = previous;
    };
}

export function createFormWindow(options: WindowOptions): FormWindow {
    const veil = el("div", "r-win-veil");
    const form = el("form", "r-win");
    form.noValidate = true;
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");

    const head = el("div", "r-win-head");
    const titles = el("div", "r-win-titles");
    const title = el("h2", "r-win-title", options.title);
    title.id = `r-win-title-${++ids}`;
    form.setAttribute("aria-labelledby", title.id);
    titles.append(title);
    if (options.subtitle) titles.append(el("p", "r-win-sub", options.subtitle));
    const closeBtn = el("button", "fx-btn fx-btn--icon r-win-close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Fechar");
    closeBtn.innerHTML = ICONS.close; // ícone fixo, sem dado
    head.append(titles, closeBtn);

    const body = el("div", "r-win-body");
    const foot = el("div", "r-win-foot");
    form.append(head, body, foot);
    veil.append(form);

    let primary: HTMLButtonElement | null = null;
    let release: () => void = () => {};
    let stopKeyboard: () => void = () => {};
    let unlock: () => void = () => {};

    // A ação principal: no rodapé, ou no topo no celular.
    const place = (): void => {
        if (!primary) return;
        if (PHONE.matches) head.append(primary);
        else foot.append(primary);
    };

    closeBtn.addEventListener("click", () => options.onRequestClose());
    veil.addEventListener("click", (event) => {
        if (event.target === veil) options.onRequestClose();
    });

    return {
        form,
        body,
        open({ primary: main, secondary = [], initialFocus }) {
            primary = main;
            foot.append(...secondary, main);
            place();
            PHONE.addEventListener("change", place);
            document.body.append(veil);
            unlock = lockPageScroll();
            release = trapFocus(form, { onEscape: () => options.onRequestClose(), initialFocus });
            stopKeyboard = followKeyboard(form);
        },
        close() {
            PHONE.removeEventListener("change", place);
            stopKeyboard();
            veil.remove();
            unlock();
            release();
        },
    };
}
