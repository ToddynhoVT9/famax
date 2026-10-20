-- ===========================================================================
-- FAMAX — 017: Post fixado e resposta aceita
-- ---------------------------------------------------------------------------
-- posts.pinned_at
--   Preenchido quando o dono ou um moderador fixa o post (até 3 por
--   comunidade, regra da rota). Os fixados vêm primeiro no feed, o fixado
--   mais recentemente no topo.
--
-- posts.resolved_comment_id
--   O comentário que o autor marcou como "resposta aceita"; com ele o post
--   conta como resolvido e sai da aba "Ajudar os outros". ON DELETE SET NULL
--   cobre a exclusão física; a exclusão lógica (deleted_at) é tratada no
--   removeComment.
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned_at           TIMESTAMPTZ NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS resolved_comment_id UUID        NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_posts_resolved_comment'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT fk_posts_resolved_comment
      FOREIGN KEY (resolved_comment_id) REFERENCES comments(comment_id)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Contar e listar os fixados de uma comunidade.
CREATE INDEX IF NOT EXISTS ix_posts_community_pinned
    ON posts (community_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;
