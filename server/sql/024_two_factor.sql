-- ===========================================================================
-- FAMAX — 024: Verificação em duas etapas (TOTP)
-- ---------------------------------------------------------------------------
-- users.two_factor_enabled já existe no baseline. Aqui:
--
-- users.two_factor_secret / two_factor_pending_secret
--   O segredo TOTP CIFRADO (AES-256-GCM, chave TWO_FACTOR_KEY no ambiente,
--   ver lib/two-factor.ts) — quem lê o banco não gera códigos. O "pending" é
--   o segredo de uma ativação em andamento: só vira o segredo de verdade
--   depois que a pessoa prova que o app gera códigos certos.
--
-- users.two_factor_last_step
--   O último passo de 30 s aceito. Um código já usado não serve de novo
--   (alguém que espiou o código na tela não entra com ele logo depois).
--
-- two_factor_recovery_codes
--   10 códigos de uso único para quando o celular some. Só o hash (HMAC com
--   a mesma chave); os códigos em si aparecem uma vez, ao gerar.
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret         TEXT   NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_secret TEXT   NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_last_step      BIGINT NULL;

CREATE TABLE IF NOT EXISTS two_factor_recovery_codes (
    code_id     UUID        NOT NULL,
    user_id     UUID        NOT NULL,
    code_hash   TEXT        NOT NULL,
    used_at     TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (code_id),
    CONSTRAINT fk_two_factor_recovery_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_two_factor_recovery_user
    ON two_factor_recovery_codes (user_id)
    WHERE used_at IS NULL;
