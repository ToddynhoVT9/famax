/**
 * FAMAX — Imagens de posts (Shared)
 *
 * A grade de miniaturas (1 a 4 imagens) e a visualização ampliada, com
 * setas, Esc e foco preso enquanto aberta. As URLs vêm do Storage
 * (posts.routes.ts) e entram por atributo escapado / propriedade src, nunca
 * por innerHTML cru.
 */
import { escapeHtml } from "./dom.js";

export interface PostImage {
    image_id: string;
    url: string;
}

export const MAX_POST_IMAGES = 4;

export function imagesGridHtml(images: PostImage[] | undefined): string {
    if (!images || images.length === 0) return "";
    const items = images
        .map(
            (image, index) =>
                `<button type="button" class="tf-post-image" data-action="open-image" data-index="${index}"
                         aria-label="Ampliar imagem ${index + 1} de ${images.length}">
                     <img src="${escapeHtml(image.url)}" alt="" loading="lazy" />
                 </button>`,
        )
        .join("");
    return `<div class="tf-post-images tf-post-images--${Math.min(images.length, MAX_POST_IMAGES)}">${items}</div>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** Visualização ampliada, começando na imagem `start`. */
export function openLightbox(images: PostImage[], start = 0): void {
    if (images.length === 0) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    let index = Math.max(0, Math.min(start, images.length - 1));

    const overlay = el("div", "lightbox");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Imagem ampliada");

    const img = el("img", "lightbox-img");
    img.alt = "";
    const counter = el("p", "lightbox-counter");
    counter.setAttribute("aria-live", "polite");
    const close = el("button", "lightbox-btn lightbox-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Fechar");
    const prev = el("button", "lightbox-btn lightbox-prev", "‹");
    prev.type = "button";
    prev.setAttribute("aria-label", "Imagem anterior");
    const next = el("button", "lightbox-btn lightbox-next", "›");
    next.type = "button";
    next.setAttribute("aria-label", "Próxima imagem");

    const single = images.length === 1;
    prev.hidden = single;
    next.hidden = single;
    counter.hidden = single;

    overlay.append(img, close, prev, next, counter);
    document.body.append(overlay);

    const show = (i: number): void => {
        index = (i + images.length) % images.length;
        img.src = images[index].url;
        counter.textContent = `${index + 1} de ${images.length}`;
    };

    const dismiss = (): void => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        previousFocus?.focus();
    };

    const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.stopPropagation();
            dismiss();
        } else if (event.key === "ArrowRight" && !single) {
            show(index + 1);
        } else if (event.key === "ArrowLeft" && !single) {
            show(index - 1);
        } else if (event.key === "Tab") {
            // Foco preso nos botões visíveis do lightbox.
            const focusable = [close, prev, next].filter((b) => !b.hidden);
            const position = focusable.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault();
            const step = event.shiftKey ? -1 : 1;
            focusable[(position + step + focusable.length) % focusable.length]?.focus();
        }
    };

    close.addEventListener("click", dismiss);
    prev.addEventListener("click", () => show(index - 1));
    next.addEventListener("click", () => show(index + 1));
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) dismiss();
    });
    document.addEventListener("keydown", onKey);

    show(index);
    close.focus();
}
