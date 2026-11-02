// Termos de uso (legal/terms.html). Fica num arquivo, e não num <script>
// inline: a CSP só deixa rodar script do próprio site, e o único inline
// permitido (por hash) é o de tema do <head>.

// Quem chegou aqui pelo modal do cadastro (ou de outra página do site)
// volta para onde estava, com o formulário preenchido. Aberta direto,
// sem histórico, o href segue apontando para o cadastro.
document.getElementById("backButton")?.addEventListener("click", (event) => {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) {
        event.preventDefault();
        history.back();
    }
});

export {};
