import type { Logger } from 'pino';
import type { Metrics, AgentIdentity, AgentState, Channel } from '../types/index.js';
import type { PluginEventData } from '../types/signal.js';
import type { EvidenceSource } from '../types/cognition.js';
import {
  createLogger,
  createConversationLogger,
  setConversationLogger,
  type LoggerConfig,
} from './logger.js';
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
} from '../layers/index.js';
import {
  type TelegramChannel,
  createTelegramChannel,
  type TelegramConfig,
} from '../channels/index.js';
import { type UserModel, createUserModel, createNewUserWithModel } from '../models/user-model.js';
import { type MessageComposer, createMessageComposer } from '../llm/composer.js';
import type { LLMProvider } from '../llm/provider.js';
import { createVercelAIProvider } from '../plugins/providers/vercel-ai-provider.js';
import { createMultiProvider } from '../llm/multi-provider.js';
import {
  type Storage,
  type StateManager,
  type ConversationManager,
  createJSONStorage,
  createDeferredStorage,
  createStateManager,
  createConversationManager,
} from '../storage/index.js';
import { type MergedConfig, loadConfig } from '../config/index.js';
import { getEffectiveTimezone } from '../utils/date.js';
import { type JsonMemoryProvider, createJsonMemoryProvider } from '../storage/memory-provider.js';
import { type CognitionLLM } from '../layers/cognition/agentic-loop.js';
import { createLLMAdapter } from '../layers/cognition/llm-adapter.js';
import {
  type MemoryConsolidator,
  createMemoryConsolidator,
} from '../storage/memory-consolidator.js';
import { type SoulProvider, createSoulProvider } from '../storage/soul-provider.js';
import { type SchedulerService, createSchedulerService } from './scheduler-service.js';
import { type PluginLoader, createPluginLoader } from './plugin-loader.js';
import { loadAllPlugins } from './plugin-discovery.js';
import {
  createPersistentRecipientRegistry,
  type IRecipientRegistry,
} from './recipient-registry.js';
import { PersistentAckRegistry } from '../layers/aggregation/persistent-ack-registry.js';
import { createMotorCortex, type MotorCortex } from '../runtime/motor-cortex/motor-cortex.js';
import { createEnvCredentialStore } from '../runtime/vault/credential-store.js';
import { createContainerManager } from '../runtime/container/container-manager.js';
import { resolve } from 'node:path';
import { createActTool } from '../layers/cognition/tools/core/act.js';
import { createTaskTool } from '../layers/cognition/tools/core/task.js';
import { createCredentialTool } from '../layers/cognition/tools/core/credential.js';
import { createApproveSkillTool } from '../layers/cognition/tools/core/approve-skill.js';
import { fetchPage } from '../plugins/web-fetch/fetcher.js';
import { createProviderInstances } from '../plugins/web-search/providers/registry.js';
import type { MotorFetchFn, MotorSearchFn } from '../runtime/motor-cortex/motor-tools.js';

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
    /** User's timezone offset from UTC in hours (e.g., -5 for EST), null = unknown */
    timezoneOffset?: number | null;
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
  /** Memory consolidator (for sleep-cycle consolidation) */
  memoryConsolidator: MemoryConsolidator | null;
  /** Soul provider (for identity awareness) */
  soulProvider: SoulProvider | null;
  /** Primary user's Telegram chat ID (for proactive messages) */
  primaryUserChatId: string | null;
  /** Storage backend */
  storage: Storage | null;
  /** State manager for persistence */
  stateManager: StateManager | null;
  /** Conversation manager for history */
  conversationManager: ConversationManager | null;
  /** Loaded configuration */
  config: MergedConfig | null;
  /** Scheduler service for plugin timers */
  schedulerService: SchedulerService | null;
  /** Plugin loader */
  pluginLoader: PluginLoader | null;
  /** Recipient registry for message routing */
  recipientRegistry: IRecipientRegistry | null;
  /** Motor Cortex service for code execution */
  motorCortex: MotorCortex | null;
  /** Shutdown function */
  shutdown: () => Promise<void>;
}

