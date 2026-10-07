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
  migrateToHierarchical,
} from '../storage/index.js';
import { type MergedConfig, loadConfig } from '../config/index.js';
import { getEffectiveTimezone } from '../utils/date.js';
import { JsonMemoryProvider } from '../storage/memory-provider.js';
import { type CognitionLLM } from '../layers/cognition/agentic-loop.js';
import { createLLMAdapter } from '../layers/cognition/llm-adapter.js';
import {
  type MemoryConsolidator,
  createMemoryConsolidator,
} from '../storage/memory-consolidator.js';
import { LLMEntityExtractor } from '../storage/entity-extractor.js';
import { createEmbedder } from '../storage/embedder.js';
import { LanceVectorStore } from '../storage/lance-vector-store.js';
import { JsonGraphStore } from '../storage/graph-store.js';
import { type SoulProvider, createSoulProvider } from '../storage/soul-provider.js';
import { type SchedulerService, createSchedulerService } from './scheduler-service.js';
import { type PluginLoader, createPluginLoader } from './plugin-loader.js';
import { createInboundLog, type InboundLog } from './inbound-log.js';
import { createScopedScriptRunner } from './scoped-script-runner.js';
import { createBrowserAuthPrimitive } from './browser-auth-primitive.js';
import { loadAllPlugins } from './plugin-discovery.js';
import {
  createPersistentRecipientRegistry,
  type IRecipientRegistry,
} from './recipient-registry.js';
import { PersistentAckRegistry } from '../layers/aggregation/persistent-ack-registry.js';
import { createMotorCortex, type MotorCortex } from '../runtime/motor-cortex/motor-cortex.js';
import { createLockService } from '../runtime/lock/lock-service.js';
import { createEnvCredentialStore } from '../runtime/vault/credential-store.js';
import { createContainerManager } from '../runtime/container/container-manager.js';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createActTool } from '../layers/cognition/tools/core/act.js';
import { createTaskTool } from '../layers/cognition/tools/core/task.js';
import { createCredentialTool } from '../layers/cognition/tools/core/credential.js';
import { createSkillTool } from '../layers/cognition/tools/core/skill.js';
import { fetchPage } from '../plugins/web-fetch/fetcher.js';
import type { MotorFetchFn, MotorSearchFn } from '../runtime/motor-cortex/motor-tools.js';
import {
  createProviderInstances,
  getDefaultProviderId,
} from '../plugins/web-search/providers/registry.js';

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
  /**
   * Write log FILES at all (default true: the main log and the conversation
   * log). Off: console output only, and no log directory is created. A test
   * that starts the real container turns it off: a pino target writes from a
   * WORKER THREAD, which cannot be fenced or awaited, so it kept appending
   * while the test removed its data directory (ENOTEMPTY, review round 7).
   */
  logToFile?: boolean;
  /** Agent configuration */
  agent?: {
    /** Agent identity (name, personality, etc.) */
    identity?: AgentIdentity;
    /** Initial agent state */
    initialState?: Partial<AgentState>;
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
  /** Durable inbound log (entries leave it on the turn's recorded outcome; lifemodel-ctc.2.1) */
  inboundLog: InboundLog | null;
  /**
   * The step the stop reached ('done' while the agent runs). `src/index.ts`
   * reads it at the stop deadline for the hard exit's error line
   * (src/core/hard-exit.ts) - together with coreLoop.stopReport().
   */
  stopProgress: () => StopStep;
  /** Shutdown function */
  shutdown: () => Promise<void>;
}

/**
 * Dependencies the shutdown sequence needs.
 *
 * Narrowly typed so unit tests can double each collaborator; the container
 * itself passes the real ones.
 */
