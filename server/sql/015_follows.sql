-- ===========================================================================
-- FAMAX — 015: Seguir usuários
-- ---------------------------------------------------------------------------
-- A tabela follows já existe no baseline (com UNIQUE e CHECK anti-self-
-- follow). Esta migration acrescenta:
--
-- ix_follows_follower_created / ix_follows_following_created
--   As listas "Seguindo" e "Seguidores" são paginadas por (created_at, id),
--   mais recentes primeiro. O feed "Seguindo" da home parte do follower_id.
--
-- uq_notifications_follow
--   No máximo um aviso "começou a seguir você" por par de pessoas: seguir,
--   deixar de seguir e seguir de novo atualiza o mesmo aviso em vez de
--   empilhar vários (o unfollow também apaga o aviso — ver follows.routes).
--
-- user_settings.notify_follows
--   Preferência do aviso de novo seguidor, ligada por padrão como as da 013.
--
-- Idempotente.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS ix_follows_follower_created
    ON follows (follower_id, created_at DESC, follow_id DESC);

CREATE INDEX IF NOT EXISTS ix_follows_following_created
    ON follows (following_id, created_at DESC, follow_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_follow
    ON notifications (user_id, actor_id)
    WHERE type = 'follow';

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_follows BOOLEAN NOT NULL DEFAULT TRUE;
