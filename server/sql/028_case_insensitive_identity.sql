-- ===========================================================================
-- FAMAX — 028: E-mail e username sem diferença de maiúsculas
-- ---------------------------------------------------------------------------
-- Os UNIQUE do baseline (uq_users_email, uq_users_username) comparam o texto
-- exato: "Ana@x.com" e "ana@x.com" viravam duas contas, e as rotas que já
-- comparavam com lower() (recuperar senha, troca de e-mail, by-username,
-- menções) pegavam uma delas sem ordem definida.
--
-- users.email          — guardado sempre em minúsculas (o zod das rotas
--                        também normaliza). Pending_email já era gravado assim.
-- users.username       — continua com a grafia que a pessoa escolheu (é o
--                        nome exibido); só a comparação ignora maiúsculas.
-- uq_users_email_lower / uq_users_username_lower
--                      — a unicidade de verdade, e o índice que as consultas
--                        com lower(...) = lower($1) usam.
--
-- Se já houver duas contas com o mesmo e-mail ou username em grafias
-- diferentes, a migration PARA com a lista: escolher qual conta fica é
-- decisão de quem administra o banco, não da migration. Para conferir antes:
--
--   SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(username), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
--
-- Idempotente.
-- ===========================================================================

DO $$
DECLARE
  emails    TEXT;
  usernames TEXT;
BEGIN
  SELECT string_agg(format('%s (%s contas)', k, n), ', ')
    INTO emails
    FROM (SELECT lower(email) AS k, count(*) AS n FROM users GROUP BY 1 HAVING count(*) > 1) d;
  SELECT string_agg(format('%s (%s contas)', k, n), ', ')
    INTO usernames
    FROM (SELECT lower(username) AS k, count(*) AS n FROM users GROUP BY 1 HAVING count(*) > 1) d;

  IF emails IS NOT NULL OR usernames IS NOT NULL THEN
    RAISE EXCEPTION 'Contas duplicadas sem diferença de maiúsculas. Resolva antes de aplicar a 028. E-mails: %. Usernames: %.',
      COALESCE(emails, 'nenhum'), COALESCE(usernames, 'nenhum');
  END IF;
END
$$;

UPDATE users SET email = lower(email) WHERE email <> lower(email);
UPDATE users SET pending_email = lower(pending_email) WHERE pending_email <> lower(pending_email);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_lower ON users (lower(username));
