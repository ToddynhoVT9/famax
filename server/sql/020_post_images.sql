-- ===========================================================================
-- FAMAX — 020: Imagens em posts
-- ---------------------------------------------------------------------------
-- Até 4 imagens por post (regra da rota, posts.routes.ts), guardadas no
-- bucket user-media do Storage (migration 008) — o mesmo de avatar e banner,
-- na pasta posts/<post_id>/. Aqui fica só a URL pública e a ordem.
--
-- position é a ordem de exibição na grade (0 a 3). Excluir o post (de
-- verdade) leva as linhas junto; o soft delete as mantém, como os
-- comentários.
--
-- Idempotente.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS post_images (
    image_id    UUID            NOT NULL,
    post_id     UUID            NOT NULL,
    url         VARCHAR(500)    NOT NULL,
    position    SMALLINT        NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (image_id),
    CONSTRAINT fk_post_images_post
        FOREIGN KEY (post_id) REFERENCES posts(post_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_post_images_post
    ON post_images (post_id, position, created_at);
