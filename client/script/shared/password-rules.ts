/**
 * FAMAX — Regras da senha, marcadas ao digitar (Shared)
 *
 * As mesmas regras do backend (server/lib/password.ts). Cada item da lista
 * (<li data-rule="length|digits|special|match">) ganha .is-ok quando a senha
 * cumpre a regra. Usado na recuperação de senha e no cadastro; quem valida de
 * verdade continua sendo o servidor.
 */
const RULES: Record<string, (password: string, confirm: string) => boolean> = {
    length: (p) => p.length >= 8,
    digits: (p) => (p.match(/\d/g) ?? []).length >= 3,
    special: (p) => /[^A-Za-z0-9]/.test(p),
    match: (p, c) => p.length > 0 && p === c,
};

/**
 * Liga a lista às duas senhas (confirm é opcional: sem ele, a regra "match"
 * não entra). Devolve a função que confere tudo de novo e diz se passou.
 */
export function bindPasswordRules(
    list: HTMLElement | null,
    password: HTMLInputElement | null,
    confirm?: HTMLInputElement | null,
): () => boolean {
    const update = (): boolean => {
        let allOk = true;
        for (const item of list?.querySelectorAll<HTMLElement>("[data-rule]") ?? []) {
            const ok = RULES[item.dataset.rule ?? ""]?.(password?.value ?? "", confirm?.value ?? "") ?? false;
            item.classList.toggle("is-ok", ok);
            allOk &&= ok;
        }
        return allOk;
    };
    password?.addEventListener("input", update);
    confirm?.addEventListener("input", update);
    return update;
}
