-- ===========================================================================
-- FAMAX — 021: Eventos da comunidade
-- ---------------------------------------------------------------------------
-- community_events
--   Criados pelo dono ou por moderadores (regra da rota, events.routes.ts).
--   location é texto livre: um endereço ou um link (o front transforma em
--   link quando começa com http/https). ends_at é opcional; sem ele, o
--   evento "acaba" quando começa, para efeito de próximos × anteriores.
--   Soft delete (deleted_at) como posts: o aviso de um evento cancelado some
--   da lista de notificações.
--
-- event_attendees
--   Quem marcou "Vou". Chave composta: marcar duas vezes é impossível.
--
-- notifications.event_id
--   O aviso "novo evento" aponta para o evento (CASCADE se ele for apagado
--   de verdade); type 'event' já era aceito pelo CHECK da 013.
--
-- user_settings.notify_events
--   Preferência do aviso de evento novo, ligada por padrão.
--
-- Idempotente.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS community_events (
    event_id        UUID            NOT NULL,
    community_id    UUID            NOT NULL,
    created_by      UUID            NULL,
    title           VARCHAR(150)    NOT NULL,
    description     TEXT            NULL,
    starts_at       TIMESTAMPTZ     NOT NULL,
    ends_at         TIMESTAMPTZ     NULL,
    location        VARCHAR(300)    NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NULL,
    deleted_at      TIMESTAMPTZ     NULL,
    PRIMARY KEY (event_id),
    CONSTRAINT chk_community_events_period CHECK (ends_at IS NULL OR ends_at >= starts_at),
    CONSTRAINT fk_community_events_community
        FOREIGN KEY (community_id) REFERENCES communities(community_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_community_events_creator
        FOREIGN KEY (created_by) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_community_events_community_starts
    ON community_events (community_id, starts_at)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS event_attendees (
    event_id    UUID        NOT NULL,
    user_id     UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, user_id),
    CONSTRAINT fk_event_attendees_event
        FOREIGN KEY (event_id) REFERENCES community_events(event_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_event_attendees_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_notifications_event'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT fk_notifications_event
      FOREIGN KEY (event_id) REFERENCES community_events(event_id)
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_events BOOLEAN NOT NULL DEFAULT TRUE;
