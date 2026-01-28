import type { Logger } from 'pino';
import type { Metrics, AgentIdentity, AgentState, Channel } from '../types/index.js';
import { createLogger, type LoggerConfig } from './logger.js';
import { createMetrics } from './metrics.js';
import { type Agent, createAgent, type AgentConfig } from './agent.js';
import { type EventBus, createEventBus } from './event-bus.js';
import {
  type CoreLoop,
  type CoreLoopConfig,
  type CoreLoopLayers,
  createCoreLoop,
} from './core-loop.js';
import {
  createAutonomicProcessor,
  createAggregationProcessor,
  createCognitionProcessor,
  createSmartProcessor,
} from '../layers/index.js';
import {
  type TelegramChannel,
  createTelegramChannel,
  type TelegramConfig,
} from '../channels/index.js';
import { type UserModel, createUserModel, createNewUserWithModel } from '../models/user-model.js';
import { type MessageComposer, createMessageComposer } from '../llm/composer.js';
import type { LLMProvider } from '../llm/provider.js';
import { createOpenRouterProvider } from '../llm/openrouter.js';
import { createOpenAICompatibleProvider } from '../llm/openai-compatible.js';
import { createMultiProvider } from '../llm/multi-provider.js';
import {
  type Storage,
  type StateManager,
  type ConversationManager,
  createJSONStorage,
  createStateManager,
  createConversationManager,
} from '../storage/index.js';
import { type LearningEngine, createLearningEngine } from '../learning/index.js';
import { type MergedConfig, loadConfig } from '../config/index.js';
import { type JsonMemoryProvider, createJsonMemoryProvider } from '../storage/memory-provider.js';
import { type CognitionLLM } from '../layers/cognition/agentic-loop.js';
import { createLLMAdapter } from '../layers/cognition/llm-adapter.js';

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
  /** Core loop configuration */
  coreLoop?: Partial<CoreLoopConfig>;
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
    /** Fast model for classification via OpenRouter (cheap) */
    fastModel?: string;
    /** Smart model for composition via OpenRouter (expensive) */
    smartModel?: string;
    /** Local model configuration (OpenAI-compatible API) */
    local?: {
      /** Base URL of the local server (e.g., http://localhost:1234) */
      baseUrl?: string;
      /** Model name to use */
      model?: string;
      /** Use local model for fast role */
      useForFast?: boolean;
      /** Use local model for smart role */
      useForSmart?: boolean;
    };
  };
}

/**
 * Container holding all application dependencies.
 */
export interface Container {
  /** Application logger */
  logger: Logger;
  /** Event bus for pub/sub */
  eventBus: EventBus;
  /** Metrics collector */
  metrics: Metrics;
  /** The agent */
  agent: Agent;
  /** 4-layer processors */
  layers: CoreLoopLayers;
  /** The core loop (heartbeat) */
  coreLoop: CoreLoop;
  /** Telegram channel (optional, depends on config) */
  telegramChannel: TelegramChannel | null;
  /** All registered channels */
  channels: Map<string, Channel>;
  /** User model for tracking user beliefs (optional) */
  userModel: UserModel | null;
  /** LLM provider (optional) */
  llmProvider: LLMProvider | null;
  /** Message composer (optional, needs LLM provider) */
  messageComposer: MessageComposer | null;
  /** COGNITION LLM adapter (optional, for agentic loop) */
  cognitionLLM: CognitionLLM | null;
  /** Memory provider (optional, for agentic loop) */
  memoryProvider: JsonMemoryProvider | null;
  /** Primary user's Telegram chat ID (for proactive messages) */
  primaryUserChatId: string | null;
  /** Storage backend */
  storage: Storage | null;
  /** State manager for persistence */
  stateManager: StateManager | null;
  /** Conversation manager for history */
  conversationManager: ConversationManager | null;
  /** Learning engine for self-learning */
  learningEngine: LearningEngine | null;
  /** Loaded configuration */
  config: MergedConfig | null;
  /** Shutdown function */
  shutdown: () => Promise<void>;
}

/**
 * Create the 4-layer processors.
 */
function createLayers(logger: Logger): CoreLoopLayers {
  return {
    autonomic: createAutonomicProcessor(logger),
    aggregation: createAggregationProcessor(logger),
    cognition: createCognitionProcessor(logger),
    smart: createSmartProcessor(logger),
  };
}

