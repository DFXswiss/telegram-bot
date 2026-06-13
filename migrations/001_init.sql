-- Initial schema for the Telegram group logger + outbox.
--
-- Design: three decoupled parts communicate only through these two tables.
--   1. INGESTOR  writes every received message into `messages`.
--   2. DECISION  (out of scope today; manual SQL for now) reads `messages`
--      and inserts reply jobs into `outbox` with status='pending'.
--   3. SENDER    reads pending `outbox` rows, sends them, marks them 'sent'.

CREATE TABLE IF NOT EXISTS messages (
  id                  BIGSERIAL PRIMARY KEY,
  chat_id             BIGINT      NOT NULL,
  chat_title          TEXT,
  chat_type           TEXT,
  message_id          BIGINT      NOT NULL,
  thread_id           BIGINT,
  from_user_id        BIGINT,
  from_username       TEXT,
  from_name           TEXT,
  text                TEXT,
  reply_to_message_id BIGINT,
  edited              BOOLEAN     NOT NULL DEFAULT FALSE,
  message_date        TIMESTAMPTZ NOT NULL,
  raw                 JSONB       NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per (chat, message). Re-delivered Telegram updates are deduped via
  -- ON CONFLICT, which makes the ingestor idempotent across restarts.
  UNIQUE (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS messages_chat_date_idx ON messages (chat_id, message_date DESC);

-- Outbound ACTION queue. The decision instance enqueues one of:
--   send_message   -> reply into the chat
--   delete_message -> delete a message (bot must be admin with can_delete_messages)
--   ban_user       -> remove + ban a user (bot must be admin with can_restrict_members)
--   kick_user      -> remove a user but allow rejoin (ban then unban)
-- Status lifecycle: pending -> done | failed
-- Columns are filled per action; the executor validates the required ones.
CREATE TABLE IF NOT EXISTS outbox (
  id                  BIGSERIAL PRIMARY KEY,
  action              TEXT        NOT NULL DEFAULT 'send_message',
  target_chat_id      BIGINT      NOT NULL,

  -- send_message
  text                TEXT,
  reply_to_message_id BIGINT,                       -- telegram message_id to reply to (optional)
  message_thread_id   BIGINT,                       -- forum/topic thread (optional)
  parse_mode          TEXT,                         -- 'Markdown' | 'HTML' | NULL

  -- delete_message
  target_message_id   BIGINT,                       -- message_id to delete

  -- ban_user / kick_user
  target_user_id      BIGINT,                       -- user to remove
  ban_until_date      TIMESTAMPTZ,                  -- optional temp-ban end (NULL = permanent for ban_user)
  revoke_messages     BOOLEAN     NOT NULL DEFAULT FALSE, -- also delete the user's messages on ban

  -- bookkeeping
  status              TEXT        NOT NULL DEFAULT 'pending',
  source_message_id   BIGINT REFERENCES messages(id) ON DELETE SET NULL, -- optional provenance link
  attempts            INTEGER     NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at             TIMESTAMPTZ,
  result_message_id   BIGINT,                       -- message_id of a sent reply (send_message only)
  CONSTRAINT outbox_status_chk CHECK (status IN ('pending', 'done', 'failed')),
  CONSTRAINT outbox_action_chk CHECK (action IN ('send_message', 'delete_message', 'ban_user', 'kick_user'))
);

-- Partial index so the executor's hot-path poll only scans pending rows.
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (id) WHERE status = 'pending';
