import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { pool } from './pool';
import { logger } from '../util/logger';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/**
 * Minimal forward-only migration runner. Each .sql file in migrations/ is applied
 * once, in lexical order, and recorded in schema_migrations. Idempotent: already
 * applied files are skipped, so it is safe to run on every container start.
 */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      logger.info({ file }, 'applying migration');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    logger.info('migrations up to date');
  } finally {
    client.release();
  }
}

// Allow `npm run migrate` to run standalone.
if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
