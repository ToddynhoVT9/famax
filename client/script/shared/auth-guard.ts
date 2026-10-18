/**
 * Guardas de página.
 *
 * Chamadas no topo do script de cada página, antes de qualquer outra coisa.
 * Fazem só o que dá para decidir no cliente — quem garante o acesso de
 * verdade é o servidor, que responde 401 sem sessão válida.
 */
import { getMe, getToken } from "./api.js";
import { loginUrlReturningHere, pages, safeNextPath } from "./pages.js";

/** Vai para o login e, depois de entrar, volta para a página atual. */
export function goToLogin(): void {
  window.location.href = loginUrlReturningHere();
}

/** Para onde ir depois de entrar: o ?next= validado, ou a home. */
export function afterLoginUrl(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return safeNextPath(next) ?? pages.home;
}

/**
 * Páginas que não fazem sentido sem conta (perfil, configurações, criar
 * comunidade).
 *
 * Sem token, redireciona na hora. Com token, confere a sessão em segundo
 * plano: se ela tiver sido encerrada, o 401 do getMe() já manda para o login
 * (ver api.ts). O getMe() fica em cache para a própria página usar.
 */
export function requireLogin(): void {
  if (!getToken()) {
    // replace: o "voltar" do navegador não deve cair de novo aqui.
    window.location.replace(loginUrlReturningHere());
    return;
  }
  getMe().catch(() => {
    /* 401 já redirecionou; erro de rede deixa a página tentar sozinha */
  });
}

/**
 * Tela inicial, login e cadastro: quem já está logado segue em frente.
 *
 * Confere a sessão antes de redirecionar. Só olhar se existe token mandaria
 * quem tem um token vencido para a home, que mandaria de volta para o login.
 */
export function redirectIfLoggedIn(): void {
  if (!getToken()) return;
  getMe()
    .then(() => window.location.replace(afterLoginUrl()))
    .catch(() => {
      /* sessão inválida: o api() já limpou o token, fica na página */
    });
}