/**
 * LLM provider config type that allows undefined values.
 */
interface LLMProviderConfig {
  openRouterApiKey?: string | null | undefined;
  fastModel?: string | undefined;
  smartModel?: string | undefined;
  local?:
    | {
        baseUrl?: string | null | undefined;
        model?: string | null | undefined;
        useForFast?: boolean | undefined;
        useForSmart?: boolean | undefined;
      }
    | undefined;
}

/**
 * Create LLM provider from config.
 */
function createLLMProvider(
  config: LLMProviderConfig | undefined,
  logger: Logger
): LLMProvider | null {
  const openRouterApiKey = config?.openRouterApiKey ?? process.env['OPENROUTER_API_KEY'] ?? '';
  const localBaseUrl = config?.local?.baseUrl ?? process.env['LLM_LOCAL_BASE_URL'];
  const localModel = config?.local?.model ?? process.env['LLM_LOCAL_MODEL'];
  const useLocalForFast =
    config?.local?.useForFast ?? process.env['LLM_LOCAL_USE_FOR_FAST'] === 'true';
  const useLocalForSmart =
    config?.local?.useForSmart ?? process.env['LLM_LOCAL_USE_FOR_SMART'] === 'true';

  // Create OpenRouter provider if configured
  let openRouterProvider = null;
  if (openRouterApiKey) {
    const fastModel = config?.fastModel ?? process.env['LLM_FAST_MODEL'];
    const smartModel = config?.smartModel ?? process.env['LLM_SMART_MODEL'];

    openRouterProvider = createOpenRouterProvider(
      {
        apiKey: openRouterApiKey,
        ...(fastModel && { fastModel }),
        ...(smartModel && { smartModel }),
      },
      logger
    );
  }

  // Create local provider if configured
  let localProvider = null;
  if (localBaseUrl && localModel) {
    localProvider = createOpenAICompatibleProvider(
      {
        baseUrl: localBaseUrl,
        model: localModel,
        name: 'local',
      },
      logger
    );
  }

  // Create multi-provider if we have both, or use single provider
  if (localProvider && openRouterProvider) {
    const multiProvider = createMultiProvider(
      {
        fast: useLocalForFast ? localProvider : openRouterProvider,
        smart: useLocalForSmart ? localProvider : openRouterProvider,
        default: openRouterProvider,
      },
      logger
    );
    logger.info(
      {
        fastProvider: useLocalForFast ? 'local' : 'openrouter',
        smartProvider: useLocalForSmart ? 'local' : 'openrouter',
      },
      'MultiProvider configured'
    );
    return multiProvider;
  } else if (localProvider) {
    logger.info('Local LLM provider configured');
    return localProvider;
  } else if (openRouterProvider) {
    logger.info('OpenRouter LLM provider configured');
    return openRouterProvider;
  }

  logger.debug('LLM provider not configured');
  return null;
}

/**
 * Create the application container with all dependencies wired up.
 *
 * This is the composition root - all dependencies are created here
 * and passed to components via constructor injection.
 *
 * For async initialization (loading config and state), use createContainerAsync.
 */
