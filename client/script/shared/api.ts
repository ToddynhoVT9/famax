import "./dev.js";
import { isAuthPage, loginUrlReturningHere, pages } from "./pages.js";
import { buildEndpoints } from "./api-endpoints.js";
import type { Me, SocialLink } from "../../../shared/api-types.js";
export type { Me, SocialLink };

const API_BASE = "/api";
const TOKEN_KEY = "famax_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  meCache = null;
}

/**
 * Lê o `sub` do JWT sem validar a assinatura.
 *
 * Serve só para decisões de interface — mostrar o botão de excluir no próprio
 * comentário, saber se uma mensagem é minha. Toda autorização real é feita no
 * servidor, que verifica a assinatura; um token adulterado aqui muda o que a
 * tela desenha e nada mais.
 */
export function getCurrentUserId(): string | null {
  const token = getToken();
  if (!token) return null;

  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as { sub?: string };
    return parsed.sub ?? null;
  } catch {
    return null;
  }
}

let redirectingToLogin = false;

/**
 * Sessão expirada, revogada (logout em outro dispositivo) ou conta excluída:
 * o token guardado não serve mais. Limpa e manda para o login, que traz o
 * usuário de volta aqui depois. Nas páginas de entrada só limpa — quem está
 * no login já está onde precisa.
 */
function handleUnauthorized(): void {
  clearToken();
  if (redirectingToLogin || isAuthPage()) return;
  // Várias chamadas em paralelo (feed, sidebar, chat) recebem 401 juntas;
  // uma navegação basta.
  redirectingToLogin = true;
  window.location.replace(loginUrlReturningHere());
}

/**
 * Erro de uma chamada à API: a mensagem do servidor em `message`, mais o
 * status e o corpo inteiro, para quem precisa de um campo além do texto (ex.:
 * code: "EMAIL_NOT_VERIFIED", reactivatable no login de conta excluída).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Chamada crua: caminho e opções. A aplicação usa os métodos de `api` (abaixo). */
async function request<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();

  // Em multipart o browser precisa definir o Content-Type sozinho (ele carrega
  // o boundary). Forçar application/json aqui quebra o upload da capa.
  const isFormData = options.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!response.ok) {
    // Só reage se a chamada levou token: o 401 do próprio login (senha
    // errada) não é sessão perdida.
    if (response.status === 401 && token) {
      handleUnauthorized();
    }
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

/**
 * `api(path, options)` faz a chamada crua; `api.posts.get(id)` e afins são o
 * cliente tipado (api-endpoints.ts). Um objeto só, para os dois usos.
 */
export const api = Object.assign(request, buildEndpoints(request));

// ---------------------------------------------------------------------------
// Usuário logado
// ---------------------------------------------------------------------------

let meCache: Promise<Me> | null = null;

/**
 * GET /api/me com cache da página: header, guarda e o script da página podem
 * todos pedir, e só sai uma requisição. Um erro não fica em cache.
 */
export function getMe(): Promise<Me> {
  if (!meCache) {
    const pending = api.me.get().then((body) => body.user);
    meCache = pending;
    pending.catch(() => {
      if (meCache === pending) meCache = null;
    });
  }
  return meCache;
}

/**
 * Troca o /me em cache depois de uma edição (as rotas de edição devolvem o
 * mesmo formato). Quem chamar getMe() depois já recebe o valor novo.
 */
export function setMeCache(me: Me): void {
  meCache = Promise.resolve(me);
}

/**
 * Encerra a sessão no servidor e sai. O token local é apagado mesmo se a
 * chamada falhar (sem rede, sessão já expirada): o usuário pediu para sair, e
 * fica sem token de qualquer forma.
 */
async function endSession(path: "/auth/logout" | "/auth/logout-all"): Promise<void> {
  const token = getToken();
  if (token) {
    // fetch direto, não api(): o 401 de uma sessão já encerrada mandaria para
    // o login em vez da tela inicial.
    await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  clearToken();
  window.location.replace(pages.index);
}

export function logout(): Promise<void> {
  return endSession("/auth/logout");
}

/** Sai de todos os dispositivos, inclusive este. */
export function logoutAll(): Promise<void> {
  return endSession("/auth/logout-all");
}
