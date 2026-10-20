-- ===========================================================================
-- FAMAX — 018: Mais reações
-- ---------------------------------------------------------------------------
-- reaction_type_enum ganha love, haha, wow e sad (além de like).
--
-- Sobre ALTER TYPE ... ADD VALUE dentro de transação: os dois runners
-- (server/migrate.ts e scripts/migrate.mjs) aplicam cada migration num
-- BEGIN/COMMIT, e o PGlite roda o arquivo como um bloco só. Até o Postgres
-- 11, ADD VALUE é proibido em transação; do 12 em diante é permitido, desde
-- que o valor novo não seja USADO na mesma transação — e esta migration só
-- acrescenta os valores, não insere nada com eles. PGlite é Postgres 17 e o
-- Supabase é 15+, então roda nos dois. (Num Postgres 11, aplique as quatro
-- linhas de ADD VALUE à mão, fora de transação, e depois rode o migrate.)
--
-- Uma reação por pessoa por post
--   O UNIQUE do baseline era (post_id, user_id, type), o que permitiria a
--   mesma pessoa curtir E amar o mesmo post. Agora é (post_id, user_id):
--   trocar de reação substitui a anterior. Até aqui só existia 'like', então
--   não há duplicata a resolver.
--
-- posts.likes_count passa a ser o total de reações de qualquer tipo (é o que
-- o feed mostra, ordena em "Mais curtidos" e pontua no ranking); a contagem
-- por tipo é calculada na leitura (posts.routes.ts).
--
-- Idempotente.
-- ===========================================================================

ALTER TYPE reaction_type_enum ADD VALUE IF NOT EXISTS 'love';
ALTER TYPE reaction_type_enum ADD VALUE IF NOT EXISTS 'haha';
ALTER TYPE reaction_type_enum ADD VALUE IF NOT EXISTS 'wow';
ALTER TYPE reaction_type_enum ADD VALUE IF NOT EXISTS 'sad';

ALTER TABLE post_reactions DROP CONSTRAINT IF EXISTS uq_post_reactions_post_user_type;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_post_reactions_post_user'
  ) THEN
    ALTER TABLE post_reactions
      ADD CONSTRAINT uq_post_reactions_post_user UNIQUE (post_id, user_id);
  END IF;
END $$;
