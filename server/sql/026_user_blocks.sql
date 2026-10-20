-- ===========================================================================
-- FAMAX — 026: Bloquear usuário
-- ---------------------------------------------------------------------------
-- Uma linha por (quem bloqueou, quem foi bloqueado). Efeitos (lib/blocks.ts):
--  - nenhum dos dois manda mensagem 1:1 ao outro nem o põe em grupo;
--  - quem bloqueou não vê o bloqueado na busca, e os posts e comentários
--    dele aparecem recolhidos ("conteúdo de usuário bloqueado — mostrar");
--  - o bloqueado não segue quem o bloqueou (e os follows entre os dois
--    caem no bloqueio) nem gera notificação para essa pessoa.
--
-- Idempotente.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id  UUID        NOT NULL,
    blocked_id  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT chk_user_blocks_not_self CHECK (blocker_id <> blocked_id),
    CONSTRAINT fk_user_blocks_blocker
        FOREIGN KEY (blocker_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_user_blocks_blocked
        FOREIGN KEY (blocked_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_user_blocks_blocked ON user_blocks (blocked_id);