export function createContainer(config: AppConfig = {}): Container {
  // Build logger config
  const loggerConfig: Partial<LoggerConfig> = {};
  if (config.logDir !== undefined) loggerConfig.logDir = config.logDir;
  if (config.maxLogFiles !== undefined) loggerConfig.maxFiles = config.maxLogFiles;
  if (config.logLevel !== undefined) loggerConfig.level = config.logLevel;
  if (config.prettyLogs !== undefined) loggerConfig.pretty = config.prettyLogs;

  // Create logger
  const logger = createLogger(loggerConfig);

  // Create metrics
  const metrics = createMetrics();

  // Build agent config
  const agentConfig: AgentConfig = {};
  if (config.agent?.identity !== undefined) agentConfig.identity = config.agent.identity;
  if (config.agent?.initialState !== undefined)
    agentConfig.initialState = config.agent.initialState;
  if (config.agent?.tickRate !== undefined) agentConfig.tickRate = config.agent.tickRate;
  if (config.agent?.socialDebtRate !== undefined)
    agentConfig.socialDebtRate = config.agent.socialDebtRate;

  // Create agent (without eventQueue - CoreLoop doesn't use it)
  const agent = createAgent({ logger, metrics }, agentConfig);

  // Create event bus
  const eventBus = createEventBus(logger);

  // Get primary user chat ID
  const primaryUserChatId =
    config.primaryUser?.telegramChatId ?? process.env['PRIMARY_USER_CHAT_ID'] ?? null;

  // Create UserModel if primary user configured
  let userModel: UserModel | null = null;
  if (primaryUserChatId) {
    const userName = config.primaryUser?.name ?? null;
    const timezoneOffset = config.primaryUser?.timezoneOffset ?? 0;
    userModel = createNewUserWithModel(primaryUserChatId, userName, logger, timezoneOffset);
    logger.info({ userId: primaryUserChatId, userName }, 'UserModel created for primary user');
  }

  // Create LLM provider
  const llmProvider = createLLMProvider(config.llm, logger);

  // Create MessageComposer if LLM available
  let messageComposer: MessageComposer | null = null;
  if (llmProvider) {
    const identity = agentConfig.identity ?? agent.getIdentity();
    messageComposer = createMessageComposer(llmProvider, identity);
    logger.info('MessageComposer configured');
  }

  // Create COGNITION LLM adapter if LLM available
  let cognitionLLM: CognitionLLM | null = null;
  if (llmProvider) {
    cognitionLLM = createLLMAdapter(llmProvider, logger, { role: 'fast' });
    logger.info('CognitionLLM adapter configured');
  }

  // Create memory provider
  const memoryProvider = createJsonMemoryProvider(logger, {
    storagePath: './data/memory.json',
  });
  logger.info('MemoryProvider configured');

  // Create 4-layer processors
  const layers = createLayers(logger);

  // Create learning engine
  const learningEngine = createLearningEngine(
    logger,
    config.agent?.socialDebtRate !== undefined
      ? { contactTimingRate: config.agent.socialDebtRate }
      : undefined
  );

  // Create core loop config
  const coreLoopConfig: Partial<CoreLoopConfig> = {
    ...config.coreLoop,
  };
  if (primaryUserChatId) {
    coreLoopConfig.primaryUserChatId = primaryUserChatId;
  }

  // Create core loop
  const coreLoop = createCoreLoop(agent, eventBus, layers, logger, metrics, coreLoopConfig, {
    messageComposer: messageComposer ?? undefined,
    userModel: userModel ?? undefined,
    agent,
    cognitionLLM: cognitionLLM ?? undefined,
    memoryProvider,
  });

  // Create channels registry
  const channels = new Map<string, Channel>();

  // Create Telegram channel if configured
  let telegramChannel: TelegramChannel | null = null;
  const telegramConfig = config.telegram ?? {
    botToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
  };

  if (telegramConfig.botToken) {
    // Create telegram channel - it will push signals to coreLoop
    telegramChannel = createTelegramChannel(telegramConfig, null, logger);
    channels.set('telegram', telegramChannel);
    coreLoop.registerChannel(telegramChannel);

    // When telegram receives messages, push as signals
    telegramChannel.setSignalCallback((signal) => {
      coreLoop.pushSignal(signal);
    });

    // Wake up core loop immediately when messages arrive
    telegramChannel.setWakeUpCallback(() => {
      coreLoop.wakeUp();
    });
    logger.info('Telegram channel configured');
  }

  // Shutdown function
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    coreLoop.stop();

    for (const channel of channels.values()) {
      if (channel.stop) {
        await channel.stop();
      }
    }
  };

  return {
    logger,
    eventBus,
    metrics,
    agent,
    layers,
    coreLoop,
    telegramChannel,
    channels,
    userModel,
    llmProvider,
    messageComposer,
    cognitionLLM,
    memoryProvider,
    primaryUserChatId,
    storage: null,
    stateManager: null,
    conversationManager: null,
    learningEngine,
    config: null,
    shutdown,
  };
}

/**
 * Create the application container with async initialization.
 *
 * This version:
 * - Loads configuration from file and environment
 * - Initializes storage and state management
 * - Restores state from disk if available
 * - Sets up auto-save and shutdown hooks
 */
