-- ===========================================================================
-- FAMAX — 003: Índices complementares
-- ---------------------------------------------------------------------------
-- O schema base (_/DB.psql) já cobre quase tudo que os sistemas de comentários
-- e likes exercitam. Conferido índice a índice:
--
--   listagem de posts da comunidade  → ix_posts_community_created        (existe)
--   listagem de comentários do post  → ix_comments_post_created          (existe)
--   toggle de like                   → uq_post_reactions_post_user_type  (existe)
--   checagem de membership           → uq_community_members_user_community (existe)
--   "minhas comunidades"             → mesma UNIQUE, coluna líder user_id (existe)
--   contagem de membros              → ix_community_members_community    (existe)
--   subcategorias da comunidade      → uq_community_categories_community_slug (existe)
--
-- Sobra apenas a ordenação do feed da home, que não tem índice no schema base.
--
-- Idempotente. `comments.deleted_at` já existe no schema base — nenhum ALTER
-- é necessário aqui.
-- ===========================================================================

-- GET /api/communities ordena por created_at DESC para montar o feed.
CREATE INDEX IF NOT EXISTS ix_communities_created
  ON communities (created_at DESC);
