-- ===========================================================================
-- FAMAX — 004: Seed das categorias globais
-- ---------------------------------------------------------------------------
-- Todo o fluxo de criação de comunidade depende de um category_id (FK) válido.
-- Se a tabela `categories` subiu vazia, o POST /api/communities falha no
-- primeiro submit. Este seed cobre as categorias do <select> do esboço
-- (nova-comunidade.html) mais as seções do feed da home.
--
-- Idempotente via ON CONFLICT no nome (UNIQUE conforme _/data-base.md §10).
-- ===========================================================================

INSERT INTO categories (category_id, name, display_order) VALUES
  (gen_random_uuid(), 'Jogos',   1),
  (gen_random_uuid(), 'Animes',  2),
  (gen_random_uuid(), 'Estudo',  3),
  (gen_random_uuid(), 'Arte',    4),
  (gen_random_uuid(), 'Lazer',   5),
  (gen_random_uuid(), 'Música',  6),
  (gen_random_uuid(), 'Outros', 99)
ON CONFLICT (name) DO NOTHING;

-- Conferência:
--   SELECT name, display_order FROM categories ORDER BY display_order;
