-- ===========================================================================
-- FAMAX — 023: Verificação de e-mail
-- ---------------------------------------------------------------------------
-- users.email_verified_at
--   Quando a pessoa clicou no link de verificação (null = não verificado).
--   Sem verificação ela navega, publica e comenta, mas não cria comunidade
--   nem manda mensagem no chat (ver middleware/verified-email.ts).
--
-- users.pending_email
--   Troca de e-mail: o novo endereço fica aqui até ser confirmado pelo link
--   enviado a ELE. Até lá o login e a recuperação de senha continuam no e-mail
--   antigo — trocar para um endereço que não é seu não tira a conta de você.
--
-- Contas que já existiam contam como verificadas (desde o cadastro): a regra
-- é nova, e travar quem já usava o site por um e-mail que nunca foi pedido
-- seria punir todo mundo de uma vez.
--
-- As colunas são idempotentes; o UPDATE de "já verificadas" vale para a
-- única vez em que a migration roda.
-- ===========================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ  NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email     VARCHAR(255) NULL;

-- A migration roda uma vez só (schema_migrations): depois dela, null passa a
-- significar "ainda não verificou".
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
