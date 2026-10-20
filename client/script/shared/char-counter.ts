/**
 * FAMAX — Contador de caracteres (Shared)
 *
 * "120/2000" ao lado de um campo com maxlength. O contador fica ligado ao
 * campo por aria-describedby (o leitor de tela lê junto ao focar) e ganha
 * destaque perto do limite.
 *
 * Dois modos:
 *  - "always": sempre visível (título e conteúdo de post, bio, descrição);
 *  - "near": só aparece a partir de 80% do limite — para campos de uma linha
 *    com botão ao lado (comentário, mensagem do chat), onde um número fixo só
 *    ocuparia espaço.
 *
 * Campos criados depois (respostas a comentário) usam o atributo
 * data-char-counter="near|always": o primeiro input liga o contador sozinho.
 */

export type CounterMode = "always" | "near";

const NEAR = 0.8;
let nextId = 0;

export interface CounterOptions {
    mode?: CounterMode;
    /** Elemento já existente no HTML; sem ele, um é criado logo após o campo. */
    counter?: HTMLElement | null;
}

/** Liga o contador e devolve a função que o atualiza (chamar ao trocar o valor por código). */
export function attachCharCounter(
    field: HTMLInputElement | HTMLTextAreaElement,
    options: CounterOptions = {},
): () => void {
    const max = field.maxLength;
    const mode = options.mode ?? "always";
    const counter = options.counter ?? document.createElement("span");
    counter.classList.add("char-counter");
    if (!counter.id) counter.id = `char-counter-${++nextId}`;
    if (!counter.isConnected) field.after(counter);

    const describedBy = (field.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    if (!describedBy.includes(counter.id)) {
        field.setAttribute("aria-describedby", [...describedBy, counter.id].join(" "));
    }
    // No modo "near" o número só aparece perto do limite: aí vale anunciar.
    if (mode === "near") counter.setAttribute("aria-live", "polite");

    const update = (): void => {
        if (max <= 0) return;
        const length = field.value.length;
        const near = length >= max * NEAR;
        counter.textContent = `${length}/${max}`;
        counter.classList.toggle("char-counter--near", near);
        counter.classList.toggle("char-counter--full", length >= max);
        counter.hidden = mode === "near" && !near;
    };

    field.addEventListener("input", update);
    field.dataset.charCounterBound = "true";
    update();
    return update;
}

// Campos montados depois (data-char-counter): liga no primeiro input.
document.addEventListener("input", (event) => {
    const field = event.target;
    if (
        !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
        field.dataset.charCounter === undefined ||
        field.dataset.charCounterBound
    ) {
        return;
    }
    attachCharCounter(field, { mode: field.dataset.charCounter === "near" ? "near" : "always" });
});
