# telegram-bot

Logs **every** message of a Telegram group to PostgreSQL and sends replies that
were queued in an `outbox` table. No AI — deterministic TypeScript only. The
"decide what to answer" step is intentionally **out of scope**: a separate
instance (manual SQL today, a rule script or AI later) reads the logged messages
and writes reply jobs into `outbox`. This bot only does the two token-free,
always-identical jobs: **log** and **send**.

## Architecture

```
Telegram group ──getUpdates──▶ INGESTOR ──▶  messages  table
                                                  ▲
   reply  ◀──sendMessage── SENDER ◀── outbox ◀────┘
                                       ▲
                              DECISION instance
                          (out of scope; manual today)
```

Three decoupled parts communicate only through two tables:

1. **Ingestor** (`src/ingestor`) — receives all messages via long-polling and
   writes each into `messages` (idempotent via `ON CONFLICT`).
2. **Decision instance** (not in this repo) — reads `messages`, inserts rows into
   `outbox` (`status = 'pending'`). Today this is done by hand (see actions below).
3. **Executor** (`src/executor`) — polls `outbox` for pending rows
   (`FOR UPDATE SKIP LOCKED`), performs each action, marks it `done` (or `failed`
   after `OUTBOX_MAX_ATTEMPTS`).

### Outbox actions

The `outbox.action` column selects what the executor does. Columns are filled per
action; the executor validates the required ones.

| `action` | Effect | Required columns | Telegram permission needed |
|---|---|---|---|
| `send_message` | Reply into the chat | `target_chat_id`, `text` (opt. `reply_to_message_id`, `parse_mode`) | — |
| `delete_message` | Delete a message | `target_chat_id`, `target_message_id` | admin + *Delete messages* |
| `ban_user` | Remove & ban a user | `target_chat_id`, `target_user_id` (opt. `ban_until_date`, `revoke_messages`) | admin + *Ban users* |
| `kick_user` | Remove a user, allow rejoin | `target_chat_id`, `target_user_id` (opt. `revoke_messages`) | admin + *Ban users* |

```sql
-- reply
INSERT INTO outbox (action, target_chat_id, reply_to_message_id, text)
VALUES ('send_message', -1001234567890, 42, 'Danke für deine Nachricht!');

-- delete a message
INSERT INTO outbox (action, target_chat_id, target_message_id)
VALUES ('delete_message', -1001234567890, 42);

-- remove a user (and delete their messages), allow rejoin
INSERT INTO outbox (action, target_chat_id, target_user_id, revoke_messages)
VALUES ('kick_user', -1001234567890, 987654321, true);

-- permanent ban
INSERT INTO outbox (action, target_chat_id, target_user_id)
VALUES ('ban_user', -1001234567890, 987654321);
```

> The `chat_id` and `user_id` / `message_id` you need are exactly the
> `chat_id`, `from_user_id` and `message_id` columns logged in `messages`.

### ⚠️ Admin rights for moderation

`delete_message`, `ban_user` and `kick_user` only work if the bot is a **group
administrator** with the *Delete messages* and *Ban users* permissions. This is
separate from privacy mode: privacy mode governs *reading*, admin rights govern
*acting*. A bot can never delete/ban another admin or the group owner.

## Tiered decision model (3 tiers)

The decision logic is **not part of this repo** (manual SQL today; rule scripts
or AI later). This DB only *records* it, in two tables (`migrations/002`):

- **`message_decisions`** — one row per `(message, tier)`. `outcome` is one of
  `ignore | answer | spam | unsure`. `unsure` = abstain → the next tier decides.
  Exactly one row per message is `binding = true` (the tier whose outcome drove
  the action). Each enqueued `outbox` row links back via `outbox.decision_id`.
- **`decision_reviews`** — append-only. A higher tier judges an already-binding
  decision (`assessment = correct | incorrect`, optional `should_have_been` +
  `note`). This **never** changes the executed action — it is purely a learning
  signal for the lower tier.

Two mechanisms:

