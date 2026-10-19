-- ===========================================================================
-- FAMAX — 009: Recuperação de senha de verdade
-- ---------------------------------------------------------------------------
-- A tabela password_recovery existe desde o schema base, mas nunca foi usada
-- (a tela era uma simulação). Ajustes para o fluxo real:
--
--   code_hash     HMAC-SHA256 do código (ver auth.routes.ts). O código cru não
--                 é gravado: com 6 dígitos, um hash simples seria quebrado por
--                 força bruta em segundos por quem lesse a tabela; o HMAC usa
--                 um segredo que não está no banco.
--   attempts      tentativas erradas; na 5ª o código é invalidado.
--   verified_at   código conferido; a partir daí só vale o resetToken.
--   used_at       senha trocada com esta recuperação.
--
-- is_used continua sendo "esta recuperação não serve mais" (usada, substituída
-- por um código novo ou bloqueada por tentativas).
--
-- recovery_code perde o NOT NULL e o índice: não há mais o que procurar
-- por código. Linhas antigas (não deveriam existir) são invalidadas.
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE password_recovery ADD COLUMN IF NOT EXISTS code_hash   VARCHAR(64);
ALTER TABLE password_recovery ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE password_recovery ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE password_recovery ADD COLUMN IF NOT EXISTS used_at     TIMESTAMPTZ;

ALTER TABLE password_recovery ALTER COLUMN recovery_code DROP NOT NULL;

UPDATE password_recovery
   SET is_used = TRUE,
       recovery_code = NULL
 WHERE code_hash IS NULL;

DROP INDEX IF EXISTS ix_password_recovery_code;

-- A verificação busca a recuperação mais recente e ativa do usuário.
CREATE INDEX IF NOT EXISTS ix_password_recovery_user_active
  ON password_recovery (user_id, created_at DESC)
  WHERE is_used = FALSE;