/**
 * Create the 3-layer processors.
 * Note: SMART layer merged into COGNITION - smart retry is internal.
 *
 * AUTONOMIC layer is created without neurons - they are registered
 * dynamically via PluginLoader callbacks after this function returns.
 * Call layers.autonomic.validateRequiredNeurons() after loading plugins.
 *
 * @param logger Logger instance
 */
function createLayers(logger: Logger): CoreLoopLayers {
  return {
    autonomic: createAutonomicProcessor(logger),
    aggregation: createAggregationProcessor(logger),
    cognition: createCognitionProcessor(logger),
  };
}

/**
 * LLM provider config type that allows undefined values.
 */
interface LLMProviderConfig {
  openRouterApiKey?: string | null | undefined;
  fastModel?: string | undefined;
  smartModel?: string | undefined;
  motorModel?: string | undefined;
  appName?: string | undefined;
  siteUrl?: string | null | undefined;
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

  const fastModel = config?.fastModel ?? process.env['LLM_FAST_MODEL'];
  const smartModel = config?.smartModel ?? process.env['LLM_SMART_MODEL'];
  const motorModel = config?.motorModel ?? process.env['LLM_MOTOR_MODEL'];
  const appName = config?.appName ?? process.env['LLM_APP_NAME'];
  const siteUrl = config?.siteUrl ?? process.env['LLM_SITE_URL'];

  // Create OpenRouter provider if configured
  let openRouterProvider = null;
  if (openRouterApiKey) {
    openRouterProvider = createVercelAIProvider(
      {
        apiKey: openRouterApiKey,
        ...(fastModel && { fastModel }),
        ...(smartModel && { smartModel }),
        ...(motorModel && { motorModel }),
        ...(appName && { appName }),
        ...(siteUrl && { siteUrl }),
      },
      logger
    );
  }

