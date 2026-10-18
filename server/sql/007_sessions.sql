-- ===========================================================================
-- FAMAX — 007: Sessão como fonte da verdade
-- ---------------------------------------------------------------------------
-- Até aqui user_sessions era só escrita: o requireAuth validava a assinatura
-- do JWT e mais nada, então não havia como revogar um token. A partir desta
-- migration todo token emitido tem uma linha aqui, identificada pelo jti, e o
-- requireAuth exige sessão existente, não revogada e não expirada.
--
-- O token cru deixa de ser gravado: quem lesse a tabela teria tokens válidos
-- na mão. O jti basta para achar a sessão e não serve para nada sozinho.
--
-- Linhas antigas: não têm jti, então são revogadas e perdem o token cru. O
-- efeito prático é que todos precisam entrar de novo uma vez após o deploy —
-- os tokens do cadastro nem tinham sessão, de qualquer forma.
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS jti          UUID;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ;

ALTER TABLE user_sessions ALTER COLUMN token DROP NOT NULL;

UPDATE user_sessions
   SET revoked_at = COALESCE(revoked_at, NOW()),
       token      = NULL
 WHERE jti IS NULL;

-- Toda request autenticada busca a sessão pelo jti.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_jti ON user_sessions (jti);
