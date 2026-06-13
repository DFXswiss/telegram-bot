-- Tiered decision + review model (3 tiers).
--
-- The decision LOGIC lives OUTSIDE this repo (manual SQL today; rule scripts or
-- AI later). These tables are only the record: where each tier writes what it
-- decided, how escalation flowed, and the post-hoc reviews used for learning.
-- The executor stays oblivious to tiers — it just drains `outbox`.
--
-- Two mechanisms:
--   1. Escalation  — a tier with outcome 'unsure' makes no binding decision; the
--      next tier decides. Exactly one decision per message is `binding` (the one
--      that drove the action).
--   2. Review      — a higher tier judges an already-binding decision as
--      correct/incorrect. This NEVER changes the executed action; it is an
--      append-only learning signal for the lower tier.

CREATE TABLE IF NOT EXISTS message_decisions (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tier        SMALLINT    NOT NULL,
  -- ignore | answer | spam | unsure  (unsure = abstain -> escalate to next tier)
  outcome     TEXT        NOT NULL,
  -- TRUE for the tier whose outcome actually drove the action.
  binding     BOOLEAN     NOT NULL DEFAULT FALSE,
  decided_by  TEXT,                       -- agent identity: 'manual', 'rule-v3', model name, ...
  confidence  NUMERIC,                    -- optional, 0..1
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT message_decisions_tier_chk CHECK (tier IN (1, 2, 3)),
  CONSTRAINT message_decisions_outcome_chk CHECK (outcome IN ('ignore', 'answer', 'spam', 'unsure')),
  -- one decision per tier per message
  UNIQUE (message_id, tier)
);

CREATE INDEX IF NOT EXISTS message_decisions_message_idx ON message_decisions (message_id);

-- At most one binding decision per message.
CREATE UNIQUE INDEX IF NOT EXISTS message_decisions_one_binding_idx
  ON message_decisions (message_id)
  WHERE binding;

-- Append-only audit/learning layer: a higher tier judging a lower tier's
-- decision. Reviewer_tier should be greater than the reviewed decision's tier
-- (convention, not DB-enforced to avoid triggers).
CREATE TABLE IF NOT EXISTS decision_reviews (
  id               BIGSERIAL PRIMARY KEY,
  decision_id      BIGINT      NOT NULL REFERENCES message_decisions(id) ON DELETE CASCADE,
  reviewer_tier    SMALLINT    NOT NULL,
  assessment       TEXT        NOT NULL,  -- correct | incorrect
  should_have_been TEXT,                  -- the outcome the reviewer considers right (optional)
  note             TEXT,                  -- learning signal / rationale
  reviewed_by      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_reviews_tier_chk CHECK (reviewer_tier IN (1, 2, 3)),
  CONSTRAINT decision_reviews_assessment_chk CHECK (assessment IN ('correct', 'incorrect')),
  CONSTRAINT decision_reviews_should_chk
    CHECK (should_have_been IS NULL OR should_have_been IN ('ignore', 'answer', 'spam', 'unsure'))
);

CREATE INDEX IF NOT EXISTS decision_reviews_decision_idx ON decision_reviews (decision_id);

-- Link executed actions back to the binding decision that produced them
-- (a single 'spam' decision can spawn several outbox rows: delete + kick).
ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS decision_id BIGINT REFERENCES message_decisions(id) ON DELETE SET NULL;
