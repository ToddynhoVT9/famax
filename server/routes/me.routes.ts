import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// ===========================================================================
// GET /api/me — usuário logado, com perfil e configurações
// ---------------------------------------------------------------------------
// Uma chamada por página (o front guarda em cache): é a base do header, das
// guardas de página e, mais adiante, da edição de perfil.
// ===========================================================================

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    // birth_date vai como texto: o pg converte DATE em Date à meia-noite do
    // fuso do servidor, e o JSON (UTC) podia mostrar o dia anterior.
    const { rows } = await pool.query(
      `SELECT
         u.user_id,
         u.email,
         u.username,
         u.is_adult,
         u.two_factor_enabled,
         u.created_at,
         up.display_name,
         up.avatar_url,
         up.banner_url,
         up.bio,
         up.nickname,
         up.birth_date::text AS birth_date,
         up.gender,
         us.is_private
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.user_id
       LEFT JOIN user_settings us ON us.user_id = u.user_id
       WHERE u.user_id = $1`,
      [req.userId],
    );

    const row = rows[0];
    if (!row) {
      // O requireAuth já garante que o usuário existe; só chega aqui numa
      // corrida com a exclusão da conta.
      return res.status(401).json({ error: "Token inválido ou expirado" });
    }

    res.json({
      user: {
        userId: row.user_id,
        email: row.email,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        bannerUrl: row.banner_url,
        bio: row.bio,
        nickname: row.nickname,
        birthDate: row.birth_date,
        gender: row.gender,
        // Mesma regra da busca de usuários: sem linha de settings, privado.
        isPrivate: row.is_private ?? true,
        isAdult: row.is_adult,
        twoFactorEnabled: row.two_factor_enabled,
        createdAt: row.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
