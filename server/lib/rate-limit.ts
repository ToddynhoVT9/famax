import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Rate limit por usuário, janela deslizante, em memória.
 *
 * Suficiente enquanto a API roda num processo só. Se o deploy passar a ter
 * múltiplas instâncias, cada uma terá sua própria contagem e o limite efetivo
 * vira N x o configurado — nesse ponto, trocar o Map por Redis.
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
}): RequestHandler {
  const { name, limit, windowMs } = options;
  const message = options.message ?? "Muitas requisições. Aguarde um momento.";

  return (req: Request, res: Response, next: NextFunction) => {
    const identity = req.userId ?? req.ip ?? "anon";
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

    bucket.hits.push(now);
    next();
  };
}
