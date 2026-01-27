import pino from 'pino';

/**
 * Application logger using Pino.
 *
 * Full configuration (file rotation, max 10 files) will be implemented in Phase 2.
 * For now, basic console logging with pino-pretty in development.
 */
export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
});