export interface ShutdownSequenceDeps {
  /** Application logger */
  logger: Logger;
  /**
   * Absolute wall-clock stop deadline (Date.now() ms). ONE deadline covers
   * the WHOLE stop: intake stop, the loop drain (tick, scheduler callback,
   * turn, sends), state, the full channel stop and the final flush. Each wait
   * inside is bounded by it and the stop then goes on; what still hangs at it
   * is abandoned - `src/index.ts` arms a hard exit at the same deadline
   * (src/core/hard-exit.ts). The container derives it from
   * coreLoop.getStopDrainTimeoutMs().
   */
  deadline: number;
  /** Registered channels: stopping them stops intake */
  channels: Iterable<Channel>;
  /** The core loop: stop() drains the turn in flight */
  coreLoop: Pick<CoreLoop, 'stop' | 'stopReport' | 'closeDurableWrites'>;
  /** Storage (DeferredStorage): the final flush */
  storage: Storage & { shutdown: () => Promise<void> };
  /** State manager (auto-save stop + final state save) */
  stateManager: { shutdown: () => Promise<void> };
  /** Recipient registry (flushes its pending writes) */
  recipientRegistry: { flush: () => Promise<void> };
  /** Ack registry (flushes its pending writes) */
  ackRegistry: { flush: () => Promise<void> };
  /**
   * The step the stop reached (mutated here, read by the hard exit).
   * Optional: a caller that does not arm a stop deadline does not need it.
   */
  progress?: StopProgress | undefined;
}

/**
 * How far the stop got. The hard exit names the step that was still pending
 * when the deadline hit (`StopPendingReport.step`).
 */
export type StopStep =
  | 'intake_stop'
  | 'loop_drain'
  | 'state_flush'
  | 'channel_stop'
  | 'storage_flush'
  | 'done';

/** Live progress of one stop (see ShutdownSequenceDeps.progress). */
export interface StopProgress {
  step: StopStep;
}

/**
 * The shutdown order for a graceful stop (lifemodel-ctc.1.1, bounded by
 * lifemodel-ctc.1.2):
 *
 * 1. Channel intake stops FIRST (new updates are no longer accepted).
 *    Sending keeps working, so the turn drained in step 2 delivers its answer.
 *    A message already accepted is covered by the durable inbound log; the
 *    channel's own stopIntake gives its in-flight handlers a bounded moment.
 * 2. coreLoop.stop() waits for the COGNITION turn in flight, its tick, the
 *    scheduler callback and the sends it scheduled, each bounded by the ONE
 *    stop deadline. A turn that overruns is abandoned: its inbound log entries
 *    recorded no outcome, so they replay once at the next start.
 * 3. State and registries persist.
 * 4. Channels stop fully (clients released; sending no longer possible).
 * 5. Storage flushes LAST - nothing may write after it (the loop is closed for
 *    durable writes just before the flush, so a send settling late cannot
 *    commit behind it).
 *
 * Nothing is persisted for the next run here: internal signals are not durable
 * (the ticks of the next run regenerate them) and inbound user messages are
 * carried by the durable inbound log. Past the deadline this sequence still
 * continues step by step, but whatever hangs is abandoned: `src/index.ts` arms
 * a hard exit at the same deadline, so the process leaves with a non-zero code
 * and one error line naming the step it never finished.
 *
 * `deps.progress` records the step for that line.
 */
