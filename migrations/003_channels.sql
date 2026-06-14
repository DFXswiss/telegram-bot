-- Channel registry + allowlist.
--
-- One bot serves an arbitrary number of channels/groups. Only channels with
-- enabled = TRUE are logged and acted upon (the allowlist). When the bot is
-- added to an unknown channel it is auto-registered as a disabled (pending) row
-- for operator review (controlled by AUTO_REGISTER_CHANNELS); flip enabled =
-- TRUE to activate it. Each channel carries its own configuration.

CREATE TABLE IF NOT EXISTS channels (
  chat_id            BIGINT      PRIMARY KEY,
  title              TEXT,
  chat_type          TEXT,
  enabled            BOOLEAN     NOT NULL DEFAULT FALSE,  -- allowlist gate: log & act only when TRUE
  moderation_enabled BOOLEAN     NOT NULL DEFAULT FALSE,  -- per-channel: allow delete/ban/kick actions
  language           TEXT,                                -- per-channel setting (optional)
  settings           JSONB       NOT NULL DEFAULT '{}'::jsonb, -- arbitrary per-channel config (tier thresholds, ...)
  notes              TEXT,
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ,                         -- bumped on every observed message
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()   -- bumped on config changes
);

CREATE INDEX IF NOT EXISTS channels_enabled_idx ON channels (enabled) WHERE enabled;

-- Backfill: any channel already present in messages was being logged, so treat
-- it as an active channel. Safe no-op on a fresh database.
INSERT INTO channels (chat_id, title, chat_type, enabled, last_seen_at)
SELECT DISTINCT ON (chat_id) chat_id, chat_title, chat_type, TRUE, now()
FROM messages
ORDER BY chat_id
ON CONFLICT (chat_id) DO NOTHING;

-- A logged message must belong to a registered channel. The ingestor registers
-- the channel before logging, so this always holds. ON DELETE RESTRICT prevents
-- dropping a channel that still has logged messages — disable it instead.
ALTER TABLE messages
  ADD CONSTRAINT messages_channel_fk
  FOREIGN KEY (chat_id) REFERENCES channels (chat_id) ON DELETE RESTRICT;
