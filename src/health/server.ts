import { createServer } from 'http';
import { pool } from '../db/pool';
import { config } from '../config';
import { logger } from '../util/logger';

/**
 * Tiny health endpoint for the container healthcheck / status dashboard.
 * GET /health -> 200 when the database is reachable, 503 otherwise.
 */
export function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    pool
      .query('SELECT 1')
      .then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', env: config.DEPLOYMENT_ENV }));
      })
      .catch((err) => {
        logger.error({ err }, 'health check failed');
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error' }));
      });
  });

  server.listen(config.HEALTH_PORT, () =>
    logger.info({ port: config.HEALTH_PORT }, 'health server listening'),
  );
}
