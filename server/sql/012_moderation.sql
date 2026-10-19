-- ===========================================================================
-- FAMAX — 012: Moderação, banimentos, denúncias, regras e admin do site
-- ---------------------------------------------------------------------------
-- deleted_by em posts e comentários
--   Com moderadores removendo conteúdo, "apagado" deixa de significar "o
--   autor apagou". Fica registrado quem removeu; ON DELETE SET NULL porque a
--   conta de quem removeu pode ser excluída depois.
--
-- community_bans
--   Uma linha por (comunidade, usuário): banir de novo atualiza motivo e
--   prazo. expires_at NULL = permanente. O ban vencido continua na tabela
--   (histórico), mas deixa de valer — toda checagem filtra por expires_at.
--
-- reports
--   community_id: preenchido para post/comentário, é o que alimenta a fila de
--   cada comunidade. Denúncia de usuário fica sem comunidade e vai para o
--   admin do site. resolution guarda a ação tomada na resolução.
--   O índice único parcial impede a mesma pessoa de ter duas denúncias
--   abertas para o mesmo alvo; depois de resolvida, pode denunciar de novo.
--
-- users.is_admin
--   Papel do site (não de comunidade). Não há rota que conceda: é marcado
--   direto no banco (UPDATE users SET is_admin = true WHERE ...).
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE posts    ADD COLUMN IF NOT EXISTS deleted_by UUID;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS deleted_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_posts_deleted_by') THEN
    ALTER TABLE posts ADD CONSTRAINT fk_posts_deleted_by
      FOREIGN KEY (deleted_by) REFERENCES users(user_id)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_comments_deleted_by') THEN
    ALTER TABLE comments ADD CONSTRAINT fk_comments_deleted_by
      FOREIGN KEY (deleted_by) REFERENCES users(user_id)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS community_bans (
    ban_id          UUID            NOT NULL,
    community_id    UUID            NOT NULL,
    user_id         UUID            NOT NULL,
    banned_by       UUID            NULL,
    reason          TEXT            NULL,
    expires_at      TIMESTAMPTZ     NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ban_id),
    CONSTRAINT uq_community_bans_community_user UNIQUE (community_id, user_id),
    CONSTRAINT fk_community_bans_community
        FOREIGN KEY (community_id) REFERENCES communities(community_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_community_bans_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_community_bans_banned_by
        FOREIGN KEY (banned_by) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_community_bans_user ON community_bans (user_id);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS community_id UUID;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolution VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reports_community') THEN
    ALTER TABLE reports ADD CONSTRAINT fk_reports_community
      FOREIGN KEY (community_id) REFERENCES communities(community_id)
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_reports_community_status
  ON reports (community_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reports_open_per_reporter
  ON reports (reporter_id, target_type, target_id)
  WHERE status IN ('pending', 'reviewing');

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE communities ADD COLUMN IF NOT EXISTS rules TEXT;
