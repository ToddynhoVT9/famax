import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  MAX_COVER_BYTES,
  isStorageEnabled,
  uploadCommunityCover,
} from "../lib/storage.js";

const router = Router();

// Capa fica em memória: o arquivo é validado e repassado ao Storage sem tocar
// o disco, o que evita depender de volume persistente na hospedagem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_COVER_BYTES, files: 1 },
});

/**
 * Subcategorias criadas junto com toda comunidade nova.
 * São exatamente as opções do <select> do modal de criação de post.
 */
const DEFAULT_COMMUNITY_CATEGORIES: Array<{ name: string; slug: string }> = [
  { name: "Guias e Dicas", slug: "guias-e-dicas" },
  { name: "Modding & Add-ons", slug: "modding-e-add-ons" },
  { name: "Hardware & Setup", slug: "hardware-e-setup" },
  { name: "Competitivo / eSports", slug: "competitivo-esports" },
  { name: "Recomendações", slug: "recomendacoes" },
  { name: "Discussão Geral / Off-Topic", slug: "discussao-geral" },
];

// ===========================================================================
// GET /api/categories — popula o <select> da página de criação
// ===========================================================================

router.get("/categories", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT category_id, name, display_order
       FROM categories
       ORDER BY display_order ASC, name ASC`,
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /api/communities — feed da home e sugestões de busca
// ===========================================================================

const listCommunitiesQuery = z.object({
  search: z.string().trim().max(80).optional(),
  categoryId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get("/communities", async (req, res, next) => {
  try {
    const { search, categoryId, page, limit } = listCommunitiesQuery.parse(
      req.query,
    );
    const offset = (page - 1) * limit;

    // communities tem soft delete (deleted_at no schema base) — sem este filtro
    // uma comunidade excluída continuaria aparecendo no feed.
    const filters: string[] = ["c.deleted_at IS NULL"];
    const params: unknown[] = [];

    if (search) {
      params.push(`%${search}%`);
      filters.push(`c.name ILIKE $${params.length}`);
    }
    if (categoryId) {
      params.push(categoryId);
      filters.push(`c.category_id = $${params.length}`);
    }
    const where = `WHERE ${filters.join(" AND ")}`;

    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT
         c.community_id,
         c.name,
         c.description,
         c.cover_image_url,
         c.created_at,
         cat.category_id,
         cat.name AS category_name,
         (SELECT COUNT(*) FROM community_members cm
          WHERE cm.community_id = c.community_id)::int AS members_count
       FROM communities c
       LEFT JOIN categories cat ON cat.category_id = c.category_id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    res.json({ data: rows, pagination: { page, limit } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Parâmetros inválidos", details: err.flatten() });
    }
    next(err);
  }
});

// ===========================================================================
// GET /api/me/communities — "Minhas Comunidades" da sidebar
// ===========================================================================

router.get("/me/communities", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.community_id,
         c.name,
         c.cover_image_url,
         cm.role,
         cm.joined_at
       FROM community_members cm
       INNER JOIN communities c ON c.community_id = cm.community_id
       WHERE cm.user_id = $1
         AND c.deleted_at IS NULL
       ORDER BY cm.joined_at DESC`,
      [req.userId],
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /api/communities — cria comunidade + membership de owner + subcategorias
// ===========================================================================

const createCommunitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "Nome deve ter no mínimo 3 caracteres")
    .max(80, "Nome deve ter no máximo 80 caracteres"),
  categoryId: z.string().uuid("Selecione uma categoria"),
  description: z.string().trim().max(500).optional(),
});

