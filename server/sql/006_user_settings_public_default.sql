-- ===========================================================================
-- FAMAX — 006: Perfil público por padrão
-- ---------------------------------------------------------------------------
-- O schema base criava user_settings.is_private com DEFAULT TRUE. Somado à
-- regra da busca do chat (perfil privado só aparece para quem já conversa com
-- ele), isso tornava toda conta nova impossível de encontrar. O padrão passa a
-- ser público; quem quiser escolhe "privado" no cadastro.
--
-- Só muda o DEFAULT da coluna: contas já existentes mantêm a escolha que está
-- gravada. Idempotente.
-- ===========================================================================

ALTER TABLE user_settings ALTER COLUMN is_private SET DEFAULT FALSE;
