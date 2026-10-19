-- ===========================================================================
-- FAMAX — 008: Bucket de avatar e banner dos usuários
-- ---------------------------------------------------------------------------
-- Mesmo padrão da 005 (capas de comunidade). Bucket público: avatar e banner
-- aparecem para visitantes. O upload exige a service key, então "público"
-- vale só para leitura.
--
-- Limite de 2MB no bucket = o maior dos dois (banner). O avatar tem limite
-- menor (1MB), validado no backend.
--
-- O bloco condicional mantém a migration segura fora do Supabase.
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
      'user-media',
      'user-media',
      TRUE,
      2097152,
      ARRAY['image/png', 'image/jpeg', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE
      SET public             = EXCLUDED.public,
          file_size_limit    = EXCLUDED.file_size_limit,
          allowed_mime_types = EXCLUDED.allowed_mime_types;

    RAISE NOTICE 'Bucket user-media pronto.';
  ELSE
    RAISE NOTICE 'Schema storage ausente — bucket ignorado (não é Supabase).';
  END IF;
END $$;
