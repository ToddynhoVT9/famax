-- ===========================================================================
-- FAMAX — 011: Busca (comunidades, usuários e posts)
-- ---------------------------------------------------------------------------
-- pg_trgm (similaridade por trigramas) deixa a busca de nomes tolerar erro de
-- digitação e achar pedaços do meio da palavra. Nem todo Postgres permite
-- criar a extensão (o PGlite só tem se for carregado explicitamente; alguns
-- provedores restringem), então a criação é tentada dentro de um bloco com
-- EXCEPTION: sem ela, a migration passa e a busca cai para ILIKE (ver
-- server/lib/search.ts, que detecta a extensão em tempo de execução).
--
-- Posts usam full-text do próprio Postgres (sem extensão): uma coluna gerada
-- com o tsvector em português, título com peso A e conteúdo com peso B, e um
-- índice GIN. Coluna gerada = o banco mantém sozinha a cada INSERT/UPDATE.
--
-- Idempotente.
-- ===========================================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm indisponível (%): a busca de nomes usará ILIKE.', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_communities_name_trgm
               ON communities USING gin (name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_users_username_trgm
               ON users USING gin (username gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_user_profiles_display_name_trgm
               ON user_profiles USING gin (display_name gin_trgm_ops)';
  END IF;
END $$;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('portuguese', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(content, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS ix_posts_search_vector
  ON posts USING gin (search_vector);