  // Create local provider if configured
  let localProvider = null;
  if (localBaseUrl && localModel) {
    localProvider = createVercelAIProvider(
      {
        baseUrl: localBaseUrl,
        model: localModel,
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
        motor: useLocalForFast ? localProvider : openRouterProvider, // Use fast provider for motor
        default: openRouterProvider,
      },
      logger
    );
    logger.info(
      {
        fastProvider: useLocalForFast ? 'local' : 'openrouter',
        smartProvider: useLocalForSmart ? 'local' : 'openrouter',
        motorProvider: useLocalForFast ? 'local' : 'openrouter',
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

  // Create conversation logger for LLM interactions (separate file)
  const conversationLogger = createConversationLogger(
    configOverrides.logDir ?? mergedConfig.logging.logDir,
    configOverrides.logLevel ?? mergedConfig.logging.level
  );
  setConversationLogger(conversationLogger);
  logger.info('Conversation logger initialized');

  // Create storage with deferred writes (batches disk I/O, prevents race conditions)
  const storagePath = mergedConfig.paths.state;
  const jsonStorage = createJSONStorage(storagePath, { logger });
  const storage = createDeferredStorage(jsonStorage, logger, {
    flushIntervalMs: 30_000, // Flush every 30 seconds
  });
  storage.startAutoFlush();
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
    motorModel: mergedConfig.llm.motorModel,
    appName: mergedConfig.llm.appName,
    siteUrl: mergedConfig.llm.siteUrl,
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

  // Create memory provider (uses unified storage)
  const memoryProvider = createJsonMemoryProvider(logger, {
    storage,
    storageKey: 'memory',
    maxEntries: 10000,
  });
  logger.info('MemoryProvider configured');

  // Create memory consolidator (for sleep-cycle consolidation)
  const memoryConsolidator = createMemoryConsolidator(logger);
  logger.info('MemoryConsolidator configured');

  // Create soul provider (for identity awareness in system prompt)
  const soulProvider = createSoulProvider(logger, {
    storage,
    storageKey: 'soul',
  });
  logger.info('SoulProvider configured');

  // Create Motor Cortex service (for code execution)
  let motorCortex: MotorCortex | null = null;
  const artifactsBaseDir = resolve(storagePath, '..', 'motor-runs'); // data/motor-runs/
  const credentialStore = createEnvCredentialStore();
  const skillsDir = resolve(storagePath, '..', 'skills'); // data/skills/ relative to data/state/
  if (llmProvider) {
    const containerMgr = createContainerManager(logger);

    // Wire fetch adapter: wraps fetchPage() → MotorFetchFn shape
    // For API-style requests (custom method/headers/body), use direct fetch()
    // instead of fetchPage() which is a web scraper (HTML→markdown, robots.txt, etc.)
    const motorFetchFn: MotorFetchFn = async (url, opts) => {
      const isApiRequest =
        opts != null &&
        (Boolean(opts.method && opts.method !== 'GET') ||
          opts.headers != null ||
          opts.body != null);

      if (isApiRequest) {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        try {
          const response = await fetch(url, {
            method: opts.method ?? 'GET',
            ...(opts.headers && { headers: opts.headers }),
            ...(opts.body && { body: opts.body }),
            signal: controller.signal,
          });
          const contentType = response.headers.get('content-type') ?? '';
          const text = await response.text();
          if (!response.ok) {
            return {
              ok: false,
              status: response.status,
              content: `HTTP ${String(response.status)}: ${text}`,
              contentType,
            };
          }
          return { ok: true, status: response.status, content: text, contentType };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, status: 0, content: message, contentType: '' };
        } finally {
          clearTimeout(timer);
        }
      }

      // Web page fetch: HTML→markdown conversion, redirect following, robots.txt
      const response = await fetchPage({ url, timeoutMs: opts?.timeoutMs }, logger);
      if (response.ok) {
        return {
          ok: true,
          status: response.data.status,
          content: response.data.markdown,
          contentType: response.data.contentType,
        };
      }
      return {
        ok: false,
        status: 0,
        content: response.error.message,
        contentType: '',
      };
    };

    // Wire search adapter: uses first available search provider
    const searchProviders = createProviderInstances(logger);
    const defaultProvider = searchProviders.values().next().value;

    const motorSearchFn: MotorSearchFn | undefined = defaultProvider
      ? async (query, limit) => {
          const result = await defaultProvider.search({ query, limit: limit ?? 5 });
          if (!result.ok) throw new Error(result.error.message);
          return result.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
        }
      : undefined;

    motorCortex = createMotorCortex({
      llm: llmProvider,
      storage,
      logger,
      energyModel: agent.getEnergyModel(),
      credentialStore,
      skillsDir,
      artifactsBaseDir,
      containerManager: containerMgr,
      fetchFn: motorFetchFn,
      ...(motorSearchFn && { searchFn: motorSearchFn }),
    });

    logger.info({ hasFetch: true, hasSearch: !!motorSearchFn }, 'Motor Cortex service initialized');
  }

  // Create recipient registry for message routing (with persistence)
  const recipientRegistry = createPersistentRecipientRegistry(storage, logger);
  await recipientRegistry.init();
  logger.info({ count: recipientRegistry.size() }, 'RecipientRegistry configured');

  // Create persistent ack registry for deferrals (must be loaded before use)
  const ackRegistry = new PersistentAckRegistry(logger, storage);
  await ackRegistry.load();
  logger.info('AckRegistry configured with persistence');

  // === PLUGIN SYSTEM INITIALIZATION ===
  // New architecture: Create layers first, wire callbacks, then load plugins

  // 1. Create scheduler service for plugins
  const schedulerService = createSchedulerService(logger);

  // 2. Create plugin loader with per-plugin config support
  const pluginLoader = createPluginLoader(logger, storage, schedulerService, {
    pluginConfigs: mergedConfig.plugins.configs,
  });

  // 3. Create layers FIRST (AUTONOMIC works without neurons initially)
  const layers = createLayers(logger);

  // 4. Wire neuron callbacks: PluginLoader → AUTONOMIC
  // This must happen BEFORE loading any neuron plugins
  pluginLoader.setNeuronCallbacks(
    (neuron) => {
      layers.autonomic.registerNeuron(neuron);
    },
    (id) => {
      layers.autonomic.unregisterNeuron(id);
    }
  );

  // 4b. Wire filter callbacks: PluginLoader → AUTONOMIC
  // This must happen BEFORE loading any filter plugins
  pluginLoader.setFilterCallbacks(
    (filter, priority) => {
      layers.autonomic.registerFilter(filter, priority);
    },
    (id) => {
      return layers.autonomic.unregisterFilter(id);
    }
  );

  // 4c. Wire user model to AUTONOMIC for filter context
  // Filters can access user interests via context.userModel
  layers.autonomic.setUserModel(userModel);

  // 5. Set services provider for plugins
  // Note: registerEventSchema is added by PluginLoader per-plugin, not here
  pluginLoader.setServicesProvider(() => ({
    getTimezone: (chatId?: string) => {
      if (userModel) {
        const tz = userModel.getTimezone(chatId);
        if (tz) return tz;
        const user = userModel.getUser();
        return getEffectiveTimezone(undefined, user.timezoneOffset);
      }
      return getEffectiveTimezone();
    },
    isTimezoneConfigured: (chatId?: string) => {
      if (userModel) {
        // Only explicit IANA timezones count as "configured" — not offset-derived Etc/GMT
        const user = userModel.getUser();
        if (chatId && user.chatTimezones?.[chatId]) return true;
        if (user.defaultTimezone) return true;
        return false;
      }
      return false;
    },
    getUserPatterns: (_recipientId?: string) => {
      if (!userModel) return null;
      const user = userModel.getUser();
      const patterns = user.patterns;
      return {
        wakeHour: patterns.wakeHour,
        sleepHour: patterns.sleepHour,
      };
    },
    getUserProperty: (attribute: string, _recipientId?: string) => {
      if (!userModel) return null;
      const user = userModel.getUser();
      // Check typed fields from User/Person first
      if (attribute === 'name' && user.name !== null) {
        return {
          value: user.name,
          confidence: 1.0,
          source: 'explicit' as const,
          updatedAt: new Date(),
        };
      }
      // Check preferences for gender and language
      if (attribute === 'gender' && user.preferences.gender !== 'unknown') {
        return {
          value: user.preferences.gender,
          confidence: 1.0,
          source: 'explicit' as const,
          updatedAt: new Date(),
        };
      }
      if (attribute === 'language' && user.preferences.language !== null) {
        return {
          value: user.preferences.language,
          confidence: 1.0,
          source: 'explicit' as const,
          updatedAt: new Date(),
        };
      }
      // Check flexible properties
      const prop = userModel.getProperty(attribute);
      if (!prop) return null;
      // Map EvidenceSource to simpler source type
      const sourceMap: Record<string, 'explicit' | 'inferred' | 'default'> = {
        explicit: 'explicit',
        inferred: 'inferred',
        observation: 'inferred',
        default: 'default',
      };
      return {
        value: prop.value,
        confidence: prop.confidence,
        source: sourceMap[prop.source] ?? 'inferred',
        updatedAt: prop.updatedAt,
      };
    },
    setUserProperty: (attribute: string, value: unknown, _recipientId?: string): Promise<void> => {
      if (!userModel) {
        logger.warn({ attribute }, 'Cannot set user property: no user model');
        return Promise.resolve();
      }
      // Use high confidence for tool-driven writes (user explicitly set value)
      const source: EvidenceSource = 'user_explicit';
      userModel.setProperty(attribute, value, 0.95, source);
      logger.debug({ attribute, value }, 'User property set via plugin');
      return Promise.resolve();
    },
  }));

  // 5b. Wire memory provider for plugin memory searches
  pluginLoader.setMemoryProvider(memoryProvider);

  // 6. Wire scheduler to dispatch events to plugins
  schedulerService.setPluginEventCallback(async (pluginId, eventKind, payload) => {
    await pluginLoader.dispatchPluginEvent(pluginId, eventKind, payload);
  });

  // 7. Discover and load plugins (triggers dynamic neuron registration via callbacks)
  const pluginConfig = mergedConfig.plugins;
  const discoveredPlugins = await loadAllPlugins(pluginConfig, logger);

  for (const { plugin } of discoveredPlugins) {
    try {
      await pluginLoader.loadWithRetry({ default: plugin });
      logger.info({ pluginId: plugin.manifest.id }, 'Plugin activated');
    } catch (error) {
      logger.error(
        {
          pluginId: plugin.manifest.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to activate plugin'
      );
    }
  }

  // 8. Validate required neurons are registered (throws if alertness missing)
  layers.autonomic.validateRequiredNeurons();

  logger.info({ loadedPlugins: discoveredPlugins.length }, 'Plugin system configured');

  // Wire plugin event validator, memory provider, and ack registry to aggregation layer
  // Memory provider is needed for fact storage (fact_batch signals → memory)
  // Ack registry is needed for deferral persistence
  layers.aggregation.updateDeps({
    pluginEventValidator: (data: PluginEventData) => pluginLoader.validatePluginEvent(data),
    memoryProvider,
    ackRegistry,
  });

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
    memoryConsolidator,
    recipientRegistry,
    soulProvider,
  });

  // Wire signal callbacks now that coreLoop exists
  schedulerService.setSignalCallback((signal) => {
    coreLoop.pushSignal(signal);
  });
  pluginLoader.setSignalCallback((signal) => {
    coreLoop.pushSignal(signal);
  });
  if (motorCortex) {
    motorCortex.setSignalCallback((signal) => {
      coreLoop.pushSignal(signal);
    });
  }

  // Set tool registration callbacks now that layers exist
  pluginLoader.setToolCallbacks(
    (tool) => {
      layers.cognition.getToolRegistry().registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        validate: tool.validate,
        execute: tool.execute,
        tags: tool.tags ?? [],
        ...(tool.rawParameterSchema && { rawParameterSchema: tool.rawParameterSchema }),
      });
    },
    (toolName) => {
      return layers.cognition.getToolRegistry().unregisterTool(toolName);
    }
  );

  // Register Motor Cortex tools if service is available
  if (motorCortex) {
    layers.cognition.getToolRegistry().registerTool(createActTool(motorCortex));
    layers.cognition.getToolRegistry().registerTool(createTaskTool(motorCortex, artifactsBaseDir));
    layers.cognition.getToolRegistry().registerTool(createCredentialTool({ credentialStore }));
    layers.cognition.getToolRegistry().registerTool(createApproveSkillTool({ skillsDir }));
    logger.info('Motor Cortex tools registered');
  }

  // Recover Motor Cortex runs on restart (must happen after coreLoop exists for signal routing)
  if (motorCortex) {
    await motorCortex.recoverOnRestart();
    logger.info('Motor Cortex runs recovered');
  }

  // Set scheduler service on core loop
  coreLoop.setSchedulerService(schedulerService);

  // Create channels registry
  const channels = new Map<string, Channel>();

  // Create Telegram channel if configured
  let telegramChannel: TelegramChannel | null = null;
  const telegramBotToken =
    configOverrides.telegram?.botToken ?? mergedConfig.telegramBotToken ?? '';

  if (telegramBotToken) {
    // Build base config with allowed chat IDs filter if primary user is configured
    const telegramConfig: TelegramConfig = primaryUserChatId
      ? {
          botToken: telegramBotToken,
          allowedChatIds: [primaryUserChatId],
          ...configOverrides.telegram,
        }
      : { botToken: telegramBotToken, ...configOverrides.telegram };
    telegramChannel = createTelegramChannel(telegramConfig, logger, recipientRegistry);
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

    // Flush recipient registry
    await recipientRegistry.flush();

    // Flush ack registry
    await ackRegistry.flush();

    // Flush deferred storage (ensures all pending writes are persisted)
    await storage.shutdown();

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
    memoryConsolidator,
    soulProvider,
    primaryUserChatId,
    storage,
    stateManager,
    conversationManager,
    config: mergedConfig,
    schedulerService,
    pluginLoader,
    recipientRegistry,
    motorCortex,
    shutdown,
  };
}
