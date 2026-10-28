/**
 * FAMAX — Conferência das pranchas R no app (só em desenvolvimento)
 *
 * A mesma camada de medição das pranchas R do canvas, agora sobre a página de
 * verdade. Abra qualquer página com `?conferir` na URL (npm run dev) e ela mostra,
 * por cima da página, as etiquetas dos critérios do plano:
 *
 *   - faixa (celular, tablet, compacto, desktop) e coluna de conteúdo;
 *   - parte fixa da moldura na altura (até 10% no celular, 8% nas outras);
 *   - rolagem lateral e o que passa da borda da tela;
 *   - alvos de toque abaixo do mínimo (44px abaixo de 1280px, 32px no desktop);
 *   - ações cobertas por uma camada fixa (header, barra inferior, botão);
 *   - caracteres por linha no texto corrido (35 a 60 no celular, 45 a 80 nas outras);
 *   - itens inteiros acima da dobra (posts, resultados, avisos);
 *   - janela aberta: cabe na tela, rola por dentro, ação principal à vista;
 *   - teclado aberto (celular de verdade): campo e ação acima dele.
 *
 * As etiquetas em azul são informação; as em magenta, critério que não passa.
 * A camada se refaz ao rolar, ao mudar a largura e quando a página muda.
 * O resultado também fica em `window.__conferirR` (usado por conferir-todas.mjs).
 *
 * Marcadores opcionais, no HTML da página (não mudam nada fora da conferência):
 *   data-conferir-coluna        a coluna de conteúdo (sem ele: .r-col, ou o 1º filho de <main>)
 *   data-conferir-cpl           o bloco de texto da régua de caracteres
 *   data-conferir-item          um item da contagem acima da dobra
 *   data-conferir-min="1,2,2,3" no contêiner da lista: mínimo por faixa (celular, tablet, compacto, desktop)
 *   data-conferir-acao="Publicar" a ação principal (janela, formulário, teclado)
 *
 * Ligar: em shared/dev.ts (importado por shared/api.ts, que toda página carrega):
 *   if (import.meta.env.DEV && new URLSearchParams(location.search).has("conferir")) {
 *     void import("../dev/conferir-r.js").then((m) => m.ligarConferencia());
 *   }
 * Em produção o Vite tira o bloco inteiro do build.
 */

type Faixa = "celular" | "tablet" | "compacto" | "desktop";

export interface Etiqueta {
    texto: string;
    alerta: boolean;
}

export interface Caixa {
    x: number;
    y: number;
    w: number;
    h: number;
    rotulo?: string;
}

export interface Resultado {
    pagina: string;
    largura: number;
    altura: number;
    faixa: Faixa;
    etiquetas: Etiqueta[];
    pequenos: Caixa[];
    cobertos: Caixa[];
    coluna: Caixa | null;
}

const ALVOS = [
    "a[href]",
    "button",
    'input:not([type="hidden"])',
    "select",
    "textarea",
    "summary",
    '[role="button"]',
    '[role="tab"]',
    '[role^="menuitem"]',
    '[tabindex]:not([tabindex="-1"])',
].join(", ");

// Texto corrido: primeiro os marcados, depois as classes do design system e as de hoje.
const TEXTO = [
    "[data-conferir-cpl]",
    ".fx-post-snippet",
    ".fx-md",
    ".fx-result-snippet",
    ".fx-comment-text",
    ".md",
    ".result-snippet",
    ".notif-text",
    ".report-target",
    "main p",
    "p",
].join(", ");

const ITENS = "[data-conferir-item], .fx-post, .tf-post, .fx-result, .result-item, .fx-notif-item, .notif-item, .fx-report, .report-card";

function faixaDe(largura: number): Faixa {
    if (largura < 600) return "celular";
    if (largura < 1024) return "tablet";
    if (largura < 1280) return "compacto";
    return "desktop";
}

function caixa(el: Element): Caixa {
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
}

function visivel(el: Element): boolean {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01;
}

