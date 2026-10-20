-- ===========================================================================
-- FAMAX — 014: Leaderboard real ("Maiores criadores")
-- ---------------------------------------------------------------------------
-- A tabela leaderboard_points já existe no baseline (uma linha por usuário,
-- comunidade e semana). Esta migration só acrescenta:
--
-- famax_week_start(ts)
--   A segunda-feira da semana de `ts`, no horário de Brasília. É a única
--   definição de "semana" do sistema: server/lib/points.ts grava os pontos
--   com ela e a rota do ranking lê a semana atual com ela. Sem fixar o fuso,
--   a virada de domingo para segunda dependeria do TimeZone de cada servidor
--   (e sairia às 21h de domingo em UTC).
--
-- Backfill
--   Recalcula os pontos do conteúdo que já existe, com as mesmas regras de
--   points.ts (post +5, reação recebida +2, comentário recebido +1, conteúdo
--   removido pela moderação −10), cada um na semana em que aconteceu. Sem
--   isto o ranking de uma comunidade antiga começaria zerado. Só roda com a
--   tabela vazia: nunca soma em cima de pontos que o app já gravou.
--
-- Idempotente.
-- ===========================================================================

CREATE OR REPLACE FUNCTION famax_week_start(ts TIMESTAMPTZ)
RETURNS DATE
LANGUAGE SQL
STABLE
AS $$
  SELECT date_trunc('week', ts AT TIME ZONE 'America/Sao_Paulo')::date
$$;

-- "Todos os tempos" soma as semanas de um usuário numa comunidade.
CREATE INDEX IF NOT EXISTS ix_leaderboard_community_user
    ON leaderboard_points (community_id, user_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM leaderboard_points) THEN
    RAISE NOTICE 'leaderboard_points já tem dados — backfill pulado.';
    RETURN;
  END IF;

  INSERT INTO leaderboard_points
    (leaderboard_id, user_id, community_id, points, period_start, period_end)
  SELECT gen_random_uuid(), user_id, community_id, SUM(points)::int,
         period_start, period_start + 6
  FROM (
    -- Post publicado e ainda no ar (apagado pelo autor devolve os pontos).
    SELECT p.author_id AS user_id, p.community_id, 5 AS points,
           famax_week_start(p.created_at) AS period_start
    FROM posts p
    WHERE p.deleted_at IS NULL

    UNION ALL
    -- Reação recebida de outra pessoa, em post no ar.
    SELECT p.author_id, p.community_id, 2, famax_week_start(r.created_at)
    FROM post_reactions r
    INNER JOIN posts p ON p.post_id = r.post_id
    WHERE p.deleted_at IS NULL AND r.user_id <> p.author_id

    UNION ALL
    -- Comentário recebido de outra pessoa, em post no ar.
    SELECT p.author_id, p.community_id, 1, famax_week_start(c.created_at)
    FROM comments c
    INNER JOIN posts p ON p.post_id = c.post_id
    WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND c.author_id <> p.author_id

    UNION ALL
    -- Post removido pela moderação (deleted_by de outra pessoa).
    SELECT p.author_id, p.community_id, -10, famax_week_start(p.deleted_at)
    FROM posts p
    WHERE p.deleted_at IS NOT NULL AND p.deleted_by IS NOT NULL AND p.deleted_by <> p.author_id

    UNION ALL
    -- Comentário removido pela moderação.
    SELECT c.author_id, p.community_id, -10, famax_week_start(c.deleted_at)
    FROM comments c
    INNER JOIN posts p ON p.post_id = c.post_id
    WHERE c.deleted_at IS NOT NULL AND c.deleted_by IS NOT NULL AND c.deleted_by <> c.author_id
  ) AS earned
  GROUP BY user_id, community_id, period_start;
END $$;
