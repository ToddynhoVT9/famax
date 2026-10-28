/**
 * Ferramentas de desenvolvimento. Importado por api.ts, que toda página carrega.
 * Em produção import.meta.env.DEV é false, e o Vite tira o bloco do build.
 */
if (import.meta.env.DEV && new URLSearchParams(location.search).has("conferir")) {
    void import("../dev/conferir-r.js").then((m) => m.ligarConferencia());
}