function rotulo(el: Element): string {
    const t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || (el as HTMLInputElement).placeholder || el.tagName.toLowerCase())
        .replace(/\s+/g, " ")
        .trim();
    return t.length > 28 ? `${t.slice(0, 27)}…` : t;
}

// Fora da página: acima do topo ou à esquerda do começo do documento (link de pular, gaveta fechada).
function foraDaPagina(el: Element): boolean {
    const b = el.getBoundingClientRect();
    return b.bottom + window.scrollY <= 0 || b.right + window.scrollX <= 0;
}

function dentroDaConferencia(el: Element): boolean {
    return !!el.closest("[data-conferir-camada]");
}

// Link no meio do texto não conta como alvo de toque (exceção da WCAG para links em frase).
function linkEmFrase(el: Element): boolean {
    if (el.tagName !== "A") return false;
    if (getComputedStyle(el).display !== "inline") return false;
    const bloco = el.parentElement?.closest("p, li, td, dd, blockquote, figcaption, label, span");
    if (!bloco) return false;
    const texto = (bloco.textContent || "").replace(/\s+/g, " ").trim();
    const proprio = (el.textContent || "").replace(/\s+/g, " ").trim();
    return texto.length > proprio.length + 2;
}

// Uma fileira que rola na horizontal de propósito (abas, chips, galeria, cartões).
function rolaDeLado(el: Element | null): Element | null {
    for (let n = el?.parentElement ?? null; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if ((s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden") && n.scrollWidth > n.clientWidth + 1) return n;
    }
    return null;
}

function camadaFixa(el: Element | null): Element | null {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const p = getComputedStyle(n).position;
        if (p === "fixed" || p === "sticky") return n;
    }
    return null;
}

// Régua de caracteres: conta os caracteres de cada linha desenhada e tira a média das linhas cheias.
function contarCaracteres(el: Element): { n: number; w: number; linhas: number } | null {
    const linhas: { t: number; n: number }[] = [];
    const rg = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let total = 0;
    for (let node = walker.nextNode(); node && total < 600; node = walker.nextNode()) {
        const t = node.nodeValue || "";
        for (let i = 0; i < t.length && total < 600; i++) {
            total += 1;
            rg.setStart(node, i);
            rg.setEnd(node, i + 1);
            const rs = rg.getClientRects();
            if (!rs.length) continue;
            const top = rs[0].top;
            let ln = linhas.find((l) => Math.abs(l.t - top) < 6);
            if (!ln) {
                ln = { t: top, n: 0 };
                linhas.push(ln);
            }
            ln.n += 1;
        }
    }
    if (linhas.length < 2) return null;
    linhas.sort((a, b) => a.t - b.t);
    const cheias = linhas.slice(0, -1);
    const n = Math.round(cheias.reduce((a, l) => a + l.n, 0) / cheias.length);
    return { n, w: Math.round(el.getBoundingClientRect().width), linhas: linhas.length };
}

function janelaAberta(): Element | null {
    const candidatas = document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], .r-win');
    for (const el of Array.from(candidatas)) {
        if (dentroDaConferencia(el) || !visivel(el)) continue;
        return el;
    }
    return null;
}