export async function createContainerAsync(configOverrides: AppConfig = {}): Promise<Container> {
  // Load configuration from file and environment
  const mergedConfig = await loadConfig(configOverrides.logDir ? undefined : 'data/config');

  // Build logger config from merged config
  const loggerConfig: Partial<LoggerConfig> = {
    logDir: configOverrides.logDir ?? mergedConfig.logging.logDir,
    maxFiles: configOverrides.maxLogFiles ?? mergedConfig.logging.maxFiles,
    level: configOverrides.logLevel ?? mergedConfig.logging.level,
    pretty: configOverrides.prettyLogs ?? mergedConfig.logging.pretty,
  };

  // Create logger
  const logger = createLogger(loggerConfig);
  logger.info('Loaded configuration');

  // Create storage
  const storagePath = mergedConfig.paths.state;
  const storage = createJSONStorage(storagePath);
  logger.info({ storagePath }, 'Storage initialized');

  // Create state manager
  const stateManager = createStateManager(storage, logger);

  // Create conversation manager for history
  const conversationManager = createConversationManager(storage, logger);
  logger.info('ConversationManager configured');

  // Load persisted state
  const persistedState = await stateManager.load();

  // Create metrics
  const metrics = createMetrics();

  // Build agent config from merged config and persisted state
  const agentConfig: AgentConfig = {
    identity: configOverrides.agent?.identity ?? mergedConfig.identity,
    initialState: persistedState?.agent.state ?? {
      ...mergedConfig.initialState,
      ...configOverrides.agent?.initialState,
    },
    tickRate: configOverrides.agent?.tickRate ?? mergedConfig.tickRate,
  };
  if (persistedState?.agent.sleepState) {
    agentConfig.initialSleepState = persistedState.agent.sleepState;
  }
  if (configOverrides.agent?.socialDebtRate !== undefined) {
    agentConfig.socialDebtRate = configOverrides.agent.socialDebtRate;
  }

  // Create agent
  const agent = createAgent({ logger, metrics }, agentConfig);

  // Create event bus
  const eventBus = createEventBus(logger);

  // Get primary user chat ID
  const primaryUserChatId =
    configOverrides.primaryUser?.telegramChatId ?? mergedConfig.primaryUser.telegramChatId ?? null;

  // Create UserModel if primary user configured
  let userModel: UserModel | null = null;
  if (primaryUserChatId) {
    // Check if user has beliefs (may be missing from old persisted states)
    const hasBeliefs = persistedState?.user && 'beliefs' in persistedState.user;
    if (persistedState?.user?.id === primaryUserChatId && hasBeliefs) {
      // Restore from persisted state - convert date strings
      const restoredUser = {
        ...persistedState.user,
        lastMentioned:
          typeof persistedState.user.lastMentioned === 'string'
            ? new Date(persistedState.user.lastMentioned)
            : persistedState.user.lastMentioned,
        beliefs: {
          energy: {
            ...persistedState.user.beliefs.energy,
            updatedAt:
              typeof persistedState.user.beliefs.energy.updatedAt === 'string'
                ? new Date(persistedState.user.beliefs.energy.updatedAt)
                : persistedState.user.beliefs.energy.updatedAt,
          },
          mood: {
            ...persistedState.user.beliefs.mood,
            updatedAt:
              typeof persistedState.user.beliefs.mood.updatedAt === 'string'
                ? new Date(persistedState.user.beliefs.mood.updatedAt)
                : persistedState.user.beliefs.mood.updatedAt,
          },
          availability: {
            ...persistedState.user.beliefs.availability,
            updatedAt:
              typeof persistedState.user.beliefs.availability.updatedAt === 'string'
                ? new Date(persistedState.user.beliefs.availability.updatedAt)
                : persistedState.user.beliefs.availability.updatedAt,
          },
        },
      };
      userModel = createUserModel(restoredUser, logger);
      logger.info(
        {
          userId: primaryUserChatId,
          userName: restoredUser.name,
          language: restoredUser.preferences.language,
        },
        'UserModel restored from persisted state'
      );
    } else {
      const userName = configOverrides.primaryUser?.name ?? mergedConfig.primaryUser.name;
      const timezoneOffset =
        configOverrides.primaryUser?.timezoneOffset ?? mergedConfig.primaryUser.timezoneOffset;
      userModel = createNewUserWithModel(primaryUserChatId, userName, logger, timezoneOffset);
      logger.info({ userId: primaryUserChatId, userName }, 'UserModel created for primary user');
    }
  }

  // Create LLM providers
  const llmConfig = {
    openRouterApiKey:
      configOverrides.llm?.openRouterApiKey ?? mergedConfig.llm.openRouterApiKey ?? undefined,
    fastModel: configOverrides.llm?.fastModel ?? mergedConfig.llm.fastModel,
    smartModel: configOverrides.llm?.smartModel ?? mergedConfig.llm.smartModel,
    local: configOverrides.llm?.local ?? mergedConfig.llm.local,
  };
  const llmProvider = createLLMProvider(llmConfig, logger);

  // Create MessageComposer if LLM available
  let messageComposer: MessageComposer | null = null;
  if (llmProvider) {
    const identity = agentConfig.identity ?? agent.getIdentity();
    messageComposer = createMessageComposer(llmProvider, identity);
    logger.info('MessageComposer configured');
  }

  // Create COGNITION LLM adapter if LLM available
  let cognitionLLM: CognitionLLM | null = null;
  if (llmProvider) {
    cognitionLLM = createLLMAdapter(llmProvider, logger, { role: 'fast' });
    logger.info('CognitionLLM adapter configured');
  }

  // Create memory provider
  const memoryProvider = createJsonMemoryProvider(logger, {
    storagePath: mergedConfig.paths.state.replace('state', 'memory') || './data/memory.json',
  });
  logger.info('MemoryProvider configured');

  // Create 4-layer processors
  const layers = createLayers(logger);

  // Create learning engine
  const learningEngine = createLearningEngine(logger, mergedConfig.learning);

  // Create core loop config
  const coreLoopConfig: Partial<CoreLoopConfig> = {
    ...configOverrides.coreLoop,
  };
  if (primaryUserChatId) {
    coreLoopConfig.primaryUserChatId = primaryUserChatId;
  }

  // Create core loop
  const coreLoop = createCoreLoop(agent, eventBus, layers, logger, metrics, coreLoopConfig, {
    messageComposer: messageComposer ?? undefined,
    conversationManager,
    userModel: userModel ?? undefined,
    agent,
    cognitionLLM: cognitionLLM ?? undefined,
    memoryProvider,
  });

  // Create channels registry
  const channels = new Map<string, Channel>();

  // Create Telegram channel if configured
  let telegramChannel: TelegramChannel | null = null;
  const telegramBotToken =
    configOverrides.telegram?.botToken ?? mergedConfig.telegramBotToken ?? '';

  if (telegramBotToken) {
    const telegramConfig: TelegramConfig = {
      botToken: telegramBotToken,
      ...configOverrides.telegram,
    };
    telegramChannel = createTelegramChannel(telegramConfig, null, logger);
    channels.set('telegram', telegramChannel);
    coreLoop.registerChannel(telegramChannel);

    // When telegram receives messages, push as signals
    telegramChannel.setSignalCallback((signal) => {
      coreLoop.pushSignal(signal);
    });

    // Wake up core loop immediately when messages arrive
    telegramChannel.setWakeUpCallback(() => {
      coreLoop.wakeUp();
    });
    logger.info('Telegram channel configured');
  }

  // Register components with state manager
  const stateManagerComponents: Parameters<typeof stateManager.registerComponents>[0] = {
    agent,
  };
  if (userModel) {
    stateManagerComponents.userModel = userModel;
  }
  stateManager.registerComponents(stateManagerComponents);

  // Start auto-save
  stateManager.startAutoSave();

  // Shutdown function with persistence
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    coreLoop.stop();

    // Save state
    await stateManager.shutdown();

    // Stop all channels
    for (const channel of channels.values()) {
      if (channel.stop) {
        await channel.stop();
      }
    }

    logger.info('Shutdown complete');
  };

  return {
    logger,
    eventBus,
    metrics,
    agent,
    layers,
    coreLoop,
    telegramChannel,
    channels,
    userModel,
    llmProvider,
    messageComposer,
    cognitionLLM,
    memoryProvider,
    primaryUserChatId,
    storage,
    stateManager,
    conversationManager,
    learningEngine,
    config: mergedConfig,
    shutdown,
  };
}