export async function shutdownSequence(deps: ShutdownSequenceDeps): Promise<void> {
  const { logger } = deps;
  const progress = deps.progress;
  logger.info('Shutting down...');

  // 1. Stop channel intake first. Channels that separate intake keep sending;
  //    for those that do not, stop() is the only intake stop and they are
  //    already fully stopped here (never released twice in step 4).
  if (progress) progress.step = 'intake_stop';
  const alreadyStopped = new Set<Channel>();
  for (const channel of deps.channels) {
    if (channel.stopIntake) {
      await channel.stopIntake();
    } else if (channel.stop) {
      await channel.stop();
      alreadyStopped.add(channel);
    }
  }
  logger.info('Channel intake stopped');

  // 2. Await the turn in flight and the sends it scheduled. The loop gets the
  //    SAME overall deadline: it bounds the tick, the scheduler callback, the
  //    turn and the sends of the drained turn.
  if (progress) progress.step = 'loop_drain';
  await deps.coreLoop.stop(deps.deadline);

  // 3. Persist domain state and registries
  if (progress) progress.step = 'state_flush';
  await deps.stateManager.shutdown();
  await deps.recipientRegistry.flush();
  await deps.ackRegistry.flush();

  // 4. Channels stop fully (clients released; after this a send refuses).
  if (progress) progress.step = 'channel_stop';
  for (const channel of deps.channels) {
    if (channel.stop && !alreadyStopped.has(channel)) {
      await channel.stop();
    }
  }

  // 5. Storage last: the deferred writes of steps 3-4 reach disk here, and no
  //    component writes after this flush. The loop is closed for durable
  //    writes FIRST: a send that settles behind this flush would commit into a
  //    storage that already shut down (the write would be lost), so it keeps
  //    its message in the log instead - the entry is on disk and replays once
  //    at the next start.
  if (progress) progress.step = 'storage_flush';
  deps.coreLoop.closeDurableWrites();
  await deps.storage.shutdown();

  if (progress) progress.step = 'done';
  logger.info('Shutdown complete');
}

/**
 * Make a shutdown idempotent: the first call runs it; later calls (sequential
 * or concurrent) return the FIRST call's promise (the stopped instance is
 * released once, and the first caller's outcome is what the process acts on).
 * A failed shutdown clears the memo so a later attempt can retry the sequence.
 */
