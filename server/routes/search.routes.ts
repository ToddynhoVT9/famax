import { Router } from "express";
import { z } from "zod";
import { optionalAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { isAdult } from "../lib/nsfw.js";
import {
  type SearchSection,
  searchCommunities,
  searchPosts,
  searchUsers,
} from "../lib/search.js";

const router = Router();

// ===========================================================================
// GET /api/search?q=&type=communities|users|posts|all&page=
// ---------------------------------------------------------------------------
// Uma rota para o dropdown do header e para a página de resultados. Com
// type=all devolve as 5 primeiras de cada tipo (sem paginação); com um tipo,
// a página pedida. A resposta tem sempre o mesmo formato:
//   { q, type, results: { communities?, users?, posts? } }
// cada seção com { data, total, page, totalPages }.
// ===========================================================================

const searchQuery = z.object({
  q: z
    .string({ required_error: "Digite o que procurar" })
    .trim()
    .min(2, "Digite pelo menos 2 caracteres")
    .max(80, "Busca muito longa"),
  type: z.enum(["all", "communities", "users", "posts"]).default("all"),
  page: z.coerce.number().int().min(1).max(100).default(1),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

const PREVIEW_LIMIT = 5;

router.get(
  "/search",
  optionalAuth,
  // Leve: o dropdown dispara a cada pausa na digitação (300 ms de debounce).
  rateLimit({ name: "search", limit: 60, windowMs: 60_000, message: "Muitas buscas. Aguarde um momento." }),
  async (req, res, next) => {
    try {
      const { q, type, page, limit } = searchQuery.parse(req.query);
      const results: Partial<Record<"communities" | "users" | "posts", SearchSection>> = {};
      // Conteúdo +18 (comunidades e posts) só entra para quem pode ver.
      const adult = await isAdult(req.userId);

      if (type === "all") {
        // Em sequência, não em paralelo: cada uma é uma consulta curta, e três
        // de uma vez por tecla multiplicariam as conexões do pool.
        results.communities = await searchCommunities(q, 1, PREVIEW_LIMIT, adult);
        results.users = await searchUsers(q, req.userId, 1, PREVIEW_LIMIT);
        results.posts = await searchPosts(q, 1, PREVIEW_LIMIT, adult);
      } else if (type === "communities") {
        results.communities = await searchCommunities(q, page, limit, adult);
      } else if (type === "users") {
        results.users = await searchUsers(q, req.userId, page, limit);
      } else {
        results.posts = await searchPosts(q, page, limit, adult);
      }

      res.json({ q, type, results });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
