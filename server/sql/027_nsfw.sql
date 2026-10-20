-- ===========================================================================
-- FAMAX — 027: Conteúdo adulto (+18)
-- ---------------------------------------------------------------------------
-- communities.is_nsfw — a comunidade inteira é para maiores de 18: tudo nela
--                       conta como +18, ela fica fora da home e só quem tem
--                       users.is_adult entra.
-- posts.is_nsfw       — um post +18 numa comunidade comum.
--
-- users.is_adult (prompt 04) só liga com idade de 18 anos pelo nascimento.
-- Para quem não tem is_adult (e para visitantes) o servidor não manda o
-- conteúdo nem as imagens de um post +18 — só o título, com nsfw_hidden — e
-- os comentários dele respondem 403 (lib/nsfw.ts).
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE communities ADD COLUMN IF NOT EXISTS is_nsfw BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE posts       ADD COLUMN IF NOT EXISTS is_nsfw BOOLEAN NOT NULL DEFAULT FALSE;
