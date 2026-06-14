import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const boolFromEnv = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0']))
  .transform((v) => v === 'true' || v === '1');

/**
 * Configuration schema.
 *
 * Secrets (TELEGRAM_BOT_TOKEN, PGPASSWORD) come from `.env` (a secret store at deploy time).
 * Everything else is non-secret config and is set in the compose `environment:` block.
 * The `pg` driver reads PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD from the environment
 * automatically, so they are validated here only to fail fast on a misconfigured deploy.
 */
const schema = z.object({
  // --- Secrets ---
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  PGPASSWORD: z.string().min(1, 'PGPASSWORD is required'),

  // --- Postgres connection (config, read by node-postgres via libpq env vars) ---
  PGHOST: z.string().default('postgres'),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGUSER: z.string().default('telegram_bot'),
  PGDATABASE: z.string().default('telegram_bot'),

  // --- Runtime config ---
  DEPLOYMENT_ENV: z.enum(['dev', 'prd']).default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HEALTH_PORT: z.coerce.number().int().positive().default(3000),

  // Which roles this process runs. Both default on (single-container deploy),
  // but each can be split into its own container by toggling these.
  RUN_INGESTOR: boolFromEnv.default('true'),
  RUN_EXECUTOR: boolFromEnv.default('true'),

  // Allowlist behaviour for unknown channels. When true, a channel the bot is
  // newly added to is auto-registered as a DISABLED (pending) row for operator
  // review; when false, unknown channels are ignored entirely (no row created).
  // Either way only channels with enabled = true are logged and acted upon.
  AUTO_REGISTER_CHANNELS: boolFromEnv.default('true'),

  // Executor loop (drains the outbox action queue)
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Optional informational string injected by the deploy pipeline.
  DEPLOY_INFO: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
