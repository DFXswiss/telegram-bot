import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../util/logger';

/**
 * Shared connection pool. Connection parameters are taken from the standard
 * libpq environment variables (PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD),
 * which `pg` reads automatically. We pass them explicitly from validated config
 * so a misconfigured deploy fails fast in config/index.ts rather than here.
 */
export const pool = new Pool({
  host: config.PGHOST,
  port: config.PGPORT,
  user: config.PGUSER,
  database: config.PGDATABASE,
  password: config.PGPASSWORD,
  max: 10,
});

pool.on('error', (err) => {
  // Idle client errors must not crash the process — log and let pg recover.
  logger.error({ err }, 'unexpected postgres pool error');
});