router.post(
  "/communities",
  requireAuth,
  rateLimit({ name: "create-community", limit: 5, windowMs: 60_000 }),
  upload.single("cover"),
  async (req, res, next) => {
    try {
      const data = createCommunitySchema.parse(req.body);
      const communityId = randomUUID();

      // O upload acontece antes da transação: uma falha aqui não deve deixar
      // uma comunidade órfã, e um objeto órfão no Storage é inofensivo.
      let coverUrl: string | null = null;
      if (req.file && isStorageEnabled()) {
        coverUrl = await uploadCommunityCover(req.file.buffer, communityId);
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `INSERT INTO communities
             (community_id, name, description, cover_image_url, category_id, owner_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            communityId,
            data.name,
            data.description ?? null,
            coverUrl,
            data.categoryId,
            req.userId,
          ],
        );

        await client.query(
          `INSERT INTO community_members
             (membership_id, user_id, community_id, role)
           VALUES ($1, $2, $3, 'owner')`,
          [randomUUID(), req.userId, communityId],
        );

        for (const category of DEFAULT_COMMUNITY_CATEGORIES) {
          await client.query(
            `INSERT INTO community_categories
               (community_category_id, community_id, name, slug)
             VALUES ($1, $2, $3, $4)`,
            [randomUUID(), communityId, category.name, category.slug],
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      res.status(201).json({
        community: {
          communityId,
          name: data.name,
          description: data.description ?? null,
          coverImageUrl: coverUrl,
          categoryId: data.categoryId,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Dados inválidos", details: err.flatten() });
      }

      const code = (err as { code?: string }).code;
      if (code === "23505") {
        return res
          .status(409)
          .json({ error: "Já existe uma comunidade com esse nome" });
      }
      if (code === "23503") {
        return res.status(400).json({ error: "Categoria inválida" });
      }
      if (code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "A capa deve ter no máximo 2MB" });
      }

      next(err);
    }
  },
);

// ===========================================================================
// GET /api/communities/:communityId — header da página da comunidade
// ===========================================================================

const communityIdParam = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

router.get("/communities/:communityId", async (req, res, next) => {
  try {
    const { communityId } = communityIdParam.parse(req.params);

    const { rows } = await pool.query(
      `SELECT
         c.community_id,
         c.name,
         c.description,
         c.cover_image_url,
         c.created_at,
         c.owner_id,
         cat.name AS category_name,
         (SELECT COUNT(*) FROM community_members cm
          WHERE cm.community_id = c.community_id)::int AS members_count
       FROM communities c
       LEFT JOIN categories cat ON cat.category_id = c.category_id
       WHERE c.community_id = $1 AND c.deleted_at IS NULL`,
      [communityId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Comunidade não encontrada" });
    }

    const { rows: categories } = await pool.query(
      `SELECT community_category_id, name, slug
       FROM community_categories
       WHERE community_id = $1
       ORDER BY name ASC`,
      [communityId],
    );

    res.json({ community: rows[0], categories });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "ID de comunidade inválido" });
    }
    next(err);
  }
});

// ===========================================================================
// GET /api/communities/:communityId/membership — o usuário atual é membro?
// ===========================================================================

router.get(
  "/communities/:communityId/membership",
  requireAuth,
  async (req, res, next) => {
    try {
      const { communityId } = communityIdParam.parse(req.params);
      const { rows } = await pool.query(
        `SELECT role FROM community_members
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, req.userId],
      );
      res.json({ isMember: rows.length > 0, role: rows[0]?.role ?? null });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "ID de comunidade inválido" });
      }
      next(err);
    }
  },
);

// ===========================================================================
// POST /api/communities/:communityId/join
// ===========================================================================

router.post(
  "/communities/:communityId/join",
  requireAuth,
  async (req, res, next) => {
    try {
      const { communityId } = communityIdParam.parse(req.params);

      const { rows: exists } = await pool.query(
        "SELECT 1 FROM communities WHERE community_id = $1 AND deleted_at IS NULL",
        [communityId],
      );
      if (exists.length === 0) {
        return res.status(404).json({ error: "Comunidade não encontrada" });
      }

      // Idempotente: entrar duas vezes devolve o mesmo resultado.
      await pool.query(
        `INSERT INTO community_members (membership_id, user_id, community_id, role)
         VALUES ($1, $2, $3, 'member')
         ON CONFLICT (user_id, community_id) DO NOTHING`,
        [randomUUID(), req.userId, communityId],
      );

      res.status(200).json({ joined: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "ID de comunidade inválido" });
      }
      next(err);
    }
  },
);

export default router;
