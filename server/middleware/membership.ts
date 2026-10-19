import type { Request, Response, NextFunction, RequestHandler } from "express";
import { pool } from "../db.js";
import { ACTIVE_BAN } from "./community-role.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Preenchido por requirePostMembership — evita refazer o SELECT na rota. */
    postContext?: { postId: string; communityId: string };
  }
}

/**
 * Exige que req.userId seja membro da comunidade resolvida a partir do request.
 *
 * Criar post, comentar e curtir são todas escritas restritas a membros; sem isso
 * cada rota repetiria a mesma checagem. Usar sempre depois de requireAuth.
 *
 * Banir já remove a pessoa dos membros; a checagem do banimento aqui cobre a
 * corrida em que ela volta a entrar entre o ban e a remoção.
 */
export function requireMembership(
  resolveCommunityId: (req: Request) => string | undefined,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const communityId = resolveCommunityId(req);
    if (!communityId) {
      return res.status(400).json({ error: "Comunidade não informada" });
    }

    try {
      const { rows } = await pool.query<{ is_member: boolean; is_banned: boolean }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM community_members
             WHERE community_id = $1 AND user_id = $2
           ) AS is_member,
           EXISTS (
             SELECT 1 FROM community_bans b
             WHERE b.community_id = $1 AND b.user_id = $2 AND ${ACTIVE_BAN("b")}
           ) AS is_banned`,
        [communityId, req.userId],
      );

      if (rows[0]?.is_banned) {
        return res
          .status(403)
          .json({ error: "Você está banido desta comunidade" });
      }
      if (!rows[0]?.is_member) {
        return res
          .status(403)
          .json({ error: "Você precisa participar da comunidade" });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Variante para rotas que só conhecem o postId (comentários, reações).
 *
 * Resolve a comunidade do post e valida a associação numa única query — a
 * alternativa seria buscar o post e depois consultar community_members.
 * Distingue 404 (post inexistente) de 403 (post existe, usuário não é membro).
 */
export const requirePostMembership: RequestHandler = async (req, res, next) => {
  const postId = req.params.postId;
  if (!postId) {
    return res.status(400).json({ error: "Post não informado" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
         p.post_id,
         p.community_id,
         EXISTS (
           SELECT 1 FROM community_members cm
           WHERE cm.community_id = p.community_id
             AND cm.user_id = $2
         ) AS is_member,
         EXISTS (
           SELECT 1 FROM community_bans b
           WHERE b.community_id = p.community_id
             AND b.user_id = $2
             AND ${ACTIVE_BAN("b")}
         ) AS is_banned
       FROM posts p
       WHERE p.post_id = $1 AND p.deleted_at IS NULL`,
      [postId, req.userId],
    );

    const post = rows[0];
    if (!post) {
      return res.status(404).json({ error: "Post não encontrado" });
    }
    if (post.is_banned) {
      return res
        .status(403)
        .json({ error: "Você está banido desta comunidade" });
    }
    if (!post.is_member) {
      return res
        .status(403)
        .json({ error: "Você precisa participar da comunidade" });
    }

    req.postContext = { postId: post.post_id, communityId: post.community_id };
    next();
  } catch (err) {
    // UUID malformado no path chega aqui como erro de sintaxe do Postgres.
    if ((err as { code?: string }).code === "22P02") {
      return res.status(400).json({ error: "ID de post inválido" });
    }
    next(err);
  }
};
