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

export async function api<T = unknown>(
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
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}
