-- ===========================================================================
-- FAMAX — 016: Ordenação do feed da comunidade
-- ---------------------------------------------------------------------------
-- GET /communities/:id/posts?sort=new|top|comments|hot (posts.routes.ts).
--
--   new       já coberto por ix_posts_community_created (baseline).
--   top       likes_count — índice abaixo.
--   comments  comments_count — índice abaixo.
--   hot       depende de NOW() (decaimento pelo tempo), então não há índice
--             que o sirva: é calculado sobre os posts vivos da comunidade.
--
-- Índices parciais (só posts no ar): o feed nunca lista post apagado, e o
-- índice fica menor.
--
-- Idempotente.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS ix_posts_community_likes
    ON posts (community_id, likes_count DESC, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_posts_community_comments
    ON posts (community_id, comments_count DESC, created_at DESC)
    WHERE deleted_at IS NULL;
