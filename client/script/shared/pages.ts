/**
 * Caminhos das páginas, num lugar só.
 *
 * Os HTML vivem em pastas diferentes (raiz, html/, html/user-pages/,
 * html/community/), então um link relativo como "../home.html" muda de
 * significado conforme a página que o usa. Aqui tudo é absoluto a partir do
 * BASE_URL do Vite — "/" tanto no dev quanto no Express em produção —, e quem
 * navega não precisa saber em que pasta está.
 */
const BASE = import.meta.env.BASE_URL;

export const pages = {
  index: `${BASE}index.html`,
  home: `${BASE}html/home.html`,
  login: `${BASE}html/user-pages/login.html`,
  register: `${BASE}html/user-pages/register.html`,
  recoverPassword: `${BASE}html/user-pages/recover-password.html`,
  profile: `${BASE}html/user-pages/profile-view.html`,
  settings: `${BASE}html/user-pages/profile-settings.html`,
  newCommunity: `${BASE}html/community/new.html`,
  search: `${BASE}html/search.html`,
  post: `${BASE}html/post.html`,
} as const;

export type SearchType = "all" | "communities" | "users" | "posts";

/** Página de resultados da busca. */
export function searchUrl(q: string, type: SearchType = "all"): string {
  const params = new URLSearchParams({ q });
  if (type !== "all") params.set("type", type);
  return `${pages.search}?${params}`;
}

/** Página individual de um post. */
export function postUrl(postId: string): string {
  return `${pages.post}?id=${encodeURIComponent(postId)}`;
}

/** Perfil de alguém; sem id, o próprio. */
export function profileUrl(userId?: string): string {
  return userId
    ? `${pages.profile}?id=${encodeURIComponent(userId)}`
    : pages.profile;
}

export function communityUrl(communityId: string): string {
  return `${BASE}html/community.html?id=${encodeURIComponent(communityId)}`;
}

/** A página de criação em modo edição. */
export function communityEditUrl(communityId: string): string {
  return `${pages.newCommunity}?edit=${encodeURIComponent(communityId)}`;
}

// Páginas de quem ainda não entrou. Um 401 nelas não redireciona (seria
// mandar para o login quem já está nele) e elas não servem como ?next=.
const AUTH_PAGES: string[] = [
  BASE,
  pages.index,
  pages.login,
  pages.register,
  pages.recoverPassword,
];

export function isAuthPage(pathname = window.location.pathname): boolean {
  return AUTH_PAGES.includes(pathname);
}

/** URL do login que, depois de entrar, volta para a página atual. */
export function loginUrlReturningHere(): string {
  const { pathname, search, hash } = window.location;
  if (isAuthPage(pathname)) return pages.login;
  const next = encodeURIComponent(pathname + search + hash);
  return `${pages.login}?next=${next}`;
}

/**
 * Valida o ?next= do login. Só aceita caminho do próprio site: sem isso o
 * parâmetro vira um redirecionamento aberto — um link de phishing
 * "famax/login?next=https://golpe" passaria pelo nosso domínio.
 */
export function safeNextPath(raw: string | null): string | null {
  // "//golpe.com" e "/\golpe.com" começam com "/" mas apontam para outro
  // host; a checagem de origin abaixo pega os dois.
  if (!raw || !raw.startsWith("/")) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (isAuthPage(url.pathname)) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
