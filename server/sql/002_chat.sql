-- ===========================================================================
-- FAMAX — 002: Sistema de Chat
-- ---------------------------------------------------------------------------
-- Cria as tabelas de mensagens privadas. Estas NÃO fazem parte das 17 tabelas
-- originais do famax_schema.postgres.sql.
--
-- Rodar no SQL Editor do Supabase (mesmo fluxo de _/supabase-migrations.md §2).
-- Idempotente: pode rodar mais de uma vez sem erro.
-- ===========================================================================

-- Conversa. is_group já existe para não exigir migration quando grupos entrarem.
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id  UUID PRIMARY KEY,
  is_group         BOOLEAN     NOT NULL DEFAULT FALSE,
  title            TEXT,
  created_by       UUID        NOT NULL REFERENCES users(user_id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  participant_id   UUID PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(user_id),
  last_read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id       UUID PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_id        UUID NOT NULL REFERENCES users(user_id),
  content          TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);

-- Garante uma única conversa 1:1 por par de usuários.
-- O par é sempre armazenado ordenado (user_a < user_b) para que (A,B) e (B,A)
-- colidam na mesma UNIQUE.
CREATE TABLE IF NOT EXISTS direct_conversation_keys (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_a_id       UUID NOT NULL REFERENCES users(user_id),
  user_b_id       UUID NOT NULL REFERENCES users(user_id),
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);

-- ---------------------------------------------------------------------------
-- Índices
-- O polling do widget bate em (conversation_id, created_at) a cada 3s.
-- Sem estes índices cada tick vira seq scan em messages.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_asc
  ON messages (conversation_id, created_at ASC, message_id);

CREATE INDEX IF NOT EXISTS idx_participants_user
  ON conversation_participants (user_id);

CREATE INDEX IF NOT EXISTS idx_conversations_last_message
  ON conversations (last_message_at DESC);
