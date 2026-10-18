import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Rate limit por usuário, janela deslizante, em memória.
 *
 * Suficiente enquanto a API roda num processo só. Se o deploy passar a ter
 * múltiplas instâncias, cada uma terá sua própria contagem e o limite efetivo
 * vira N x o configurado — nesse ponto, trocar o Map por Redis.
 *
 * Sem sessão (login, cadastro) a chave cai no req.ip. Atrás do proxy da
 * hospedagem o req.ip só é o IP real do cliente com TRUST_PROXY configurado
 * (ver config.ts); sem ele todo mundo compartilharia o IP do proxy.
 */

type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();

// Sem isto o Map cresce indefinidamente com usuários que passaram uma vez.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const cleanup = setInterval(() => {
  const cutoff = Date.now() - CLEANUP_INTERVAL_MS;
  for (const [key, bucket] of buckets) {
    if (bucket.hits.length === 0 || bucket.hits[bucket.hits.length - 1] < cutoff) {
      buckets.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanup.unref();

export function rateLimit(options: {
  name: string;
  limit: number;
  windowMs: number;
  message?: string;
  /**
   * Chave personalizada. Padrão: req.userId, ou req.ip sem sessão.
   * Devolver null/undefined pula este limitador — ex.: o limite por
   * identificador do login quando o corpo nem traz identificador (a validação
   * da rota responde 400 logo depois, e o limite por IP continua valendo).
   */
  key?: (req: Request) => string | null | undefined;
  /**
   * Não conta requisições que terminaram com sucesso (< 400). No login o que
   * importa é a tentativa errada: sem isto, quem entra de vários dispositivos
   * seria barrado junto com o atacante.
   */
  skipSuccessful?: boolean;
}): RequestHandler {
  const { name, limit, windowMs, skipSuccessful = false } = options;
  const message = options.message ?? "Muitas requisições. Aguarde um momento.";
  const keyOf = options.key ?? ((req: Request) => req.userId ?? req.ip ?? "anon");

  return (req: Request, res: Response, next: NextFunction) => {
    const identity = keyOf(req);
    if (identity == null) return next();

    const key = `${name}:${identity}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }

    const windowStart = now - windowMs;
    bucket.hits = bucket.hits.filter((t) => t > windowStart);

    if (bucket.hits.length >= limit) {
      const retryAfter = Math.ceil((bucket.hits[0] + windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
      return res.status(429).json({ error: message });
    }

    // A tentativa é contada ANTES de a rota responder, senão N requisições
    // paralelas passariam todas antes da primeira terminar. O desconto do
    // sucesso vem depois, no finish.
    bucket.hits.push(now);
    if (skipSuccessful) {
      const counted = bucket;
      res.on("finish", () => {
        if (res.statusCode < 400) {
          const i = counted.hits.indexOf(now);
          if (i !== -1) counted.hits.splice(i, 1);
        }
      });
    }
    next();
  };
}

/**
 * Zera todas as contagens. Só para o teste de integração, que roda a API no
 * mesmo processo e faz mais logins/cadastros do que os limites de produção
 * permitem. Não há rota que chame isto — não é alcançável por HTTP.
 */
export function resetRateLimits(): void {
  buckets.clear();
}
