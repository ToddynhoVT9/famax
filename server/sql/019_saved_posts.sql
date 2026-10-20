-- ===========================================================================
-- FAMAX — 019: Posts salvos ("favoritos")
-- ---------------------------------------------------------------------------
-- Uma linha por (usuário, post). Chave primária composta: salvar duas vezes
-- é impossível por construção, e o POST de salvar vira um ON CONFLICT DO
-- NOTHING. A lista é privada (só o dono vê, em GET /me/saved), mais recentes
-- primeiro — daí o índice por (user_id, created_at).
--
-- Post apagado (soft delete) continua na tabela mas some da lista; apagado
-- de verdade, a linha vai junto (CASCADE).
--
-- Idempotente.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS saved_posts (
    user_id     UUID        NOT NULL,
    post_id     UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id),
    CONSTRAINT fk_saved_posts_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_saved_posts_post
        FOREIGN KEY (post_id) REFERENCES posts(post_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_saved_posts_user_created
    ON saved_posts (user_id, created_at DESC);
