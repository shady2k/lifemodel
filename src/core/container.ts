import type { Logger } from 'pino';
import type { EventQueue, Metrics } from '../types/index.js';
import { createLogger, type LoggerConfig } from './logger.js';
import { createEventQueue } from './event-queue.js';
import { createMetrics } from './metrics.js';

/**
 * Application configuration.
 */
export interface AppConfig {
  /** Log directory */
  logDir?: string;
  /** Maximum log files to keep */
  maxLogFiles?: number;
  /** Log level */
  logLevel?: LoggerConfig['level'];
  /** Enable pretty logging */
  prettyLogs?: boolean;
}

/**
 * Container holding all application dependencies.
 */
export interface Container {
  /** Application logger */
  logger: Logger;
  /** Event queue */
  eventQueue: EventQueue;
  /** Metrics collector */
  metrics: Metrics;
  /** Shutdown function */
  shutdown: () => Promise<void>;
}

/**
 * Create the application container with all dependencies wired up.
 *
 * This is the composition root - all dependencies are created here
 * and passed to components via constructor injection.
 */
export function createContainer(config: AppConfig = {}): Container {
  // Build logger config, only including defined values
  const loggerConfig: Partial<LoggerConfig> = {};
  if (config.logDir !== undefined) {
    loggerConfig.logDir = config.logDir;
  }
  if (config.maxLogFiles !== undefined) {
    loggerConfig.maxFiles = config.maxLogFiles;
  }
  if (config.logLevel !== undefined) {
    loggerConfig.level = config.logLevel;
  }
  if (config.prettyLogs !== undefined) {
    loggerConfig.pretty = config.prettyLogs;
  }

  // Create logger
  const logger = createLogger(loggerConfig);

  // Create event queue
  const eventQueue = createEventQueue();

  // Create metrics
  const metrics = createMetrics();

  // Shutdown function
  const shutdown = (): Promise<void> => {
    logger.info('Shutting down...');
    // Add cleanup logic here as needed
    return Promise.resolve();
  };

  return {
    logger,
    eventQueue,
    metrics,
    shutdown,
  };
}
