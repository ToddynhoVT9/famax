-- ===========================================================================
-- FAMAX — 013: Notificações
-- ---------------------------------------------------------------------------
-- notifications
--   Uma linha por aviso. type é texto com CHECK (e não ENUM) porque novos
--   tipos chegam com frequência e ALTER TYPE ... ADD VALUE não roda dentro de
--   transação em todas as versões do Postgres. mention, follow e event já
--   estão liberados para o prompt de engajamento.
--
--   post_id, comment_id e community_id têm FK com CASCADE: se o alvo some de
--   verdade do banco, o aviso some junto. (Soft delete é filtrado na leitura.)
--   actor_id fica NULL se a conta de quem agiu for excluída.
--
-- Curtidas agrupadas
--   post_like tem no máximo UMA linha por (destinatário, post) — o índice
--   único parcial garante. Cada curtida nova atualiza a linha (quem curtiu
--   por último, volta a "não lida"); o "e mais N" é contado na leitura.
--
-- Preferências em user_settings, ligadas por padrão. Moderação e mudança de
-- papel não têm opção de desligar: são avisos sobre a própria conta.
--
-- Idempotente.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID            NOT NULL,
    user_id         UUID            NOT NULL,
    type            VARCHAR(30)     NOT NULL,
    actor_id        UUID            NULL,
    post_id         UUID            NULL,
    comment_id      UUID            NULL,
    community_id    UUID            NULL,
    data            JSONB           NOT NULL DEFAULT '{}'::jsonb,
    read_at         TIMESTAMPTZ     NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_id),
    CONSTRAINT chk_notifications_type CHECK (type IN (
        'post_comment', 'comment_reply', 'post_like', 'content_removed',
        'community_role', 'mention', 'follow', 'event'
    )),
    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_notifications_actor
        FOREIGN KEY (actor_id) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_notifications_post
        FOREIGN KEY (post_id) REFERENCES posts(post_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_notifications_comment
        FOREIGN KEY (comment_id) REFERENCES comments(comment_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_notifications_community
        FOREIGN KEY (community_id) REFERENCES communities(community_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_notifications_user_created
  ON notifications (user_id, created_at DESC, notification_id DESC);

CREATE INDEX IF NOT EXISTS ix_notifications_user_unread
  ON notifications (user_id)
  WHERE read_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_post_like
  ON notifications (user_id, post_id)
  WHERE type = 'post_like';

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_likes    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_comments BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_replies  BOOLEAN NOT NULL DEFAULT TRUE;
