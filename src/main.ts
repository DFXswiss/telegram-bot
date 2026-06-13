import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { logger } from './util/logger';
import { migrate } from './db/migrate';
import { pool } from './db/pool';
import { startIngestor } from './ingestor';
import { startExecutor } from './executor';
import { startHealthServer } from './health/server';

async function main(): Promise<void> {
  logger.info(
    {
      env: config.DEPLOYMENT_ENV,
      ingestor: config.RUN_INGESTOR,
      executor: config.RUN_EXECUTOR,
      deploy: config.DEPLOY_INFO,
    },
    'starting telegram-bot',
  );

  await migrate();

  // Polling is only needed for the ingestor. A sender-only process opens a bot
  // without polling so it can call sendMessage without consuming updates.
  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
    polling: config.RUN_INGESTOR,
  });

  const me = await bot.getMe();
  logger.info({ username: me.username, id: me.id }, 'authenticated with telegram');

  if (config.RUN_INGESTOR) startIngestor(bot);
  if (config.RUN_EXECUTOR) startExecutor(bot);

  startHealthServer();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      if (config.RUN_INGESTOR) await bot.stopPolling();
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