1. **Escalation** — Tier 1 decides, or marks `unsure`; on `unsure` Tier 2 makes
   the binding decision; if Tier 2 is also `unsure`, Tier 3 does. Same pattern
   continued consistently.
2. **Review / learning** — Tier 2 (or 3) may later flag a binding decision as
   wrong. The message was already handled, so nothing changes operationally, but
   the verdict is logged as feedback for the tier that decided.

```sql
-- Tier 1 is unsure -> abstains (no action yet)
INSERT INTO message_decisions (message_id, tier, outcome, binding, decided_by)
VALUES (123, 1, 'unsure', false, 'manual');

-- Tier 2 takes over and decides spam -> this is the BINDING decision
INSERT INTO message_decisions (message_id, tier, outcome, binding, decided_by, reason)
VALUES (123, 2, 'spam', true, 'manual', 'crypto scam link')
RETURNING id;  -- say it returns 55

-- Tier 2's binding decision drives the actual moderation (linked via decision_id)
INSERT INTO outbox (action, target_chat_id, target_message_id, decision_id)
VALUES ('delete_message', -1001234567890, 42, 55);
INSERT INTO outbox (action, target_chat_id, target_user_id, revoke_messages, decision_id)
VALUES ('kick_user', -1001234567890, 987654321, true, 55);

-- Later, Tier 3 reviews decision 55 and considers it wrong -> learning signal,
-- no operational effect (the user was already removed).
INSERT INTO decision_reviews (decision_id, reviewer_tier, assessment, should_have_been, note)
VALUES (55, 3, 'incorrect', 'answer', 'legitimate user, link was to our own docs');
```

## ⚠️ Telegram Privacy Mode — required setup

A bot only receives **all** group messages when its privacy mode is **disabled**:

> @BotFather → `/setprivacy` → select the bot → **Disable**

With privacy mode on (the Telegram default) the bot sees only commands,
@mentions and replies to itself — and this logger will record almost nothing.
After disabling, **remove and re-add** the bot to the group for the change to
take effect.

## Configuration

Secrets live in `.env` (see `.env.example`); everything else is set in the
deploy compose `environment:` block.

| Var | Kind | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | secret | — | Bot token from @BotFather |
| `PGPASSWORD` | secret | — | Postgres password |
| `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE` | config | `postgres`/`5432`/`telegram_bot`/`telegram_bot` | DB connection |
| `DEPLOYMENT_ENV` | config | `dev` | `dev` \| `prd` |
| `LOG_LEVEL` | config | `info` | pino level |
| `HEALTH_PORT` | config | `3000` | `/health` port |
| `RUN_INGESTOR` / `RUN_EXECUTOR` | config | `true` | toggle roles (split into separate containers if desired) |
| `OUTBOX_POLL_INTERVAL_MS` | config | `3000` | executor idle poll interval |
| `OUTBOX_BATCH_SIZE` | config | `10` | rows claimed per loop |
| `OUTBOX_MAX_ATTEMPTS` | config | `5` | retries before a row is parked `failed` |

## Local development

```bash
npm install
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN and PGPASSWORD
docker compose up --build
```

Or without Docker (needs a local Postgres):

```bash
npm install
npm run migrate:dev
npm run dev
```

## Deployment

The image is built and pushed by CI (`.github/workflows/`): the `develop` branch
publishes the `:beta` tag, `main` publishes `:latest` (linux/arm64). Run the
container next to a PostgreSQL instance and provide the environment above.

Because the message log cannot be re-derived from anywhere, treat its database as
**critical**: put its data on durable storage and enable a real backup
(WAL archiving / point-in-time recovery).

### Go-live checklist

1. **@BotFather**: create the bot(s) and disable privacy mode (see above).
2. Provide `TELEGRAM_BOT_TOKEN` and `PGPASSWORD` from your secret store as `.env`;
   set the remaining config in the deployment's `environment:`.
3. Run the container with a reachable PostgreSQL; migrations apply on start.
4. Add the bot to the target group(s) — and grant it admin rights if you want it
   to delete messages or remove users. It logs from that point on.
```