export function conferir(): Resultado {
    const W = window.innerWidth;
    const H = window.innerHeight;
    // No celular, uma página mais larga que a tela faz o navegador afastar o zoom: a largura de layout
    // cresce além da tela. A faixa é a da tela.
    const tela = window.matchMedia("(pointer: coarse)").matches && screen.width ? Math.min(W, screen.width) : W;
    const faixa = faixaDe(tela);
    const desktop = faixa === "desktop";
    const min = desktop ? 32 : 44;
    const etiquetas: Etiqueta[] = [];
    const info = (texto: string): void => { etiquetas.push({ texto, alerta: false }); };
    const alerta = (texto: string): void => { etiquetas.push({ texto, alerta: true }); };
    const janela = janelaAberta();

    info(`${faixa} · ${tela} × ${H}`);
    if (W > tela + 1) alerta(`a página não cabe: o navegador afastou o zoom para ${W}px numa tela de ${tela}px`);

    // ----- Moldura fixa: o que fica encostado em cima e embaixo durante a rolagem -----
    let topo = 0;
    let base = H;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
        if (dentroDaConferencia(el)) continue;
        const s = getComputedStyle(el);
        if (s.position !== "fixed" && s.position !== "sticky") continue;
        if (!visivel(el)) continue;
        const b = el.getBoundingClientRect();
        if (b.width < W * 0.5 || b.height > H * 0.4) continue;
        if (b.top <= 1 && b.bottom > 0) topo = Math.max(topo, b.bottom);
        if (b.bottom >= H - 1 && b.top < H) base = Math.min(base, b.top);
    }
    const fixo = topo + (H - base);
    const limite = faixa === "celular" ? 10 : 8;
    const pct = (fixo / H) * 100;
    const msgFixo = `fixo agora: ${Math.round(fixo)}px · ${pct.toFixed(1).replace(".", ",")}% (limite ${limite}%)`;
    if (pct > limite + 0.05) alerta(msgFixo); else info(msgFixo);

    // ----- Coluna de conteúdo -----
    const main = document.querySelector("main");
    const filhos = main ? Array.from(main.children).filter((el) => visivel(el) && el.getBoundingClientRect().height >= 40) : [];
    const maisLargo = filhos.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    const colEl = document.querySelector("[data-conferir-coluna]") || document.querySelector(".r-col") || maisLargo || main;
    let coluna: Caixa | null = null;
    if (colEl && visivel(colEl)) {
        coluna = caixa(colEl);
        const esq = Math.round(coluna.x);
        const dir = Math.round(W - coluna.x - coluna.w);
        const centro = Math.abs(esq - dir) <= 2;
        info(`coluna ${Math.round(coluna.w)}px em x ${esq}${centro ? ", centralizada" : ` · ${dir}px à direita`}`);
    }

    // ----- Rolagem lateral e o que passa da borda -----
    const sw = document.documentElement.scrollWidth;
    if (sw > W + 1) alerta(`a página rola ${sw - W}px na horizontal`);
    let passa = 0;
    let quem = "";
    const escopo = janela || document.querySelector("main") || document.body;
    for (const el of Array.from(escopo.querySelectorAll("*"))) {
        if (dentroDaConferencia(el) || rolaDeLado(el)) continue;
        if (camadaFixa(el) && !janela) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 1 || b.height < 1 || getComputedStyle(el).visibility === "hidden" || foraDaPagina(el)) continue;
        const fora = Math.max(b.right - W, -b.left);
        if (fora > passa) {
            passa = fora;
            quem = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase();
        }
    }
    if (passa > 1) alerta(`${quem} passa ${Math.round(passa)}px da borda`);

    // ----- Alvos de toque e ações cobertas -----
    const pequenos: Caixa[] = [];
    const cobertos: Caixa[] = [];
    let contados = 0;
    const raiz = janela || document;
    for (const el of Array.from(raiz.querySelectorAll(ALVOS))) {
        if (dentroDaConferencia(el) || linkEmFrase(el)) continue;
        // Caixa de seleção e rádio: o alvo é o rótulo, que é onde se toca.
        let alvo: Element = el;
        if (el.matches('input[type="checkbox"], input[type="radio"]')) {
            const lbl = el.closest("label") || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
            if (lbl) alvo = lbl;
        }
        if (!visivel(alvo) || foraDaPagina(alvo)) continue;
        const b = caixa(alvo);
        const sx = rolaDeLado(alvo);
        if (sx) {
            const r = sx.getBoundingClientRect();
            if (b.x + b.w <= r.left || b.x >= r.right) continue;
        }
        contados += 1;
        if (Math.round(b.w) < min || Math.round(b.h) < min) {
            pequenos.push({ ...b, rotulo: `${rotulo(el)} · ${Math.round(b.w)} × ${Math.round(b.h)}px` });
        }
        // Coberta: no centro do alvo, quem está por cima é uma camada fixa que não é o alvo.
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        if (cx > 0 && cx < W && cy > 0 && cy < H) {
            const topoEl = document.elementFromPoint(cx, cy);
            if (topoEl && !alvo.contains(topoEl) && !topoEl.contains(alvo) && !dentroDaConferencia(topoEl)) {
                const fx = camadaFixa(topoEl);
                if (fx && !fx.contains(alvo) && (!janela || janela.contains(alvo))) {
                    cobertos.push({ ...b, rotulo: `${rotulo(el)} embaixo de ${fx.id ? `#${fx.id}` : fx.tagName.toLowerCase()}` });
                }
            }
        }
    }
    if (pequenos.length) alerta(`${pequenos.length} de ${contados} alvos abaixo de ${min}px`);
    else info(`${contados} alvos medidos, todos com ${min}px ou mais`);
    if (cobertos.length) alerta(`${cobertos.length} ${cobertos.length === 1 ? "ação coberta" : "ações cobertas"} por camada fixa`);

    // ----- Caracteres por linha -----
    const lo = faixa === "celular" ? 35 : 45;
    const hi = faixa === "celular" ? 60 : 80;
    const amostras = Array.from((janela || document).querySelectorAll(TEXTO)).filter(
        (el) => !dentroDaConferencia(el) && visivel(el) && (el.textContent || "").trim().length > 80,
    );
    for (const el of amostras) {
        const c = contarCaracteres(el);
        if (!c) continue;
        const msg = `texto ${c.w}px · ${c.n} caracteres por linha (faixa de ${lo} a ${hi})`;
        if (c.n < lo || c.n > hi) alerta(msg); else info(msg);
        break;
    }

    // ----- Itens inteiros acima da dobra -----
    if (!janela) {
        const itens = Array.from(document.querySelectorAll(ITENS)).filter((el) => visivel(el) && !dentroDaConferencia(el));
        if (itens.length) {
            const n = itens.filter((el) => {
                const b = el.getBoundingClientRect();
                return b.top >= topo - 1 && b.bottom <= base + 1;
            }).length;
            const lista = itens[0].closest("[data-conferir-min]");
            const mins = (lista?.getAttribute("data-conferir-min") || "").split(",").map((x) => Number(x) || 0);
            const meta = mins[["celular", "tablet", "compacto", "desktop"].indexOf(faixa)] || 0;
            const msg = `${n} ${n === 1 ? "item inteiro" : "itens inteiros"} acima da dobra${meta ? ` (mínimo ${meta})` : ""}`;
            if (meta && n < meta) alerta(msg); else info(msg);
        }
    }

    // ----- Janela aberta -----
    if (janela) {
        const b = caixa(janela);
        const cheia = b.w >= W - 1 && b.h >= H - 1;
        const alt = (b.h / H) * 100;
        if (cheia) info("janela em tela cheia");
        else if (alt > 90.5 || b.y < -1 || b.y + b.h > H + 1) alerta(`janela de ${Math.round(b.w)} × ${Math.round(b.h)}px sai da tela (${Math.round(alt)}% da altura)`);
        else info(`janela de ${Math.round(b.w)} × ${Math.round(b.h)}px · ${Math.round(alt)}% da altura (limite 90%)`);
        const corpo = Array.from(janela.querySelectorAll("*")).find((el) => {
            const s = getComputedStyle(el);
            return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1;
        });
        info(corpo ? "o corpo da janela rola por dentro" : "o corpo da janela cabe sem rolar");
        const acao = janela.querySelector("[data-conferir-acao]") || janela.querySelector('button[type="submit"]');
        if (acao) {
            const a = acao.getBoundingClientRect();
            const ok = a.top >= 0 && a.bottom <= H && visivel(acao);
            const msg = `"${rotulo(acao)}" ${ok ? "à vista" : "fora da vista"}, em y ${Math.round(a.top)}`;
            if (ok) info(msg); else alerta(msg);
        }
    }

    // ----- Teclado aberto (celular de verdade) -----
    const vv = window.visualViewport;
    const ativo = document.activeElement;
    const campo = ativo instanceof HTMLElement && ativo.matches("input, textarea, select, [contenteditable]");
    if (vv && campo && Math.abs(vv.scale - 1) < 0.01 && vv.height < H - 120) {
        info(`teclado aberto: ${Math.round(H - vv.height)}px`);
        const checar = [ativo, document.querySelector("[data-conferir-acao]")].filter((el): el is Element => el instanceof Element);
        for (const el of checar) {
            const r = el.getBoundingClientRect();
            const ok = r.top >= vv.offsetTop && r.bottom <= vv.offsetTop + vv.height;
            const msg = `"${rotulo(el)}" ${ok ? "acima do teclado" : "embaixo do teclado"}`;
            if (ok) info(msg); else alerta(msg);
        }
    }

    const resultado: Resultado = { pagina: location.pathname + location.search, largura: W, altura: H, faixa, etiquetas, pequenos, cobertos, coluna };
    (window as unknown as { __conferirR?: Resultado }).__conferirR = resultado;
    return resultado;
}

// ===========================================================================
// Camada por cima da página
// ===========================================================================

const AZUL = "#1565c0";
const MAGENTA = "#ad1457";

function desenhar(camada: HTMLElement, r: Resultado): void {
    camada.replaceChildren();
    const painel = document.createElement("div");
    painel.style.cssText = "position:fixed;left:8px;bottom:8px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:calc(100vw - 16px);pointer-events:auto";
    for (const e of r.etiquetas) {
        const tag = document.createElement("span");
        tag.textContent = e.texto;
        tag.style.cssText = `padding:2px 8px;border-radius:999px;background:${e.alerta ? MAGENTA : AZUL};color:#fff;font:700 12px/16px system-ui,sans-serif;white-space:normal`;
        painel.append(tag);
    }
    const fechar = document.createElement("button");
    fechar.type = "button";
    fechar.textContent = "Fechar a conferência";
    fechar.style.cssText = "margin-top:2px;padding:2px 8px;border:1px solid #fff;border-radius:999px;background:#263238;color:#fff;font:600 12px/16px system-ui,sans-serif;cursor:pointer";
    fechar.addEventListener("click", () => camada.remove());
    painel.append(fechar);

    if (r.coluna) {
        for (const x of [r.coluna.x, r.coluna.x + r.coluna.w]) {
            const linha = document.createElement("div");
            linha.style.cssText = `position:fixed;top:0;bottom:0;left:${x - 1}px;width:0;border-left:2px dashed ${AZUL};opacity:.7`;
            camada.append(linha);
        }
    }
    for (const [lista, cor] of [[r.pequenos, MAGENTA], [r.cobertos, MAGENTA]] as const) {
        for (const c of lista) {
            if (c.y + c.h < 0 || c.y > r.altura) continue;
            const box = document.createElement("div");
            box.title = c.rotulo || "";
            box.style.cssText = `position:fixed;left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;outline:2px solid ${cor};outline-offset:-1px;background:rgba(173,20,87,.18)`;
            camada.append(box);
        }
    }
    camada.append(painel);
}

export function ligarConferencia(): void {
    const camada = document.createElement("div");
    camada.setAttribute("data-conferir-camada", "");
    camada.setAttribute("aria-hidden", "true");
    camada.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none";
    document.body.append(camada);

    let pendente = 0;
    const refazer = (): void => {
        if (pendente || !camada.isConnected) return;
        pendente = window.setTimeout(() => {
            pendente = 0;
            if (!camada.isConnected) return;
            camada.hidden = true;
            const r = conferir();
            camada.hidden = false;
            desenhar(camada, r);
        }, 150);
    };
    window.addEventListener("scroll", refazer, { passive: true });
    window.addEventListener("resize", refazer);
    window.visualViewport?.addEventListener("resize", refazer);
    new MutationObserver((mudancas) => {
        if (mudancas.some((m) => !camada.contains(m.target))) refazer();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "open", "hidden", "style"] });
    refazer();
    (window as unknown as { conferirR?: () => Resultado }).conferirR = () => {
        const r = conferir();
        console.table(r.etiquetas);
        if (r.pequenos.length) console.table(r.pequenos.map((c) => ({ alvo: c.rotulo })));
        if (r.cobertos.length) console.table(r.cobertos.map((c) => ({ coberto: c.rotulo })));
        return r;
    };
}
