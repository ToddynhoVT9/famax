-- ===========================================================================
-- FAMAX — 005: Bucket das capas de comunidade
-- ---------------------------------------------------------------------------
-- O Supabase Storage guarda a definição dos buckets em storage.buckets, então
-- dá para criar o bucket por SQL — não precisa do painel.
--
-- Bucket público: a capa aparece nos cards da home para visitantes não
-- autenticados. O upload continua exigindo a service key (que ignora RLS),
-- então "público" vale só para leitura.
--
-- O bloco condicional mantém a migration segura fora do Supabase (o harness de
-- teste roda num Postgres puro, sem o schema storage).
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets
      (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'community-covers',
      'community-covers',
      TRUE,
      2097152,  -- 2MB, igual ao limite validado no backend
      ARRAY['image/png', 'image/jpeg', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE
      SET public             = EXCLUDED.public,
          file_size_limit    = EXCLUDED.file_size_limit,
          allowed_mime_types = EXCLUDED.allowed_mime_types;

    RAISE NOTICE 'Bucket community-covers pronto.';
  ELSE
    RAISE NOTICE 'Schema storage ausente — bucket ignorado (não é Supabase).';
  END IF;
END $$;
