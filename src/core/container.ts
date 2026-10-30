import type { Logger } from 'pino';
import type { ReasoningEffort } from '../config/reasoning-effort.js';
import { pinnedModelBaseUrl } from '../config/model-endpoint.js';
import type { PersistableState } from '../storage/persistable-state.js';
import type { PersistedAckRegistryState } from '../layers/aggregation/ack-registry.js';
import { Redis } from 'iovalkey';
import { Pool } from 'pg';
import type { Metrics, AgentIdentity, AgentState, Channel } from '../types/index.js';
import type { PluginEventData } from '../types/signal.js';
import type { CreatureStateReader } from '../ports/creature-state.js';
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
import { type UserModel, createUserModel, createNewUserWithModel } from '../models/user-model.js';
import { type MessageComposer, createMessageComposer } from '../llm/composer.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ModelCallSpanSink } from '../llm/model-call-span.js';
import { createVercelAIProvider } from '../plugins/providers/vercel-ai-provider.js';
import {
  type Storage,
  type StateManager,
  type ConversationManager,
  PostgresStorage,
  createStateManager,
  createConversationManager,
  createSnapshotStore,
  createCreatureStateStore,
} from '../storage/index.js';
import { type MergedConfig, createConfigLoader, type ModelEndpoint } from '../config/index.js';
import { getEffectiveTimezone } from '../utils/date.js';
import { MemoryProviderImpl } from '../storage/memory-provider.js';
import { PostgresConversationStore } from '../storage/postgres-conversation-store.js';
import { createFencedPostgres } from '../storage/fenced-postgres.js';
import { type CognitionLLM } from '../layers/cognition/agentic-loop.js';
import { createLLMAdapter } from '../layers/cognition/llm-adapter.js';
import { createReloadableLLMProvider } from './reloadable-llm-provider.js';
import {
  type MemoryConsolidator,
  createMemoryConsolidator,
} from '../storage/memory-consolidator.js';
import { LLMEntityExtractor } from '../storage/entity-extractor.js';
import { createEmbedder } from '../storage/embedder.js';
import { PostgresVectorStore, PostgresGraphStore } from '../storage/postgres-memory-store.js';
import {
  type SoulProvider,
  createSoulProvider,
  PostgresSoulStore,
} from '../storage/soul-provider.js';
import { type SchedulerService, createSchedulerService } from './scheduler-service.js';
import { type PluginLoader, createPluginLoader } from './plugin-loader.js';
import {
  INBOUND_STREAM,
  OUTBOUND_STREAM,
  InboundMessageStream,
  applyCommittedOutboundEvents,
  startOutboundDelivery,
} from './message-streams.js';
import { createBusSignalStream, type BusSnapshot } from './bus-stream.js';
import { createStorageControlClient } from './storage-control-client.js';
import { createStorageRetentionReconciler } from './storage-retention.js';
import { createPlatformSettingsReader } from '../config/platform-settings.js';
import { createPostgresTaskRegistry } from '../storage/postgres-task-registry.js';
import type { TaskRecord, TaskService } from '../ports/tasks.js';
import { createKubernetesTaskExecutor } from './kubernetes-task-executor.js';
import { createTaskLaunchReconciler, taskWorkbenchImage } from './task-launch.js';
import { createTaskWorkbenchReadiness, createWorkbenchTaskService } from './task-workbench.js';
import { createTaskChannel } from './task-channel.js';
import { createTaskKubernetesIdentity } from './task-kubernetes-identity.js';
import { createPostgresTraceStore } from '../storage/postgres-trace-store.js';
import { createPostgresTaskMailbox } from '../storage/postgres-task-mailbox.js';
import { createTaskChannelReplay } from './task-channel-replay.js';
import { createTaskFinalizer } from './task-finalize.js';
import { readFile } from 'node:fs/promises';
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
import { fileURLToPath } from 'node:url';
import { createActTool } from '../layers/cognition/tools/core/act.js';
import { createTaskTool } from '../layers/cognition/tools/core/task.js';
import { createStartTaskTool } from '../layers/cognition/tools/core/start-task.js';
import { createSteerTaskTool } from '../layers/cognition/tools/core/steer-task.js';
import { createTaskService } from './task-service.js';
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
  /** Primary user configuration (for proactive contact) */
  primaryUser?: {
    /** User's name */
    name?: string;
    /** User's timezone offset from UTC in hours (e.g., -5 for EST), null = unknown */
    timezoneOffset?: number | null;
  };
  /** LLM configuration */
  llm?: {
    /** The OpenAI-compatible endpoint, with a model per role (no key) */
    endpoint?: {
      /** Base URL of the endpoint (e.g., http://localhost:1234/v1) */
      baseUrl?: string;
      /** The fast role's model */
      fastModel?: string;
      /** The smart role's model */
      smartModel?: string;
      /** The motor role's model */
      motorModel?: string;
      fastReasoningEffort?: ReasoningEffort | null;
      smartReasoningEffort?: ReasoningEffort | null;
      motorReasoningEffort?: ReasoningEffort | null;
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
  memoryProvider: MemoryProviderImpl | null;
  /** Memory consolidator (for sleep-cycle consolidation) */
  memoryConsolidator: MemoryConsolidator | null;
  /** Soul provider (for identity awareness) */
  soulProvider: SoulProvider | null;
  /** Storage backend */
  storage: Storage | null;
  /** State manager for persistence */
  stateManager: StateManager | null;
  /** Conversation manager for history */
  conversationManager: ConversationManager | null;
  /** Loaded configuration */
  config: MergedConfig | null;
  /** Postgres-backed config shared with the settings server. */
  configLoader: ReturnType<typeof createConfigLoader>;
  /** Reload configuration from Postgres and apply endpoint/model changes. */
  reloadConfig: () => Promise<void>;
  /** Scheduler service for plugin timers */
  schedulerService: SchedulerService | null;
  /** Plugin loader */
  pluginLoader: PluginLoader | null;
  /** Recipient registry for message routing */
  recipientRegistry: IRecipientRegistry | null;
  /** Motor Cortex service for code execution */
  motorCortex: MotorCortex | null;
  /** Separate cluster Job path; never installed in PluginPrimitives. */
  taskService: TaskService | null;
  /** Durable inbound log (entries leave it on the turn's recorded outcome; lifemodel-ctc.2.1) */
  inboundStream: InboundMessageStream | null;
  /** Fresh creature state for the web module; no Valkey client crosses this seam. */
  creatureState: CreatureStateReader;
  /**
   * The step the stop reached ('done' while the agent runs). `src/index.ts`
   * reads it at the stop deadline for the hard exit's error line
   * (src/core/hard-exit.ts) - together with coreLoop.stopReport().
   */
  stopProgress: () => StopStep;
  /** Shutdown function; the stop coordinator supplies its absolute deadline. */
  shutdown: (deadline?: number) => Promise<void>;
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
   * (src/core/hard-exit.ts). The coordinator supplies it; a direct container
   * stop derives it from coreLoop.getStopDrainTimeoutMs().
   */
  deadline: number;
  /** Registered channels: stopping them stops intake */
  channels: Iterable<Channel>;
  /** The core loop: stop() drains the turn in flight */
  coreLoop: Pick<CoreLoop, 'stop' | 'stopReport' | 'closeDurableWrites'>;
  /** Storage lifecycle hook; durable writes are synchronous at their store. */

  /** State manager (auto-save stop + final state save) */
  stateManager: { shutdown: () => Promise<void> };
  /** Recipient registry (flushes its pending writes) */
  recipientRegistry: { flush: () => Promise<void> };
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
 * (the ticks of the next run regenerate the pressures and neurons; a schedule
 * firing, a Motor Cortex result and a reaction queued in memory are LOST - see
 * docs/architecture.md) and inbound user messages are carried by the durable
 * inbound log. Past the deadline this sequence still
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

  // 4. Channels stop fully (clients released; after this a send refuses).
  if (progress) progress.step = 'channel_stop';
  for (const channel of deps.channels) {
    if (channel.stop && !alreadyStopped.has(channel)) {
      await channel.stop();
    }
  }

  // 5. Fence durable writes before releasing the store connections. coreLoop.stop()
  //    drains tracked store-writing effects within the shared stop deadline.
  if (progress) progress.step = 'storage_flush';
  deps.coreLoop.closeDurableWrites();

  if (progress) progress.step = 'done';
  logger.info('Shutdown complete');
}

/** Release every store even when a task drain or another cleanup fails. */
export async function closeTaskResources(
  taskDrains: Promise<PromiseSettledResult<unknown>[]>,
  cleanup: (() => Promise<unknown>)[],
  shutdownOutcome?: PromiseSettledResult<void>
): Promise<void> {
  const outcomes = [...(shutdownOutcome ? [shutdownOutcome] : []), ...(await taskDrains)];
  for (const close of cleanup) {
    try {
      outcomes.push({ status: 'fulfilled', value: await close() });
    } catch (reason) {
      outcomes.push({ status: 'rejected', reason });
    }
  }
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((failure): unknown => failure.reason),
      'Task resource shutdown failed'
    );
}

