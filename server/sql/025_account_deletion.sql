-- ===========================================================================
-- FAMAX — 025: Exclusão de conta com prazo para reativar
-- ---------------------------------------------------------------------------
-- DELETE /api/me marca users.deleted_at (o login, o perfil e as sessões
-- passam a recusar a conta na hora) e anonimiza o perfil visível: nome
-- "Usuário removido", sem bio, foto, banner nem redes. O que estava no perfil
-- vai para account_deletions.profile_snapshot, para a reativação devolver.
--
-- Por 30 dias (purge_after) a pessoa pode reativar entrando com a senha. Depois
-- disso o job de exclusão definitiva (lib/account-purge.ts) apaga o snapshot,
-- as imagens, os vínculos (seguidores, salvos, bloqueios, notificações...) e
-- troca e-mail e username por valores sem relação com a pessoa — o e-mail e o
-- username ficam livres para um novo cadastro. Posts, comentários e
-- mensagens continuam, atribuídos a "Usuário removido" (sem eles, conversas e
-- discussões de outras pessoas perderiam o sentido).
--
-- Idempotente.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS account_deletions (
    user_id           UUID        NOT NULL,
    requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    purge_after       TIMESTAMPTZ NOT NULL,
    profile_snapshot  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_account_deletions_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_account_deletions_purge
    ON account_deletions (purge_after);
