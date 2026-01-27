import type { Logger } from 'pino';
import type { EventQueue, Metrics, AgentIdentity, AgentState, Channel } from '../types/index.js';
import { createLogger, type LoggerConfig } from './logger.js';
import { createEventQueue } from './event-queue.js';
import { createMetrics } from './metrics.js';
import { type Agent, createAgent, type AgentConfig } from './agent.js';
import { type EventBus, createEventBus } from './event-bus.js';
import { type EventLoop, type EventLoopConfig, createEventLoop } from './event-loop.js';
import { type LayerProcessor, createLayerProcessor } from '../layers/layer-processor.js';
import { type RuleEngine, createRuleEngine, createDefaultRules } from '../rules/index.js';
import {
  type TelegramChannel,
  createTelegramChannel,
  type TelegramConfig,
} from '../channels/index.js';
import { type UserModel, createNewUserWithModel } from '../models/user-model.js';
import { type MessageComposer, createMessageComposer } from '../llm/composer.js';
import { type OpenRouterProvider, createOpenRouterProvider } from '../llm/openrouter.js';

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
  /** Telegram configuration */
  telegram?: TelegramConfig;
  /** Primary user configuration (for proactive contact) */
  primaryUser?: {
    /** User's name */
    name?: string;
    /** Telegram chat ID to send proactive messages to */
    telegramChatId?: string;
    /** User's timezone offset from UTC in hours (e.g., -5 for EST) */
    timezoneOffset?: number;
  };
  /** LLM configuration */
  llm?: {
    /** OpenRouter API key */
    openRouterApiKey?: string;
    /** Fast model for classification (cheap) */
    fastModel?: string;
    /** Smart model for composition (expensive) */
    smartModel?: string;
  };
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
  /** Layer processor (brain pipeline) */
  layerProcessor: LayerProcessor;
  /** Rule engine */
  ruleEngine: RuleEngine;
  /** The event loop (heartbeat) */
  eventLoop: EventLoop;
  /** Telegram channel (optional, depends on config) */
  telegramChannel: TelegramChannel | null;
  /** All registered channels */
  channels: Map<string, Channel>;
  /** User model for tracking user beliefs (optional) */
  userModel: UserModel | null;
  /** LLM provider (optional) */
  llmProvider: OpenRouterProvider | null;
  /** Message composer (optional, needs LLM provider) */
  messageComposer: MessageComposer | null;
  /** Primary user's Telegram chat ID (for proactive messages) */
  primaryUserChatId: string | null;
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

  // Create layer processor (brain pipeline)
  const layerProcessor = createLayerProcessor(logger);

  // Create rule engine and load default rules
  const ruleEngine = createRuleEngine(logger);
  for (const rule of createDefaultRules()) {
    ruleEngine.addRule(rule);
  }

  // Get primary user chat ID
  const primaryUserChatId =
    config.primaryUser?.telegramChatId ?? process.env['PRIMARY_USER_CHAT_ID'] ?? null;

  // Create UserModel if primary user configured
  let userModel: UserModel | null = null;
  if (primaryUserChatId) {
    const userName = config.primaryUser?.name ?? 'User';
    const timezoneOffset = config.primaryUser?.timezoneOffset ?? 0;
    userModel = createNewUserWithModel(primaryUserChatId, userName, logger, timezoneOffset);
    logger.info({ userId: primaryUserChatId, userName }, 'UserModel created for primary user');
  } else {
    logger.debug('UserModel not created (no primary user configured)');
  }

  // Create LLM provider if configured
  let llmProvider: OpenRouterProvider | null = null;
  const openRouterApiKey = config.llm?.openRouterApiKey ?? process.env['OPENROUTER_API_KEY'] ?? '';
  if (openRouterApiKey) {
    const fastModel = config.llm?.fastModel ?? process.env['LLM_FAST_MODEL'];
    const smartModel = config.llm?.smartModel ?? process.env['LLM_SMART_MODEL'];

    const llmConfig: Parameters<typeof createOpenRouterProvider>[0] = {
      apiKey: openRouterApiKey,
    };
    if (fastModel) llmConfig.fastModel = fastModel;
    if (smartModel) llmConfig.smartModel = smartModel;

    llmProvider = createOpenRouterProvider(llmConfig, logger);
  } else {
    logger.debug('LLM provider not configured (no API key)');
  }

  // Create MessageComposer if LLM available
  let messageComposer: MessageComposer | null = null;
  if (llmProvider) {
    const identity = agentConfig.identity ?? agent.getIdentity();
    messageComposer = createMessageComposer(llmProvider, identity);
    logger.info('MessageComposer configured');
  }

  // Attach composer to expression layer if available
  if (messageComposer) {
    layerProcessor.setComposer(messageComposer);
  }

  // Create event loop config with primary user chat ID
  const eventLoopConfig: Partial<EventLoopConfig> = {
    ...config.eventLoop,
  };
  if (primaryUserChatId) {
    eventLoopConfig.primaryUserChatId = primaryUserChatId;
  }

  // Create event loop (wired to layer processor, rule engine, and proactive messaging deps)
  const eventLoop = createEventLoop(
    agent,
    eventQueue,
    eventBus,
    layerProcessor,
    ruleEngine,
    logger,
    metrics,
    eventLoopConfig,
    {
      messageComposer: messageComposer ?? undefined,
      userModel: userModel ?? undefined,
    }
  );

  // Create channels registry
  const channels = new Map<string, Channel>();

  // Create Telegram channel if configured
  let telegramChannel: TelegramChannel | null = null;
  const telegramConfig = config.telegram ?? {
    botToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
  };

  if (telegramConfig.botToken) {
    telegramChannel = createTelegramChannel(telegramConfig, eventQueue, logger);
    channels.set('telegram', telegramChannel);
    eventLoop.registerChannel(telegramChannel);
    logger.info('Telegram channel configured');
  } else {
    logger.debug('Telegram channel not configured (no bot token)');
  }

  // Shutdown function
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    eventLoop.stop();

    // Stop all channels
    for (const channel of channels.values()) {
      if (channel.stop) {
        await channel.stop();
      }
    }
  };

  return {
    logger,
    eventQueue,
    eventBus,
    metrics,
    agent,
    layerProcessor,
    ruleEngine,
    eventLoop,
    telegramChannel,
    channels,
    userModel,
    llmProvider,
    messageComposer,
    primaryUserChatId,
    shutdown,
  };
}
