-- ===========================================================================
-- FAMAX — 022: Chat completo e tempo real
-- ---------------------------------------------------------------------------
-- messages.kind
--   'text' (escrita por alguém) ou 'system' ("Ana adicionou Bia ao grupo").
--   Mensagem de sistema tem sender_id = quem fez a ação e não pode ser
--   apagada nem conta como não lida.
--
-- conversation_participants.role
--   'admin' ou 'member'. Em grupo, quem cria é admin (renomeia, adiciona e
--   remove pessoas); se o admin sai, o membro mais antigo assume. Em conversa
--   1:1 o papel não é usado.
--
-- stream_tickets
--   O EventSource do navegador não manda header Authorization, então o
--   GET /api/stream recebe um ticket na query string. O ticket é de uso único
--   e vale 60 s; guarda-se só o hash (SHA-256), como os códigos de
--   recuperação de senha: quem lê o banco não consegue usar um ticket. Fica
--   no banco, e não em memória, porque com mais de uma instância o POST do
--   ticket e o GET do stream podem cair em processos diferentes.
--
-- Idempotente.
-- ===========================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'text';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_kind') THEN
    ALTER TABLE messages
      ADD CONSTRAINT chk_messages_kind CHECK (kind IN ('text', 'system'));
  END IF;
END $$;

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS role VARCHAR(10) NOT NULL DEFAULT 'member';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_participants_role') THEN
    ALTER TABLE conversation_participants
      ADD CONSTRAINT chk_participants_role CHECK (role IN ('admin', 'member'));
  END IF;
END $$;

-- Grupos que já existissem (nenhum, até aqui) ficam com o criador como admin.
UPDATE conversation_participants p
SET role = 'admin'
FROM conversations c
WHERE c.conversation_id = p.conversation_id
  AND c.is_group
  AND p.user_id = c.created_by
  AND p.role <> 'admin';

-- Paginação da lista de conversas por (last_message_at, id).
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_id
  ON conversations (last_message_at DESC, conversation_id DESC);

CREATE TABLE IF NOT EXISTS stream_tickets (
  ticket_hash  TEXT        PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  session_id   UUID        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stream_tickets_expires
  ON stream_tickets (expires_at);
