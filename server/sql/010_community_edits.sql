-- ===========================================================================
-- FAMAX — 010: Edição de posts/comentários e exclusão de comunidade
-- ---------------------------------------------------------------------------
-- edited_at em posts e comentários
--   O "(editado)" não pode vir de posts.updated_at: o trigger
--   posts_set_updated_at dispara em QUALQUER UPDATE, e likes_count e
--   comments_count são atualizados na própria linha do post a cada curtida e
--   comentário — quase todo post apareceria como editado. edited_at só é
--   gravado pelas rotas de edição. comments nem tinha coluna de atualização.
--
-- Nome único só entre comunidades ativas
--   A exclusão de comunidade é soft delete (deleted_at). Com a UNIQUE
--   original, o nome de uma comunidade excluída ficava preso para sempre.
--   Vira índice único parcial: mesma regra (nome exato, 23505 no conflito),
--   mas ignorando as excluídas.
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE posts    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

ALTER TABLE communities DROP CONSTRAINT IF EXISTS uq_communities_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_communities_name_active
  ON communities (name)
  WHERE deleted_at IS NULL;

-- "Ajudar os outros" filtra posts sem comentário dentro da comunidade.
CREATE INDEX IF NOT EXISTS ix_posts_community_unanswered
  ON posts (community_id, created_at DESC)
  WHERE comments_count = 0 AND deleted_at IS NULL;
