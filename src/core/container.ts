import type { Logger } from 'pino';
import type { EventQueue, Metrics, AgentIdentity, AgentState } from '../types/index.js';
import { createLogger, type LoggerConfig } from './logger.js';
import { createEventQueue } from './event-queue.js';
import { createMetrics } from './metrics.js';
import { type Agent, createAgent, type AgentConfig } from './agent.js';
import { type EventBus, createEventBus } from './event-bus.js';
import { type EventLoop, createEventLoop, type EventLoopConfig } from './event-loop.js';

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
  /** Agent configuration */
  agent?: {
    /** Agent identity (name, personality, etc.) */
    identity?: AgentIdentity;
    /** Initial agent state */
    initialState?: Partial<AgentState>;
    /** Tick rate configuration */
    tickRate?: AgentConfig['tickRate'];
    /** Social debt accumulation rate */
    socialDebtRate?: number;
  };
  /** Event loop configuration */
  eventLoop?: Partial<EventLoopConfig>;
}

/**
 * Container holding all application dependencies.
 */
export interface Container {
  /** Application logger */
  logger: Logger;
  /** Event queue */
  eventQueue: EventQueue;
  /** Event bus for pub/sub */
  eventBus: EventBus;
  /** Metrics collector */
  metrics: Metrics;
  /** The agent */
  agent: Agent;
  /** The event loop (heartbeat) */
  eventLoop: EventLoop;
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

  // Build agent config, only including defined values
  const agentConfig: AgentConfig = {};
  if (config.agent?.identity !== undefined) {
    agentConfig.identity = config.agent.identity;
  }
  if (config.agent?.initialState !== undefined) {
    agentConfig.initialState = config.agent.initialState;
  }
  if (config.agent?.tickRate !== undefined) {
    agentConfig.tickRate = config.agent.tickRate;
  }
  if (config.agent?.socialDebtRate !== undefined) {
    agentConfig.socialDebtRate = config.agent.socialDebtRate;
  }

  // Create agent
  const agent = createAgent({ logger, eventQueue, metrics }, agentConfig);

  // Create event bus
  const eventBus = createEventBus(logger);

  // Create event loop
  const eventLoop = createEventLoop(agent, eventQueue, eventBus, logger, metrics, config.eventLoop);

  // Shutdown function
  const shutdown = (): Promise<void> => {
    logger.info('Shutting down...');
    eventLoop.stop();
    return Promise.resolve();
  };

  return {
    logger,
    eventQueue,
    eventBus,
    metrics,
    agent,
    eventLoop,
    shutdown,
  };
}
