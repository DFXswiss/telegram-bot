import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { env: config.DEPLOYMENT_ENV },
  transport:
    config.DEPLOYMENT_ENV === 'dev'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
});
