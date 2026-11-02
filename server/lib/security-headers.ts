import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { Router, type RequestHandler } from "express";
import helmet from "helmet";
import { config } from "../config.js";
import { rateLimit } from "./rate-limit.js";

/**
 * Cabeçalhos de segurança (helmet), CSP e CORS.
 *
 * O mesmo Express serve o HTML e a API, e o token fica no localStorage: a CSP
 * é o que limita um XSS que escape do escapeHtml (só os scripts do próprio
 * site rodam, e só imagens de origens conhecidas carregam).
 */

/** Caminho que recebe os relatórios de violação da CSP. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * Hash (sha256, base64) de cada <script> inline das páginas publicadas — hoje
 * só o de tema do <head>, igual nas 16 páginas, que aplica o tema antes da
 * primeira pintura. Calculado na subida, do HTML que o servidor de fato
 * entrega: mudar o script e esquecer o hash não acontece. Sem a pasta (dev,
 * onde quem serve o HTML é o Vite), nenhum hash.
 */
export function inlineScriptHashes(publicDir: string): string[] {
  if (!existsSync(publicDir)) return [];
  const hashes = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) {
        const html = readFileSync(full, "utf8");
        // <script> sem src: o conteúdo exato entre as tags é o que o navegador hasheia.
        for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
          if (match[1]) hashes.add(createHash("sha256").update(match[1], "utf8").digest("base64"));
        }
      }
    }
  };
  walk(publicDir);
  return [...hashes];
}

/** Origem do Supabase Storage (capas, avatares, banners e imagens dos posts). */
function storageOrigin(): string | null {
  if (!config.SUPABASE_URL) return null;
  try {
    const url = new URL(config.SUPABASE_URL);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    /* cai no aviso abaixo */
  }
  // Ex.: a URL do banco (postgresql://...) posta aqui por engano. Sem uma
  // origem http(s), as imagens do Storage seriam barradas pela CSP.
  console.warn("⚠️  SUPABASE_URL não é uma URL https:// — a CSP não libera imagens do Storage.");
  return null;
}

export function securityHeaders(publicDir: string): RequestHandler {
  const hashes = inlineScriptHashes(publicDir);
  const storage = storageOrigin();
  const enforce = !config.CSP_REPORT_ONLY;
  const production = config.NODE_ENV === "production";

  if (hashes.length > 1) {
    // Mais de um script inline: provavelmente alguém acrescentou outro sem
    // querer. Funciona (cada um tem o seu hash), mas vale olhar.
    console.warn(`⚠️  CSP: ${hashes.length} scripts inline diferentes nas páginas (esperado: 1, o de tema).`);
  }
  console.log(
    `CSP ${enforce ? "valendo" : "só observando (report-only)"}: ${hashes.length} script(s) inline por hash` +
      (storage ? `, imagens de ${storage}` : ""),
  );

  return helmet({
    contentSecurityPolicy: {
      // Sem os padrões do helmet: a lista é toda explícita aqui.
      useDefaults: false,
      reportOnly: !enforce,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...hashes.map((hash) => `'sha256-${hash}'`)],
        // Atributos onclick="" e afins: nenhum, o JS liga os eventos.
        scriptSrcAttr: ["'none'"],
        // Nada de style="" nem <style>: estilo só de arquivo. O que o JS muda
        // vai pelo CSSOM (el.style.x = ...), que a CSP não barra.
        styleSrc: ["'self'"],
        // data: e blob: — imagens de exemplo em SVG inline e a prévia local
        // dos uploads, antes de enviar.
        imgSrc: ["'self'", "data:", "blob:", ...(storage ? [storage] : [])],
        // Inclui o tempo real (SSE em /api/stream), na mesma origem.
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Em report-only o navegador ignora frame-ancestors (e avisa no
        // console); o X-Frame-Options: DENY abaixo cobre o mesmo caso.
        ...(enforce ? { frameAncestors: ["'none'"] } : {}),
        // Só valendo e em produção: em http://localhost trocaria os pedidos
        // para https e quebraria a página.
        ...(enforce && production ? { upgradeInsecureRequests: [] } : {}),
        reportUri: [CSP_REPORT_PATH],
      },
    },
    // As imagens vêm do Supabase Storage, que não manda Cross-Origin-Resource-Policy.
    crossOriginEmbedderPolicy: false,
    // HSTS só em produção (HTTPS). Sem includeSubDomains/preload: o domínio
    // pode ter subdomínios que não são deste servidor, e preload não se desfaz
    // rápido.
    strictTransportSecurity: production ? { maxAge: 180 * 24 * 60 * 60, includeSubDomains: false } : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xFrameOptions: { action: "deny" },
  });
}

/**
 * CORS só para as origens de CORS_ORIGIN. Sem a variável, nenhum middleware:
 * a resposta não leva Access-Control-Allow-Origin e o navegador só deixa a
 * própria origem ler a API. Sem credentials: o token vai no header, não em
 * cookie.
 */
export function corsMiddleware(): RequestHandler | null {
  if (config.CORS_ORIGINS.length === 0) return null;
  return cors({ origin: config.CORS_ORIGINS });
}

/**
 * POST /api/csp-report — o navegador manda aqui cada violação. Só registra no
 * log: é o que diz, enquanto a CSP está em report-only, se algo do site ainda
 * seria barrado. Responde 204 sempre (o navegador não lê a resposta).
 */
export function cspReportRoute(): Router {
  const router = Router();
  router.post(
    CSP_REPORT_PATH,
    // Por IP: uma página com problema dispara um relatório por recurso.
    rateLimit({ name: "csp-report", limit: 60, windowMs: 60_000 }),
    express.json({ type: ["application/csp-report", "application/reports+json", "application/json"], limit: "16kb" }),
    (req, res) => {
      // report-uri manda { "csp-report": {...} }; a Reporting API, uma lista
      // de { type, body }.
      const body: unknown = req.body;
      const reports = Array.isArray(body)
        ? body.map((item) => (item as { body?: unknown })?.body)
        : [(body as { "csp-report"?: unknown })?.["csp-report"]];
      for (const report of reports) {
        if (!report || typeof report !== "object") continue;
        const r = report as Record<string, unknown>;
        const pick = (...keys: string[]) => keys.map((k) => r[k]).find((v) => typeof v === "string") as string | undefined;
        console.warn(
          `CSP ${config.CSP_REPORT_ONLY ? "(report-only)" : "(bloqueado)"}: ` +
            `${pick("violated-directive", "effectiveDirective", "effective-directive") ?? "?"} ` +
            `← ${pick("blocked-uri", "blockedURL") ?? "?"} ` +
            `em ${pick("document-uri", "documentURL") ?? "?"}`,
        );
      }
      res.status(204).end();
    },
  );
  return router;
}