/**
 * Make a shutdown idempotent: the first call runs it; later calls (sequential
 * or concurrent) return the FIRST call's promise (the stopped instance is
 * released once, and the first caller's outcome is what the process acts on).
 * A failed shutdown clears the memo so a later attempt can retry the sequence.
 */
export function makeIdempotentShutdown(
  run: (deadline?: number) => Promise<void>
): (deadline?: number) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return (deadline) => {
    // ??= : the first caller runs the sequence; the catch clears the memo so
    // a FAILED shutdown can be retried by a later call.
    shutdownPromise ??= run(deadline).catch((error: unknown) => {
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
export interface LLMProviderConfig {
  /** The OpenAI-compatible endpoint, with a model per role (lifemodel-q4x.4.1). */
  endpoint?:
    | {
        baseUrl?: string | null | undefined;
        fastModel?: string | null | undefined;
        smartModel?: string | null | undefined;
        motorModel?: string | null | undefined;
        fastReasoningEffort?: ReasoningEffort | null | undefined;
        smartReasoningEffort?: ReasoningEffort | null | undefined;
        motorReasoningEffort?: ReasoningEffort | null | undefined;
      }
    | undefined;
}

/**
 * Create the LLM provider from config (the public entry `src/index.ts` and the
 * container use; unit-tested on its own in
 * tests/unit/llm/model-endpoint.test.ts).
 *
 * The model configuration is ONE OpenAI-compatible endpoint with a model per
 * role, and no key (lifemodel-q4x.4.1). In the cluster that endpoint is the
 * platform's `model-gateway`, pinned by `LIFEMODEL_MODEL_BASE_URL`, and the
 * gateway injects the owner's key from OpenBao on the way upstream: lifemodel
 * holds none. Only with the platform pin does a blank role ask for `default`
 * (ADR-013 D2). Without the pin, a role with no model is refused; there is
 * no second endpoint and no fallback.
 */
export function createLLMProvider(
  config: LLMProviderConfig | undefined,
  logger: Logger,
  traces?: ModelCallSpanSink
): LLMProvider | null {
  const pinned = pinnedModelBaseUrl();
  const endpoint: ModelEndpoint = {
    baseUrl: pinned ?? config?.endpoint?.baseUrl ?? null,
    fastModel: config?.endpoint?.fastModel ?? null,
    smartModel: config?.endpoint?.smartModel ?? null,
    motorModel: config?.endpoint?.motorModel ?? null,
    fastReasoningEffort: config?.endpoint?.fastReasoningEffort ?? null,
    smartReasoningEffort: config?.endpoint?.smartReasoningEffort ?? null,
    motorReasoningEffort: config?.endpoint?.motorReasoningEffort ?? null,
  };

  // Only a platform pin lets the gateway supply blank role models.
  if (endpoint.baseUrl) {
    const provider = createVercelAIProvider(
      {
        baseUrl: endpoint.baseUrl,
        useGatewayDefault: pinned !== null,
        ...(endpoint.fastModel && { fastModel: endpoint.fastModel }),
        ...(endpoint.smartModel && { smartModel: endpoint.smartModel }),
        ...(endpoint.motorModel && { motorModel: endpoint.motorModel }),
        ...(endpoint.fastReasoningEffort && { fastReasoningEffort: endpoint.fastReasoningEffort }),
        ...(endpoint.smartReasoningEffort && {
          smartReasoningEffort: endpoint.smartReasoningEffort,
        }),
        ...(endpoint.motorReasoningEffort && {
          motorReasoningEffort: endpoint.motorReasoningEffort,
        }),
      },
      logger,
      traces
    );
    logger.info({ baseUrl: endpoint.baseUrl }, 'Model endpoint configured');
    return provider;
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
export function createSettingsReloadHandler(
  active: Pick<Container, 'logger' | 'reloadConfig'>
): () => Promise<void> {
  return async () => {
    try {
      await active.reloadConfig();
    } catch (error) {
      active.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Saved settings could not be applied to the running core'
      );
    }
  };
}

export async function createContainerAsync(
  configOverrides: AppConfig = {},
  callbacks: { onFatalStop?: (error: Error) => void } = {}
): Promise<Container> {
  // Load configuration from file and environment. The config file's directory
  // is resolved HERE, before anything else applies: a path is an input, not a
  // value the config itself decides (lifemodel-q4x.4.1).
  const valkeyUrl = process.env['LIFEMODEL_VALKEY_URL'];
  if (!valkeyUrl) throw new Error('LIFEMODEL_VALKEY_URL is required');
  const databaseUrl = process.env['LIFEMODEL_DATABASE_URL'];
  if (!databaseUrl) throw new Error('LIFEMODEL_DATABASE_URL is required');

  const rawPostgres = new Pool({ connectionString: databaseUrl });

  const snapshotRedis = new Redis(valkeyUrl);
  const snapshotStore = createSnapshotStore(snapshotRedis, {
    outboundKey: OUTBOUND_STREAM,
    completedInboundKey: 'inbound:completed',
  });
  const creatureStateStore = createCreatureStateStore(snapshotRedis);
  const busSignalStream = createBusSignalStream(snapshotRedis);
  snapshotStore.register(busSignalStream);
  const snapshotEpoch = await snapshotStore.takeEpoch();
  // Replace stale thinking state immediately after epoch takeover; this is
  // best-effort and must not delay startup if the projection store is down.
  let resolveStartupLogger!: (logger: Logger) => void;
  const startupLoggerReady = new Promise<Logger>((resolve) => {
    resolveStartupLogger = resolve;
  });
  void creatureStateStore.publishCreatureState('awake', snapshotEpoch).catch((error: unknown) => {
    void startupLoggerReady.then((logger) => {
      logger.warn({ err: error }, 'Failed to publish initial creature state');
    });
  });
  await rawPostgres.query(
    `INSERT INTO core.active_holder (id, epoch) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET epoch = EXCLUDED.epoch
     WHERE core.active_holder.epoch < EXCLUDED.epoch`,
    [snapshotEpoch]
  );
  const postgres = createFencedPostgres(rawPostgres, snapshotEpoch);
  const configLoader = createConfigLoader(postgres);
  const mergedConfig = await configLoader.load();

  // Build logger config from merged config
  const logToFile = configOverrides.logToFile ?? process.env['NODE_ENV'] !== 'production';
  const loggerConfig: Partial<LoggerConfig> = {
    logDir: configOverrides.logDir ?? mergedConfig.logging.logDir,
    maxFiles: configOverrides.maxLogFiles ?? mergedConfig.logging.maxFiles,
    level: configOverrides.logLevel ?? mergedConfig.logging.level,
    pretty: configOverrides.prettyLogs ?? mergedConfig.logging.pretty,
    file: logToFile,
  };

  // Create logger
  const logger = createLogger(loggerConfig);
  resolveStartupLogger(logger);
  logger.info({ epoch: snapshotEpoch }, 'Core snapshot epoch acquired');
  logger.info('Loaded configuration');
  if (!mergedConfig.motorCortex.enabled) {
    logger.info({ reason: 'MOTOR_CORTEX_ENABLED=false' }, 'Motor Cortex disabled');
  }

  const initialSnapshot = await snapshotStore.read();
  busSignalStream.hydrateSnapshot(
    initialSnapshot?.sections['busOffset'] as BusSnapshot | undefined
  );

  // Create conversation logger for LLM interactions (separate file)
  const conversationLogger = createConversationLogger(
    configOverrides.logDir ?? mergedConfig.logging.logDir,
    configOverrides.logLevel ?? mergedConfig.logging.level,
    { file: logToFile }
  );
  setConversationLogger(conversationLogger);
  logger.info('Conversation logger initialized');

  // All mutable core state is held by Postgres or the Valkey snapshot.
  const storagePath = mergedConfig.paths.state;
  const storage = new PostgresStorage(postgres);
  logger.info('Postgres storage initialized');

  // Inbound offsets, pending entries and the bounded dedup ring are owned by
  // the Valkey snapshot. Existing stream entries replay from that snapshot.
  const inboundStream = new InboundMessageStream(
    snapshotRedis,
    INBOUND_STREAM,
    undefined,
    (messageId) => {
      logger.warn({ messageId }, 'Inbound retry already has a committed outcome');
    },
    'inbound:completed'
  );
  inboundStream.hydrateSnapshot(
    initialSnapshot?.sections['inbound'] as Parameters<typeof inboundStream.hydrateSnapshot>[0]
  );

  // Create state manager
  const stateManager = createStateManager(storage, logger);
  const snapshotState = initialSnapshot?.sections['agentState'] as PersistableState | undefined;
  stateManager.setSnapshotState(snapshotState ?? null);

  // Conversation history lives in the core Postgres schema, not DATA_PATH.
  const coreStorage = storage;
  const conversationManager = createConversationManager(
    new PostgresConversationStore(postgres),
    logger
  );
  logger.info('ConversationManager configured');
  // Re-apply all committed outbound message rows after restart. The independent
  // cursor advances only after Postgres accepts the natural-keyed row.
  await applyCommittedOutboundEvents(
    snapshotRedis,
    conversationManager,
    undefined,
    undefined,
    logger
  );

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

  // The web owner is the primary user for all primary-recipient consumers.
  const recipientRegistry = createPersistentRecipientRegistry(postgres, logger);
  await recipientRegistry.init();
  const primaryRecipientId = recipientRegistry.getOrCreate('web', 'owner');
  await recipientRegistry.flush();
  logger.info({ count: recipientRegistry.size() }, 'RecipientRegistry configured');

  // Restore or create the UserModel for the web owner.
  let userModel: UserModel | null = null;
  // Check if user has beliefs (may be missing from old persisted states)
  const hasBeliefs = persistedState?.user && 'beliefs' in persistedState.user;
  if (persistedState?.user?.id === primaryRecipientId && hasBeliefs) {
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
        userId: primaryRecipientId,
        userName: restoredUser.name,
        language: restoredUser.preferences.language,
      },
      'UserModel restored from persisted state'
    );
  } else {
    const userName = configOverrides.primaryUser?.name ?? mergedConfig.primaryUser.name;
    const timezoneOffset =
      configOverrides.primaryUser?.timezoneOffset ?? mergedConfig.primaryUser.timezoneOffset;
    userModel = createNewUserWithModel(primaryRecipientId, userName, logger, timezoneOffset);
    logger.info({ userId: primaryRecipientId, userName }, 'UserModel created for primary user');
  }

  // Disposable execution evidence: task-pod facts, the task channel's frames
  // and every model call's span (lifemodel-d4t8). It is created whenever the
  // core has its database - a motor-mode core records model calls too - and it
  // never spends state/owner-intake SQL capacity. Before finalizer.start,
  // because startup cleanup can delete failed Pods even when the task channel
  // has no TLS projection yet.
  const tracePool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'lifemodel-observability',
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    statement_timeout: 2000,
    lock_timeout: 1000,
  });
  tracePool.on('error', () => undefined);
  tracePool.on('connect', (client) => client.on('error', () => undefined));
  const traces = createPostgresTraceStore({
    pool: tracePool,
    knownSecrets: [
      databaseUrl,
      ...(typeof rawPostgres.options.password === 'string' ? [rawPostgres.options.password] : []),
    ],
  });
  let traceAuthority: ReturnType<typeof createPostgresTaskMailbox> | undefined;
  let traceAuthorityPool: Pool | undefined;
  const stopTaskTraces = async (deadline: number, signal: AbortSignal): Promise<void> => {
    traceAuthority?.stop();
    await traces.close(deadline, signal);
    if (traces.droppedCount)
      logger.warn(
        { code: 'trace_records_dropped', count: traces.droppedCount },
        'Trace records dropped'
      );
    // Start disposal even if the cancellation already fired. Checked-out
    // trace sockets are destroyed by close; late connects destroy themselves.
    // Never wait for disposable pool shutdown once authoritative work is done.
    const poolsClosed = Promise.all([traceAuthorityPool?.end(), tracePool.end()]).catch(
      () => undefined
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        poolsClosed,
        new Promise<void>((resolveStop) => {
          onAbort = resolveStop;
          if (signal.aborted) resolveStop();
          else signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(resolveStop, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  // Create LLM providers
  const llmConfig = {
    endpoint: configOverrides.llm?.endpoint ?? mergedConfig.llm.endpoint,
  };
  const reloadableProvider = createReloadableLLMProvider(
    createLLMProvider(llmConfig, logger, traces)
  );
  const llmProvider = reloadableProvider.provider;
  const reloadConfig = async (): Promise<void> => {
    const refreshed = await configLoader.load();
    reloadableProvider.replace(
      createLLMProvider({ endpoint: refreshed.llm.endpoint }, logger, traces)
    );
    logger.info(
      { baseUrl: refreshed.llm.endpoint.baseUrl },
      'Model endpoint configuration reloaded'
    );
  };

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

  // Long-lived memory and its graph live only in the core Postgres schema.
  const embedder = createEmbedder();
  const vectorStore = new PostgresVectorStore(logger, postgres, embedder, 10000);
  const graphStore = new PostgresGraphStore(postgres, logger);
  const memoryProvider = new MemoryProviderImpl(logger, { vectorStore, graphStore });
  logger.info('MemoryProvider configured (Postgres pgvector + graph)');

  // Create entity extractor (LLM-based, for consolidation)
  const entityExtractor = cognitionLLM ? new LLMEntityExtractor(logger, cognitionLLM) : undefined;

  // Create memory consolidator (for sleep-cycle consolidation)
  const memoryConsolidator = createMemoryConsolidator(logger, {}, { entityExtractor, graphStore });
  logger.info('MemoryConsolidator configured');

  // Create soul provider (for identity awareness in system prompt)
  const soulProvider = createSoulProvider(logger, {
    store: new PostgresSoulStore(postgres),
  });
  logger.info('SoulProvider configured');

  // Create Motor Cortex service (for code execution)
  let motorCortex: MotorCortex | null = null;
  let containerMgr: ReturnType<typeof createContainerManager> | null = null;
  const artifactsBaseDir = resolve(storagePath, '..', 'motor-runs'); // data/motor-runs/
  const credentialStore = createEnvCredentialStore();
  const skillsDir = resolve(storagePath, '..', 'skills'); // data/skills/ relative to data/state/
  if (mergedConfig.motorCortex.enabled) {
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
      storage: coreStorage,
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

  // Create persistent ack registry for deferrals (must be loaded before use)
  const ackRegistry = new PersistentAckRegistry(logger);
  await ackRegistry.load(
    initialSnapshot?.sections['ackRegistry'] as PersistedAckRegistryState | undefined
  );
  logger.info('AckRegistry configured with persistence');

  // === PLUGIN SYSTEM INITIALIZATION ===
  // New architecture: Create layers first, wire callbacks, then load plugins

  // 1. Create scheduler service for plugins
  const schedulerService = createSchedulerService(logger);

  // 2. Create plugin loader with per-plugin config support
  const pluginLoader = createPluginLoader(logger, coreStorage, schedulerService, {
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
    ((await coreStorage.load('core:disabled_plugins')) as string[] | null) ?? [];
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
  const stopDeadlineMs = Number(process.env['LIFEMODEL_CORE_STOP_DEADLINE_MS'] ?? 5_000);
  if (!Number.isSafeInteger(stopDeadlineMs) || stopDeadlineMs < 1) {
    throw new Error('LIFEMODEL_CORE_STOP_DEADLINE_MS must be a positive integer');
  }
  coreLoopConfig.shutdownDrainTimeoutMs = stopDeadlineMs;
  let shutdown: ((deadline?: number) => Promise<void>) | null = null;
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
    storage: coreStorage,
    pluginLoader,
    inboundStream,
    busSignalStream,
    initialTickCount: Number(
      initialSnapshot?.sections['tickCounter'] ?? initialSnapshot?.tick ?? 0
    ),
    creatureStateEpoch: snapshotEpoch,
    publishCreatureState: (state, epoch) => creatureStateStore.publishCreatureState(state, epoch),
    commitSnapshot: async (tick, outbox) => {
      await snapshotStore.commitOwners(snapshotEpoch, tick, outbox);
      logger.debug({ epoch: snapshotEpoch, tick }, 'Core snapshot committed');
    },
    afterSnapshotCommit: async () => {
      await applyCommittedOutboundEvents(
        snapshotRedis,
        conversationManager,
        undefined,
        undefined,
        logger
      );
    },
    onStaleSnapshot: callbacks.onFatalStop,
    onFatalError: callbacks.onFatalStop,
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

  // Outbound events are retained for the future gateway; no channel is registered in this core.

  const outboundDelivery = startOutboundDelivery(snapshotRedis, channels, logger);
  void outboundDelivery.done.catch((error: unknown) => {
    logger.error({ err: error }, 'Outbound delivery worker stopped unexpectedly');
  });

  // Storage is an optional standalone integration; the platform always supplies
  // both service-identity inputs. A partial declaration fails rather than using
  // system trust or silently disabling owner warnings.
  const controlTokenFile = process.env['LIFEMODEL_STORAGE_CONTROL_TOKEN_FILE'];
  const controlCaFile = process.env['LIFEMODEL_STORAGE_CONTROL_CA_FILE'];
  if (Boolean(controlTokenFile) !== Boolean(controlCaFile)) {
    throw new Error('Storage control requires both token and instance CA projections');
  }
  if (!mergedConfig.motorCortex.enabled && controlTokenFile && controlCaFile)
    taskWorkbenchImage(process.env['LIFEMODEL_TASK_WORKBENCH_IMAGE']);
  const storageRetention =
    controlTokenFile && controlCaFile
      ? createStorageRetentionReconciler({
          client: createStorageControlClient({
            origin: 'https://storage-module.lifemodel-system.svc:8444',
            tokenFile: controlTokenFile,
            caFile: controlCaFile,
          }),
          snapshotStore,
          epoch: snapshotEpoch,
          conversations: conversationManager,
          conversationStore: new PostgresConversationStore(postgres),
          recipientId: primaryRecipientId,
          route: { channel: 'web', destination: 'owner' },
          language: () => userModel?.getLanguage() ?? null,
          logger,
        })
      : undefined;
  storageRetention?.start();

  // The storage projections identify platform mode. MOTOR_CORTEX_ENABLED=false
  // keeps the legacy Docker loop disabled; this Job path is separate from it.
  let taskService: TaskService | null = null;
  let taskLaunch: ReturnType<typeof createTaskLaunchReconciler> | undefined;
  let stopTaskFinalizer: ((deadline: number) => Promise<void>) | undefined;
  const taskLaunchController = new AbortController();
  let stopTaskChannel: ((deadline: number) => Promise<void>) | undefined;
  let closeTaskCommands: (() => Promise<void>) | undefined;
  let notifyTaskCommands: ((taskId: string) => void) | undefined;
  const channelTlsDir = process.env['LIFEMODEL_TASK_CHANNEL_TLS_DIR'];
  if (!mergedConfig.motorCortex.enabled && controlTokenFile && controlCaFile) {
    const image = taskWorkbenchImage(process.env['LIFEMODEL_TASK_WORKBENCH_IMAGE']);
    const imageRevision = image.slice(image.indexOf('@') + 1);
    const taskContextPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: 'lifemodel-task-context',
      connectionTimeoutMillis: 1500,
      query_timeout: 1500,
      statement_timeout: 1500,
      lock_timeout: 1500,
    });
    taskContextPool.on('error', () => undefined);
    const registry = createPostgresTaskRegistry({
      pool: rawPostgres,
      contextPool: taskContextPool,
      epoch: snapshotEpoch,
      settings: createPlatformSettingsReader({ logger }),
      imageRevision,
    });
    const launchRegistry = createPostgresTaskRegistry({
      pool: rawPostgres,
      epoch: snapshotEpoch,
      settings: createPlatformSettingsReader({ logger }),
      signal: taskLaunchController.signal,
    });
    const acceptanceService = createWorkbenchTaskService({
      service: registry,
      imageRevision,
      ready: createTaskWorkbenchReadiness(),
      onAccepted: () => {
        void taskLaunch?.resync();
      },
    });
    // Cognition commands and question reads never borrow the owner-intake reserve.
    const commandSettings = (await createPlatformSettingsReader({ logger }).read()).values;
    const commandPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: 'lifemodel-task-commands',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
      lock_timeout: 5000,
    });
    commandPool.on('error', () => undefined);
    commandPool.on('connect', (client) => client.on('error', () => undefined));
    const taskMailbox = createPostgresTaskMailbox({
      pool: commandPool,
      epoch: snapshotEpoch,
      onCommandCommitted: (taskId) => notifyTaskCommands?.(taskId),
      commandFrameLimit: Math.min(
        commandSettings['tasks.channel.maxFrameBytes'],
        commandSettings['tasks.channel.maxUnackedBytes'],
        Math.floor(commandSettings['tasks.channel.maxBufferedBytes'] / 4)
      ),
    });
    closeTaskCommands = async () => {
      taskMailbox.stop();
      await Promise.all([commandPool.end(), taskContextPool.end()]);
    };
    taskService = createTaskService({ tasks: acceptanceService, mailbox: taskMailbox });
    coreLoop.setTaskService(taskService);
    layers.cognition.setDependencies({ taskService });
    coreLoop.setTaskQuestionReader((taskId, questionId) =>
      taskMailbox.readQuestion(taskId, questionId)
    );
    layers.cognition
      .getToolRegistry()
      .registerTool(
        createSteerTaskTool(
          taskService,
          Math.min(
            commandSettings['tasks.channel.maxFrameBytes'],
            commandSettings['tasks.channel.maxUnackedBytes'],
            Math.floor(commandSettings['tasks.channel.maxBufferedBytes'] / 4)
          )
        )
      );
    layers.cognition.getToolRegistry().registerTool(
      createStartTaskTool({
        readByLaunchKey: (launchKey) => registry.readByLaunchKey(launchKey),
        applyStartTask: (intent) => coreLoop.applyStartTask(intent),
        imageRevision,
      })
    );
    const finalizerController = new AbortController();
    // Infrastructure finalization must not spend owner-intake SQL capacity.
    const finalizerPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: 'lifemodel-task-finalizer',
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      statement_timeout: 10000,
      lock_timeout: 5000,
    });
    finalizerPool.on('error', () => undefined);
    finalizerPool.on('connect', (client) => client.on('error', () => undefined));
    const finalizerRegistry = createPostgresTaskRegistry({
      pool: finalizerPool,
      epoch: snapshotEpoch,
      settings: createPlatformSettingsReader({ logger }),
      signal: finalizerController.signal,
    });
    const finalizerMailbox = createPostgresTaskMailbox({
      pool: finalizerPool,
      epoch: snapshotEpoch,
    });
    const finalizerExecutor = createKubernetesTaskExecutor({ traces });
    const finalizer = createTaskFinalizer({
      registry: finalizerRegistry,
      mailbox: finalizerMailbox,
      executor: finalizerExecutor,
      storage: createStorageControlClient({
        origin: 'https://storage-module.lifemodel-system.svc:8444',
        tokenFile: controlTokenFile,
        caFile: controlCaFile,
      }),
      bus: busSignalStream,
      logger,
      cancelRegistry: () => {
        finalizerController.abort();
        finalizerMailbox.stop();
      },
      closeExecutor: () => {
        finalizerExecutor.close();
      },
    });
    stopTaskFinalizer = async (deadline) => {
      await finalizer.stop(deadline);
      await finalizerPool.end();
    };
    coreLoop.setTaskReportConsumer((signal) => finalizer.consumeSignal(signal));
    await finalizer.start();
    const executor = createKubernetesTaskExecutor({ traces });
    taskLaunch = createTaskLaunchReconciler({
      onCleanup: () => {
        void finalizer.resync();
      },
      onTerminal: async (id, reason) => {
        await finalizer.finalize(id, reason);
      },
      registry: launchRegistry,
      cancelRegistry: () => {
        taskLaunchController.abort();
      },
      executor,
      storage: createStorageControlClient({
        origin: 'https://storage-module.lifemodel-system.svc:8444',
        tokenFile: controlTokenFile,
        caFile: controlCaFile,
      }),
      logger,
      scanJobs: async (signal) =>
        (await executor.listJobs(signal)).map((job) => ({
          name: job.name,
          uid: job.uid,
          launchLabel: job.launchLabel,
          captureTermination: (task: TaskRecord, abortSignal: AbortSignal) =>
            executor.capturePodTermination(job, task, abortSignal),
          remove: (abortSignal: AbortSignal) => executor.deleteJob(job, abortSignal),
        })),
      closeExecutor: () => {
        executor.close();
      },
      waitForChange: (signal) => executor.waitForChange(signal),
    });
    taskLaunch.start();
  }

  if (!mergedConfig.motorCortex.enabled && channelTlsDir) {
    const settings = (await createPlatformSettingsReader({ logger }).read()).values;
    const timeoutMs = settings['tasks.channel.ackTimeoutMs'];
    const port = Number(process.env['LIFEMODEL_TASK_CHANNEL_PORT'] ?? '8447');
    if (port !== 8447) throw new Error('Task channel configuration refused');
    const readLeaf = async () => {
      const [cert, key] = await Promise.all([
        readFile(resolve(channelTlsDir, 'tls.crt'), { signal: AbortSignal.timeout(timeoutMs) }),
        readFile(resolve(channelTlsDir, 'tls.key'), { signal: AbortSignal.timeout(timeoutMs) }),
      ]);
      return { cert, key };
    };
    const leaf = await readLeaf().catch(() => {
      throw new Error('Task channel TLS unavailable');
    });
    // A physically separate pool: task intake/replay cannot spend owner SQL slots.
    const channelPool = new Pool({
      connectionString: databaseUrl,
      max: settings['tasks.channel.sqlConnections'],
      application_name: 'lifemodel-task-channel',
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
      lock_timeout: timeoutMs,
    });
    channelPool.on('error', () => undefined);
    channelPool.on('connect', (client) => client.on('error', () => undefined));
    traceAuthorityPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: 'lifemodel-trace-authority',
      connectionTimeoutMillis: 1000,
      query_timeout: 1000,
      statement_timeout: 1000,
      lock_timeout: 1000,
    });
    traceAuthorityPool.on('error', () => undefined);
    traceAuthorityPool.on('connect', (client) => client.on('error', () => undefined));
    traceAuthority = createPostgresTaskMailbox({
      pool: traceAuthorityPool,
      epoch: snapshotEpoch,
      // This fenced read takes 13 sequential SQL round trips plus connection
      // setup. 250 ms fails even at 20 ms RTT. One second covers 40 ms RTT
      // with setup margin, independently of terminal SQL and worker capacity.
      operationTimeoutMs: 1000,
    });
    const channelTraceAuthority = traceAuthority;
    const identity = createTaskKubernetesIdentity({ timeoutMs });
    const mailbox = createPostgresTaskMailbox({
      pool: channelPool,
      knownSecrets: [
        databaseUrl,
        ...(typeof rawPostgres.options.password === 'string' ? [rawPostgres.options.password] : []),
      ],
      commandFrameLimit: Math.min(
        settings['tasks.channel.maxFrameBytes'],
        settings['tasks.channel.maxUnackedBytes'],
        Math.floor(settings['tasks.channel.maxBufferedBytes'] / 4)
      ),
      epoch: snapshotEpoch,
      operationTimeoutMs: timeoutMs,
      onAppendSettled: () => {
        void replay.resync();
      },
    });
    notifyTaskCommands = (taskId) => {
      mailbox.notifyCommands(taskId);
    };
    const replay = createTaskChannelReplay({ mailbox, bus: busSignalStream, logger });
    let channel: ReturnType<typeof createTaskChannel> | undefined;
    stopTaskChannel = async (deadline) => {
      // Cancel intake AND checked-out task SQL before draining owner work.
      const listenerDrain = channel?.stop(deadline);
      identity.close();
      mailbox.stop();
      await replay.stop(deadline);
      await listenerDrain;
      await channelPool.end();
    };
    try {
      channel = createTaskChannel({
        tls: { ...leaf, read: readLeaf },
        settings,
        mailbox,
        identity,
        logger,
        readTraceAuthority: (proof, signal) =>
          channelTraceAuthority.readTraceAuthority(proof, signal),
        onTrace: (frame, briefing) => {
          traces.enqueue({
            kind: 'span',
            span: {
              ...frame.span,
              traceId: briefing.traceId,
              ...(frame.span.component === 'task'
                ? {
                    parentSpanId: briefing.parentSpanId,
                    attrs: {
                      ...frame.span.attrs,
                      taskId: briefing.taskId,
                      launchId: briefing.launchId,
                      harness: briefing.harness,
                    },
                  }
                : {}),
            },
          });
        },
        onStored: () => {
          void replay.resync();
        },
      });
      const server = channel.server;
      await new Promise<void>((resolveListen, reject) => {
        const failed = () => {
          clearTimeout(timer);
          reject(new Error('Task channel listener unavailable'));
        };
        const timer = setTimeout(failed, timeoutMs);
        server.once('error', failed);
        server.listen(port, '0.0.0.0', () => {
          clearTimeout(timer);
          server.removeListener('error', failed);
          resolveListen();
        });
      });
      void replay.start();
    } catch {
      await stopTaskChannel(Date.now() + timeoutMs);
      throw new Error('Task channel startup refused');
    }
  }

  // Prime the core queue with messages committed to the inbound stream.
  const replayedInbound = await inboundStream.readNew();
  for (const entry of replayedInbound) coreLoop.pushSignal(entry.signal);
  if (replayedInbound.length > 0) {
    logger.info({ count: replayedInbound.length }, 'Replayed pending inbound stream messages');
  }

  // Register components with state manager
  const stateManagerComponents: Parameters<typeof stateManager.registerComponents>[0] = {
    agent,
  };
  if (userModel) {
    stateManagerComponents.userModel = userModel;
  }
  stateManager.registerComponents(stateManagerComponents);
  snapshotStore.register({
    section: 'agentState',
    exportSnapshot: () => stateManager.exportSnapshot(),
    hydrateSnapshot: () => undefined,
  });
  snapshotStore.register({
    section: 'ackRegistry',
    exportSnapshot: () => ackRegistry.exportSnapshot(),
    hydrateSnapshot: async (value) => {
      await ackRegistry.load(value as PersistedAckRegistryState | undefined);
    },
  });
  snapshotStore.register(inboundStream);
  snapshotStore.register({
    section: 'tickCounter',
    exportSnapshot: () => coreLoop.getTickCount(),
    hydrateSnapshot: () => undefined,
  });

  // Start auto-save
  stateManager.startAutoSave();

  // Shutdown function with persistence: the ordered sequence lives in
  // shutdownSequence above (channels first ... storage last) so the order
  // itself is testable.
  // Idempotent (see makeIdempotentShutdown): the first call wins; a later
  // caller gets the same promise.
  const stopProgress: StopProgress = { step: 'done' };
  shutdown = makeIdempotentShutdown((stopDeadline) => {
    const deadline = stopDeadline ?? Date.now() + coreLoop.getStopDrainTimeoutMs();
    storageRetention?.stop();
    const taskDrain = taskLaunch?.stop(deadline);
    const taskFinalizerDrain = stopTaskFinalizer?.(deadline);
    const taskChannelDrain = stopTaskChannel?.(deadline);
    // Observe all rejections immediately, even while the core is still draining.
    const taskDrains = Promise.allSettled([taskDrain, taskChannelDrain, taskFinalizerDrain]);
    // Trace drain gets no independent stop budget. It may run only while
    // authoritative work remains, and cannot postpone state-store cleanup.
    const traceStop = new AbortController();
    const taskTraceDrain = stopTaskTraces(deadline, traceStop.signal);
    outboundDelivery.stop();
    return shutdownSequence({
      logger,
      deadline,
      channels: channels.values(),
      coreLoop,
      stateManager,
      recipientRegistry,
      progress: stopProgress,
    }).then(
      () => finishShutdown({ status: 'fulfilled', value: undefined }),
      (reason: unknown) => finishShutdown({ status: 'rejected', reason })
    );

    async function finishShutdown(outcome: PromiseSettledResult<void>): Promise<void> {
      // Worker-owned SQL was cancelled at intake stop; drain it inside the same
      // deadline before closing the shared pool, without touching turn clients.
      await closeTaskResources(
        taskDrains,
        [
          // Turn command commits drain with cognition before their clients close.
          async () => closeTaskCommands?.(),
          async () => {
            traceStop.abort();
            await taskTraceDrain;
          },
          () => snapshotRedis.quit(),
          () => postgres.end(),
        ],
        outcome
      );
    }
  });

  return {
    logger,
    eventBus,
    metrics,
    agent,
    layers,
    coreLoop,
    channels,
    userModel,
    llmProvider,
    messageComposer,
    cognitionLLM,
    memoryProvider,
    memoryConsolidator,
    soulProvider,
    storage,
    stateManager,
    conversationManager,
    config: mergedConfig,
    configLoader,
    reloadConfig,
    schedulerService,
    pluginLoader,
    recipientRegistry,
    motorCortex,
    taskService,
    inboundStream,
    creatureState: creatureStateStore,
    stopProgress: () => stopProgress.step,
    shutdown,
  };
}
