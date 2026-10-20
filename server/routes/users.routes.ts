import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { loadSocialLinks, profileAccess } from "../lib/profile.js";
import { nsfwHiddenSql } from "../lib/nsfw.js";
import { parseWith } from "../middleware/error.js";

const router = Router();

// ===========================================================================
// GET /api/users?search= — busca de pessoas para iniciar uma conversa
// ===========================================================================

const searchQuery = z.object({
  search: z.string().trim().min(1, "Informe um termo de busca").max(50),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

router.get("/users", requireAuth, async (req, res, next) => {
  try {
    const { search, limit } = parseWith(searchQuery, req.query, "Parâmetros inválidos");

    // Perfil privado só aparece para quem JÁ tem conversa com ele: a busca
    // serve para reencontrar contatos, não para descobrir contas privadas.
    // Perfis públicos aparecem para todos. Sem linha em user_settings conta
    // como privado: todo cadastro grava a linha, então a falta dela é anomalia
    // — e na dúvida não se expõe a conta.
    const { rows } = await pool.query(
      `SELECT
         u.user_id,
         u.username,
         up.display_name,
         up.avatar_url
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.user_id
       LEFT JOIN user_settings us ON us.user_id = u.user_id
       WHERE u.deleted_at IS NULL
         AND u.user_id <> $1
         AND (u.username ILIKE $2 OR up.display_name ILIKE $2)
         -- Busca do chat: com bloqueio (em qualquer sentido) não há conversa.
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
              OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
         )
         AND (
           COALESCE(us.is_private, TRUE) = FALSE
           OR EXISTS (
             SELECT 1
             FROM conversation_participants me
             INNER JOIN conversation_participants them
                     ON them.conversation_id = me.conversation_id
             WHERE me.user_id = $1
               AND them.user_id = u.user_id
           )
         )
       ORDER BY u.username ASC
       LIMIT $3`,
      [req.userId, `%${search}%`, limit],
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /api/users/:userId — perfil público
// ---------------------------------------------------------------------------
// optionalAuth: visitante vê perfis públicos. Perfil privado visto por outra
// pessoa devolve só o cartão de identificação (nome, @, avatar) e
// isPrivate: true — o suficiente para a tela dizer "perfil privado" sem
// vazar bio, contadores ou redes.
// ===========================================================================

const userIdParam = z.object({
  userId: z.string().uuid("ID de usuário inválido"),
});

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});


router.get("/users/:userId", optionalAuth, async (req, res, next) => {
  try {
    const { userId } = parseWith(userIdParam, req.params, "Parâmetros inválidos");

    const access = await profileAccess(userId, req.userId);
    if (!access) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    // Os contadores só olham conteúdo visível: post/comentário apagado ou
    // em comunidade apagada não conta.
    const { rows } = await pool.query(
      `SELECT
         u.user_id,
         u.username,
         u.created_at,
         up.display_name,
         up.nickname,
         up.avatar_url,
         up.banner_url,
         up.bio,
         (SELECT COUNT(*)::int
            FROM posts p
            INNER JOIN communities c ON c.community_id = p.community_id
           WHERE p.author_id = u.user_id
             AND p.deleted_at IS NULL
             AND c.deleted_at IS NULL) AS posts_count,
         (SELECT COUNT(*)::int
            FROM comments cm
            INNER JOIN posts p       ON p.post_id = cm.post_id
            INNER JOIN communities c ON c.community_id = p.community_id
           WHERE cm.author_id = u.user_id
             AND cm.deleted_at IS NULL
             AND p.deleted_at IS NULL
             AND c.deleted_at IS NULL) AS comments_count,
         (SELECT COUNT(*)::int
            FROM community_members m
            INNER JOIN communities c ON c.community_id = m.community_id
           WHERE m.user_id = u.user_id
             AND c.deleted_at IS NULL) AS communities_count,
         (SELECT COUNT(*)::int
            FROM follows f
            INNER JOIN users fu ON fu.user_id = f.follower_id AND fu.deleted_at IS NULL
           WHERE f.following_id = u.user_id) AS followers_count,
         (SELECT COUNT(*)::int
            FROM follows f
            INNER JOIN users fu ON fu.user_id = f.following_id AND fu.deleted_at IS NULL
           WHERE f.follower_id = u.user_id) AS following_count,
         EXISTS (
           SELECT 1 FROM follows f
           WHERE f.follower_id = $2 AND f.following_id = u.user_id
         ) AS followed_by_me,
         EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE b.blocker_id = $2 AND b.blocked_id = u.user_id
         ) AS blocked_by_me
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.user_id
       WHERE u.user_id = $1`,
      [userId, req.userId ?? null],
    );
    const row = rows[0];

    if (!access.canView) {
      return res.json({
        user: {
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          isPrivate: true,
          isOwner: false,
          // O botão Seguir funciona mesmo no perfil privado.
          followedByMe: row.followed_by_me,
          blockedByMe: row.blocked_by_me,
        },
      });
    }

    res.json({
      user: {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        nickname: row.nickname,
        avatarUrl: row.avatar_url,
        bannerUrl: row.banner_url,
        bio: row.bio,
        createdAt: row.created_at,
        isPrivate: access.isPrivate,
        isOwner: access.isOwner,
        followedByMe: row.followed_by_me,
        blockedByMe: row.blocked_by_me,
        stats: {
          posts: row.posts_count,
          comments: row.comments_count,
          communities: row.communities_count,
          followers: row.followers_count,
          following: row.following_count,
        },
        socialLinks: await loadSocialLinks(userId),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /api/users/by-username/:username — resolve @username em id
// ---------------------------------------------------------------------------
// Os links de menção (@fulano no texto) apontam para o perfil pelo username;
// a página do perfil usa isto para chegar ao id. Sem distinção de maiúsculas,
// como a extração de menções do servidor. Só o id: o perfil em si continua
// vindo de GET /users/:userId, com as regras de privacidade de lá.
// ===========================================================================

const usernameParam = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_]{3,50}$/, "Username inválido"),
});

router.get("/users/by-username/:username", async (req, res, next) => {
  try {
    const { username } = parseWith(usernameParam, req.params, "Parâmetros inválidos");
    const { rows } = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL",
      [username],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }
    res.json({ user: { userId: rows[0].user_id } });
  } catch (err) {
    next(err);
  }
});

/**
 * Validação comum às listagens do perfil: usuário existe e quem pede pode ver.
 * Perfil privado de outra pessoa é 403 (a existência já é pública pelo
 * GET /users/:userId; o que se protege é o conteúdo).
 */
async function guardListing(
  req: Request,
  res: Response,
): Promise<{ userId: string; page: number; limit: number } | null> {
  const { userId } = parseWith(userIdParam, req.params, "Parâmetros inválidos");
  const { page, limit } = parseWith(pageQuery, req.query, "Parâmetros inválidos");

  const access = await profileAccess(userId, req.userId);
  if (!access) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return null;
  }
  if (!access.canView) {
    res.status(403).json({ error: "Este perfil é privado" });
    return null;
  }
  return { userId, page, limit };
}

// ===========================================================================
// GET /api/users/:userId/posts — aba "Posts" do perfil
// ===========================================================================

router.get("/users/:userId/posts", optionalAuth, async (req, res, next) => {
  try {
    const guard = await guardListing(req, res);
    if (!guard) return;
    const { userId, page, limit } = guard;

    // Post +18 para quem não pode ver: só o título (lib/nsfw.ts).
    const { rows } = await pool.query(
      `SELECT
         p.post_id,
         p.title,
         CASE WHEN ${nsfwHiddenSql("$4", "p", "c")} THEN '' ELSE p.content END AS content,
         (p.is_nsfw OR c.is_nsfw) AS is_nsfw,
         ${nsfwHiddenSql("$4", "p", "c")} AS nsfw_hidden,
         p.likes_count,
         p.comments_count,
         p.created_at,
         c.community_id,
         c.name AS community_name
       FROM posts p
       INNER JOIN communities c ON c.community_id = p.community_id
       WHERE p.author_id = $1
         AND p.deleted_at IS NULL
         AND c.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.post_id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, (page - 1) * limit, req.userId ?? null],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM posts p
       INNER JOIN communities c ON c.community_id = p.community_id
       WHERE p.author_id = $1 AND p.deleted_at IS NULL AND c.deleted_at IS NULL`,
      [userId],
    );
    const total = countRows[0].total;

    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /api/users/:userId/comments — aba "Respostas" do perfil
// ===========================================================================

router.get("/users/:userId/comments", optionalAuth, async (req, res, next) => {
  try {
    const guard = await guardListing(req, res);
    if (!guard) return;
    const { userId, page, limit } = guard;

    const { rows } = await pool.query(
      `SELECT
         cm.comment_id,
         cm.content,
         cm.created_at,
         p.post_id,
         p.title AS post_title,
         c.community_id,
         c.name AS community_name
       FROM comments cm
       INNER JOIN posts p       ON p.post_id = cm.post_id
       INNER JOIN communities c ON c.community_id = p.community_id
       WHERE cm.author_id = $1
         AND cm.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND c.deleted_at IS NULL
       ORDER BY cm.created_at DESC, cm.comment_id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, (page - 1) * limit],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM comments cm
       INNER JOIN posts p       ON p.post_id = cm.post_id
       INNER JOIN communities c ON c.community_id = p.community_id
       WHERE cm.author_id = $1
         AND cm.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND c.deleted_at IS NULL`,
      [userId],
    );
    const total = countRows[0].total;

    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
