-- ===========================================================================
-- FAMAX — 029: Quem vê o aniversário
-- ---------------------------------------------------------------------------
-- A data de nascimento passa a ser pedida no cadastro (idade mínima de 13
-- anos, up3 · prompt 01). Até aqui ela nunca aparecia para os outros; agora a
-- pessoa escolhe se o aniversário (só dia e mês, nunca o ano) aparece no
-- perfil:
--
--   'self'      — só ela (o padrão, e o que valia para todo mundo antes);
--   'following' — as pessoas que ELA segue;
--   'everyone'  — qualquer um que possa ver o perfil.
--
-- Perfil privado continua mandando: quem não pode ver o perfil não vê o
-- aniversário, qualquer que seja esta opção (users.routes).
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS birthday_visibility VARCHAR(10) NOT NULL DEFAULT 'self';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_profiles_birthday_visibility'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT chk_user_profiles_birthday_visibility
      CHECK (birthday_visibility IN ('self', 'following', 'everyone'));
  END IF;
END
$$;
