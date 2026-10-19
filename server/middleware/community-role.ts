import type { Request, Response, NextFunction, RequestHandler } from "express";
import { pool } from "../db.js";

export type CommunityRole = "owner" | "moderator" | "member";

declare module "express-serve-static-core" {
  interface Request {
    /** Preenchido por requireCommunityRole — o papel de quem fez o pedido. */
    communityRole?: { communityId: string; role: CommunityRole };
  }
}

/**
 * Hierarquia da moderação: só se age sobre quem está abaixo. Moderador remove
 * conteúdo e bane membros, mas não mexe no dono nem em outro moderador; o
 * dono age sobre todos. Quem não é membro (ou saiu) conta como membro.
 */
const RANK: Record<CommunityRole, number> = { owner: 3, moderator: 2, member: 1 };

export function outranks(actor: CommunityRole | null, target: CommunityRole | null): boolean {
  if (!actor || actor === "member") return false;
  return RANK[actor] > RANK[target ?? "member"];
}

/** Condição SQL de "banimento valendo" sobre um alias de community_bans. */
export const ACTIVE_BAN = (alias: string) =>
  `(${alias}.expires_at IS NULL OR ${alias}.expires_at > NOW())`;

/**
 * Papel do usuário numa comunidade viva, ou null se não for membro (ou se a
 * comunidade não existe / foi excluída).
 */
export async function getCommunityRole(
  communityId: string,
  userId: string | undefined,
): Promise<CommunityRole | null> {
  if (!userId) return null;
  const { rows } = await pool.query<{ role: CommunityRole }>(
    `SELECT cm.role
     FROM community_members cm
     INNER JOIN communities c ON c.community_id = cm.community_id
     WHERE cm.community_id = $1 AND cm.user_id = $2 AND c.deleted_at IS NULL`,
    [communityId, userId],
  );
  return rows[0]?.role ?? null;
}

/** O usuário tem banimento valendo nesta comunidade? */
export async function isBanned(communityId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM community_bans b
     WHERE b.community_id = $1 AND b.user_id = $2 AND ${ACTIVE_BAN("b")}`,
    [communityId, userId],
  );
  return rows.length > 0;
}

/**
 * Exige que req.userId tenha um dos papéis na comunidade resolvida a partir
 * do request — mesmo espírito do requireMembership. Usar depois de
 * requireAuth. Distingue 404 (comunidade inexistente) de 403 (sem papel).
 */
export function requireCommunityRole(
  roles: CommunityRole[],
  resolveCommunityId: (req: Request) => string | undefined,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const communityId = resolveCommunityId(req);
    if (!communityId) {
      return res.status(400).json({ error: "Comunidade não informada" });
    }

    try {
      const { rows } = await pool.query<{ role: CommunityRole | null }>(
        `SELECT
           (SELECT cm.role FROM community_members cm
            WHERE cm.community_id = c.community_id AND cm.user_id = $2) AS role
         FROM communities c
         WHERE c.community_id = $1 AND c.deleted_at IS NULL`,
        [communityId, req.userId],
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Comunidade não encontrada" });
      }
      const role = rows[0].role;
      if (!role || !roles.includes(role)) {
        return res.status(403).json({
          error: roles.includes("moderator")
            ? "Só o dono e os moderadores podem fazer isso"
            : "Só o dono da comunidade pode fazer isso",
        });
      }

      req.communityRole = { communityId, role };
      next();
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") {
        return res.status(400).json({ error: "ID de comunidade inválido" });
      }
      next(err);
    }
  };
}

/** Admin do site (users.is_admin). Usar depois de requireAuth. */
export const requireAdmin: RequestHandler = async (req, res, next) => {
  try {
    const { rows } = await pool.query<{ is_admin: boolean }>(
      "SELECT is_admin FROM users WHERE user_id = $1 AND deleted_at IS NULL",
      [req.userId],
    );
    if (!rows[0]?.is_admin) {
      return res.status(403).json({ error: "Acesso restrito à administração do site" });
    }
    next();
  } catch (err) {
    next(err);
  }
};