export function makeIdempotentShutdown(run: () => Promise<void>): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    // ??= : the first caller runs the sequence; the catch clears the memo so
    // a FAILED shutdown can be retried by a later call.
    shutdownPromise ??= run().catch((error: unknown) => {
      shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  };
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
function createLayers(logger: Logger, builtinSkillsDir?: string): CoreLoopLayers {
  return {
    autonomic: createAutonomicProcessor(logger),
    aggregation: createAggregationProcessor(logger),
    cognition: createCognitionProcessor(
      logger,
      builtinSkillsDir ? { builtinSkillsDir } : undefined
    ),
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
        useForMotor?: boolean | undefined;
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
  const useLocalForMotor =
    config?.local?.useForMotor ?? process.env['LLM_LOCAL_USE_FOR_MOTOR'] === 'true';

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
        motor: useLocalForMotor ? localProvider : openRouterProvider,
        default: openRouterProvider,
      },
      logger
    );
    logger.info(
      {
        fastProvider: useLocalForFast ? 'local' : 'openrouter',
        smartProvider: useLocalForSmart ? 'local' : 'openrouter',
        motorProvider: useLocalForMotor ? 'local' : 'openrouter',
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
  const logToFile = configOverrides.logToFile ?? true;
  const loggerConfig: Partial<LoggerConfig> = {
    logDir: configOverrides.logDir ?? mergedConfig.logging.logDir,
    maxFiles: configOverrides.maxLogFiles ?? mergedConfig.logging.maxFiles,
    level: configOverrides.logLevel ?? mergedConfig.logging.level,
    pretty: configOverrides.prettyLogs ?? mergedConfig.logging.pretty,
    file: logToFile,
  };

  // Create logger
  const logger = createLogger(loggerConfig);
  logger.info('Loaded configuration');

  // Create conversation logger for LLM interactions (separate file)
  const conversationLogger = createConversationLogger(
    configOverrides.logDir ?? mergedConfig.logging.logDir,
    configOverrides.logLevel ?? mergedConfig.logging.level,
    { file: logToFile }
  );
  setConversationLogger(conversationLogger);
  logger.info('Conversation logger initialized');

  // Create storage with deferred writes (batches disk I/O, prevents race conditions)
  const storagePath = mergedConfig.paths.state;

  // Migrate flat colon-delimited files to hierarchical directory structure
  await migrateToHierarchical(storagePath, '.json', logger);

  const jsonStorage = createJSONStorage(storagePath, { logger });
  const storage = createDeferredStorage(jsonStorage, logger, {
    flushIntervalMs: 30_000, // Flush every 30 seconds
  });
  storage.startAutoFlush();
  logger.info({ storagePath }, 'Storage initialized');

  // Create the durable inbound log (lifemodel-ctc.2.1): inbound user
  // messages are written and flushed HERE at emit time; an entry leaves the
  // log when its turn reached a recorded outcome (owner decision, comment
  // 54), and a start replays the entries whose turn recorded none (see the
  // replay block below, after the core loop exists).
  const inboundLog = createInboundLog({ storage, logger, storagePath });
  await inboundLog.load();

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
  const primaryTimezoneOffset =
    configOverrides.primaryUser?.timezoneOffset ?? mergedConfig.primaryUser.timezoneOffset;
  const agentConfig: AgentConfig = {
    identity: configOverrides.agent?.identity ?? mergedConfig.identity,
    initialState: persistedState?.agent.state ?? {
      ...mergedConfig.initialState,
      ...configOverrides.agent?.initialState,
    },
    sleepSchedule: {
      sleepHour: persistedState?.user?.patterns?.sleepHour ?? 23,
      wakeHour: persistedState?.user?.patterns?.wakeHour ?? 8,
    },
    timezone:
      primaryTimezoneOffset != null
        ? getEffectiveTimezone(undefined, primaryTimezoneOffset)
        : undefined,
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

  // Guard: fail fast if memory.json exists but hasn't been migrated to LanceDB
  const legacyMemoryPath = resolve(storagePath, 'memory.json');
  if (existsSync(legacyMemoryPath)) {
    throw new Error(
      `Unmigrated memory.json found at ${legacyMemoryPath}. ` +
        'Run "npx tsx src/scripts/migrate-memory-to-lance.ts" before starting the agent.'
    );
  }

  // Create dual-layer memory stores
  const embedder = createEmbedder({
    cacheDir: resolve(mergedConfig.paths.data, 'models'),
  });
  const vectorStore = new LanceVectorStore(logger, {
    dbPath: resolve(storagePath, 'memory', 'vector'),
    embedder,
    maxEntries: 10000,
  });
  const graphStore = new JsonGraphStore(logger, {
    storage,
    storageKey: 'graph',
  });
  const memoryProvider = new JsonMemoryProvider(logger, { vectorStore, graphStore });
  logger.info('MemoryProvider configured (dual-layer: VectorStore + GraphStore)');

  // Create entity extractor (LLM-based, for consolidation)
  const entityExtractor = cognitionLLM ? new LLMEntityExtractor(logger, cognitionLLM) : undefined;

  // Create memory consolidator (for sleep-cycle consolidation)
  const memoryConsolidator = createMemoryConsolidator(logger, {}, { entityExtractor, graphStore });
  logger.info('MemoryConsolidator configured');

  // Create soul provider (for identity awareness in system prompt)
  const soulProvider = createSoulProvider(logger, {
    storage,
    storageKey: 'soul',
  });
  logger.info('SoulProvider configured');

  // Create Motor Cortex service (for code execution)
  let motorCortex: MotorCortex | null = null;
  let containerMgr: ReturnType<typeof createContainerManager> | null = null;
  const artifactsBaseDir = resolve(storagePath, '..', 'motor-runs'); // data/motor-runs/
  const credentialStore = createEnvCredentialStore();
  const skillsDir = resolve(storagePath, '..', 'skills'); // data/skills/ relative to data/state/
  if (llmProvider) {
    containerMgr = createContainerManager(logger);

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

      // Web page fetch: HTML→markdown conversion, redirect following
      // Motor runs are one-off research tasks in sandboxed containers with domain-level
      // egress control — bypass robots.txt (meant for persistent crawlers, not agents).
      const response = await fetchPage(
        { url, timeoutMs: opts?.timeoutMs, respectRobots: false },
        logger
      );
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

    // Wire search adapter: wraps web-search plugin providers → MotorSearchFn shape
    let motorSearchFn: MotorSearchFn | undefined;
    const searchProviders = createProviderInstances(logger);
    const defaultSearchId = getDefaultProviderId();
    if (defaultSearchId) {
      const defaultProvider = searchProviders.get(defaultSearchId);
      if (defaultProvider) {
        motorSearchFn = async (query, opts) => {
          const limit = opts?.limit ?? 5;
          const searchResult = await defaultProvider.search({ query, limit });
          if (!searchResult.ok) {
            return { ok: false, results: [] };
          }
          return {
            ok: true,
            results: searchResult.results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.snippet,
            })),
          };
        };
        logger.info({ provider: defaultSearchId }, 'Motor search adapter configured');
      }
    }

    const lockService = createLockService();

    motorCortex = createMotorCortex({
      llm: llmProvider,
      storage,
      logger,
      energyModel: agent.getEnergyModel(),
      skillsDir,
      artifactsBaseDir,
      containerManager: containerMgr,
      lockService,
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

  // Compute builtin skills directory (ESM-safe, relative to this file)
  const containerThisDir = dirname(fileURLToPath(import.meta.url));
  const builtinSkillsDir = resolve(containerThisDir, '..', 'runtime', 'builtin-skills');

  // 3. Create layers FIRST (AUTONOMIC works without neurons initially)
  const layers = createLayers(logger, builtinSkillsDir);

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

  // 4d. Wire script runner factory: PluginLoader → MotorCortex
  // Allows plugins with allowedScripts to run Docker-based scripts
  if (motorCortex) {
    pluginLoader.setScriptRunnerFactory((pluginId) =>
      createScopedScriptRunner(motorCortex, pluginId, {
        getAllowedScripts: (pid) => pluginLoader.getPlugin(pid)?.manifest.allowedScripts ?? [],
      })
    );
  }

  // 4e. Wire browser auth primitive: PluginLoader → ContainerManager
  // Allows plugins to start interactive browser sessions for authentication
  if (containerMgr) {
    pluginLoader.setBrowserAuthPrimitive(createBrowserAuthPrimitive(containerMgr));
  }

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
  schedulerService.setPluginEventCallback(async (pluginId, eventKind, payload, fireContext) => {
    return pluginLoader.dispatchPluginEvent(pluginId, eventKind, payload, fireContext);
  });

  // 7. Discover and load plugins (triggers dynamic neuron registration via callbacks)
  // Load persisted disabled plugins list from storage
  const persistedDisabled =
    ((await storage.load('core:disabled_plugins')) as string[] | null) ?? [];
  const runtimeDisabledIds = new Set(persistedDisabled);

  const pluginConfig = mergedConfig.plugins;
  const {
    enabled: enabledPlugins,
    runtimeDisabled,
    configDisabled,
  } = await loadAllPlugins(pluginConfig, logger, runtimeDisabledIds);

  // Activate only enabled plugins
  for (const { plugin } of enabledPlugins) {
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

  // Store disabled plugin metadata for runtime management
  // Only runtime-disabled plugins can be re-enabled; config-disabled are view-only
  pluginLoader.setDisabledCatalog(runtimeDisabled, configDisabled);

  // 8. Validate required neurons are registered (throws if alertness missing)
  layers.autonomic.validateRequiredNeurons();

  logger.info(
    {
      enabledPlugins: enabledPlugins.length,
      runtimeDisabled: runtimeDisabled.length,
      configDisabled: configDisabled.length,
    },
    'Plugin system configured'
  );

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
    storage,
    pluginLoader,
    inboundLog,
    pluginManager: {
      listStatuses: () => pluginLoader.getPluginStatuses(),
    },
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
        ...(tool.summarize && { summarize: tool.summarize }),
      });
    },
    (toolName) => {
      return layers.cognition.getToolRegistry().unregisterTool(toolName);
    }
  );

  // Register Motor Cortex tools if service is available
  if (motorCortex) {
    const workspacesDir = resolve(storagePath, '..', 'motor-workspaces');
    layers.cognition.getToolRegistry().registerTool(
      createActTool({
        motorCortex,
        credentialStore,
        skillsDir,
        workspacesDir,
        builtinSkillsDir,
        logger,
      })
    );
    layers.cognition.getToolRegistry().registerTool(createTaskTool(motorCortex, artifactsBaseDir));
    layers.cognition.getToolRegistry().registerTool(createCredentialTool({ credentialStore }));
    layers.cognition
      .getToolRegistry()
      .registerTool(
        createSkillTool({ skillsDir, builtinSkillsDir, motorCortex, workspacesDir, logger })
      );
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

    // When telegram receives messages, write them to the durable inbound log
    // FIRST (flushed at emit time through the awaited callback) and queue the
    // accepted ones; duplicates by update_id are dropped.
    telegramChannel.setSignalCallback((signal) => {
      return coreLoop.pushInboundSignal(signal);
    });

    logger.info('Telegram channel configured');
  }

  // Replay every uncommitted inbound message (its answer was never
  // DELIVERED, so the offset did not advance) as signals, in log order.
  // The entries STAY in the log: a crash before they are processed cannot
  // lose them - the next start replays them again (lifemodel-ctc.2.1).
  const replayEntries = inboundLog.replayable();
  for (const entry of replayEntries) {
    // A first message of a new chat can outlive the registry's debounced
    // save (review round 2, finding 1): replay re-registers the route the
    // entry carries, deterministically, before anything is queued.
    if (entry.routing && recipientRegistry.resolve(entry.recipientId) === null) {
      recipientRegistry.getOrCreate(entry.routing.channel, entry.routing.destination);
    }

    // A durable photo receipt whose download never finished: the channel
    // re-fetches it and emits the full signal (finding 7). Without a
    // completing channel (or on re-fetch failure) the receipt itself is
    // queued as its caption text.
    const photoData = entry.signal.data as
      | { pendingPhoto?: { fileId?: unknown } | undefined }
      | undefined;
    if (typeof photoData?.pendingPhoto?.fileId === 'string' && telegramChannel !== null) {
      const completed = await telegramChannel.completePhotoReceipt(entry.signal);
      if (completed) {
        continue;
      }
    }
    coreLoop.pushSignal(entry.signal);
  }
  if (replayEntries.length > 0) {
    logger.info(
      { count: replayEntries.length },
      'Replayed uncommitted inbound messages from the durable log'
    );
  }

  // Nothing else is restored: internal signals are NOT persisted across a stop
  // (the ticks of this run regenerate them) and every inbound user message is
  // carried by the durable log replayed above (lifemodel-ctc.1.2).
  await storage.flush();

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

  // Shutdown function with persistence: the ordered sequence lives in
  // shutdownSequence above (channels first ... storage last) so the order
  // itself is testable.
  // Idempotent (see makeIdempotentShutdown): the first call wins; a later
  // caller gets the same promise.
  const stopProgress: StopProgress = { step: 'done' };
  const shutdown = makeIdempotentShutdown(() => {
    const budget = coreLoop.getStopDrainTimeoutMs();
    return shutdownSequence({
      logger,
      deadline: Date.now() + budget,
      channels: channels.values(),
      coreLoop,
      storage,
      stateManager,
      recipientRegistry,
      ackRegistry,
      progress: stopProgress,
    });
  });

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
    inboundLog,
    stopProgress: () => stopProgress.step,
    shutdown,
  };
}
