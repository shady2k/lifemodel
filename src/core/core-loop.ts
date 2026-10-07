/**
 * CoreLoop - the heartbeat of the 3-layer agent architecture.
 *
 * Unlike the EventLoop which uses dynamic tick intervals, CoreLoop:
 * - Uses a fixed 1-second tick (like a steady heartbeat)
 * - Processes Signals (not Events) through the 3-layer pipeline
 * - Channels act as "sensory organs" that emit Signals
 *
 * Pipeline per tick:
 * 1. Collect signals from sensory organs (channels)
 * 2. AUTONOMIC: neurons check state, emit internal signals
 * 3. AGGREGATION: collect signals, decide if COGNITION should wake
 * 4. COGNITION: (if woken) process with LLM (auto-retries with smart model if low confidence)
 * 5. Apply intents from all layers
 *
 * Note: SMART layer merged into COGNITION - smart retry is internal to COGNITION.
 */

import { randomUUID } from 'node:crypto';
import type {
  Signal,
  SignalSource,
  Logger,
  Metrics,
  Intent,
  Channel,
  ThoughtData,
  MessageReactionData,
  Event,
} from '../types/index.js';
import { createSignal, THOUGHT_LIMITS } from '../types/signal.js';
import { awaitWithinDeadline } from './deadline.js';
import { createTraceContext, withTraceContext, type TraceContext } from './trace-context.js';
import type {
  AutonomicResult,
  AggregationResult,
  CognitionResult,
  CognitionContext,
  TurnDisposition,
} from '../types/layers.js';
import type { Agent } from './agent.js';
import type { EventBus } from './event-bus.js';
import type { SystemHealthMonitor } from './system-health.js';
import {
  createSystemHealthMonitor,
  type SystemHealth,
  type SystemHealthConfig,
} from './system-health.js';
import type { AutonomicProcessor } from '../layers/autonomic/processor.js';
import type { AggregationProcessor } from '../layers/aggregation/processor.js';
import type { CognitionProcessor } from '../layers/cognition/processor.js';
import type { MessageComposer } from '../llm/composer.js';
import {
  type ConversationManager,
  CONVERSATION_TIMEOUTS,
} from '../storage/conversation-manager.js';
import type { UserModel } from '../models/user-model.js';
import type { CognitionLLM } from '../layers/cognition/agentic-loop.js';
import type { MemoryProvider } from '../layers/cognition/tools/registry.js';
import type { MemoryConsolidator } from '../storage/memory-consolidator.js';
import type { SoulProvider } from '../storage/soul-provider.js';
import type { AlertnessMode } from '../types/agent/state.js';
import type { SchedulerService } from './scheduler-service.js';
import type { IRecipientRegistry } from './recipient-registry.js';
import { runSleepMaintenance } from '../layers/cognition/soul/sleep-maintenance.js';
import { setPrimaryRecipientId } from './globals.js';
import { StatusUpdateService } from './status-update-service.js';
import { DomainTrackerService } from './domain-trackers.js';
import { IntentApplicator } from './intent-applicator.js';
import type { Storage } from '../storage/storage.js';
import type { PluginLoader } from './plugin-loader.js';
import type { PluginStatus } from '../layers/cognition/tools/core/manage.js';
import type { InboundLog } from './inbound-log.js';

/**
 * Core loop configuration.
 */
export interface CoreLoopConfig {
  /** Fixed tick interval in ms (default: 1000) */
  tickInterval: number;

  /**
   * How long the stop drain waits for the COGNITION turn in flight
   * (default: 90_000 = 90 s). If it overruns, its trigger signal is requeued
   * and processed again exactly once after the next start.
   */
  shutdownDrainTimeoutMs: number;

  /** Maximum signals to process per tick (default: 100) */
  maxSignalsPerTick: number;

  /** Prune signals every N ticks (default: 10) */
  pruneInterval: number;

  /** Primary user's Telegram chat ID for proactive messages */
  primaryUserChatId?: string | undefined;

  /** System health monitor configuration */
  health?: Partial<SystemHealthConfig>;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: CoreLoopConfig = {
  tickInterval: 1000, // Fixed 1-second tick
  maxSignalsPerTick: 100,
  pruneInterval: 10,
  shutdownDrainTimeoutMs: 90_000, // 90 s drain deadline for the turn in flight
};

/**
 * Layer processors for the 3-layer pipeline.
 * Note: SMART layer merged into COGNITION (smart retry is internal).
 */
export interface CoreLoopLayers {
  autonomic: AutonomicProcessor;
  aggregation: AggregationProcessor;
  cognition: CognitionProcessor;
}

/**
 * Optional dependencies.
 */
export interface CoreLoopDeps {
  messageComposer?: MessageComposer | undefined;
  conversationManager?: ConversationManager | undefined;
  userModel?: UserModel | undefined;
  /** Agent instance for agentic loop tools */
  agent?: Agent | undefined;
  /** COGNITION LLM adapter for agentic loop */
  cognitionLLM?: CognitionLLM | undefined;
  /** Memory provider for agentic loop tools */
  memoryProvider?: MemoryProvider | undefined;
  /** Memory consolidator for sleep-cycle consolidation */
  memoryConsolidator?: MemoryConsolidator | undefined;
  /** Recipient registry for Clean Architecture (recipientId → channel routing) */
  recipientRegistry?: IRecipientRegistry | undefined;
  /** Soul provider for identity awareness */
  soulProvider?: SoulProvider | undefined;
  /** Storage for intent applicator (plugin disable persistence) */
  storage?: Storage | undefined;
  /** Plugin loader for intent applicator (plugin disable/enable) */
  pluginLoader?: PluginLoader | undefined;
  /** Plugin manager for core.manage tool (list statuses) */
  pluginManager?: { listStatuses(): PluginStatus[] } | undefined;
  /**
   * Durable inbound log (lifemodel-ctc.2.1): inbound user messages are
   * appended here at emit time and flushed at once; their entries commit
   * per recipient when the turn's answer is delivered. Optional - without
   * it inbound user messages behave as before (no durability).
   */
  inboundLog?: InboundLog | undefined;
}

/**
 * Pending signal from a channel.
 */
interface PendingSignal {
  signal: Signal;
  timestamp: Date;
}

/**
 * Pending COGNITION operation (non-blocking).
 */
interface PendingCognition {
  /** Promise that resolves when COGNITION completes */
  promise: Promise<CognitionResult>;
  /** Correlation ID for logging */
  tickId: string;
  /** When the operation started */
  startedAt: number;
  /**
   * ALL trigger signals this turn owns (a wake may bundle several, e.g. two
   * user messages into one turn). If the turn overruns the stop deadline,
   * every one of them is requeued for a single redo after the next start.
   */
  triggerSignals: Signal[];
  /** The wake's first trigger (trace/typing/routing) */
  primaryTrigger: Signal | undefined;
  /**
   * User messages this turn absorbed mid-loop through
   * drainPendingUserMessages() - also requeued on overrun.
   */
  absorbedSignals: Signal[];
  /** Trace context captured when cognition started */
  traceContext: TraceContext;
}

/**
 * Commit bookkeeping for one cognition turn (the durable inbound log).
 */
interface PendingTurnCommits {
  /** The turn's tick id; the key of the turnCommits map. */
  tickId: string;
  /** The turn this bookkeeping belongs to (it owns the inbound log entries). */
  turn: PendingCognition;
  /** True once the turn settled with a result (sends still settle after). */
  resolved: boolean;
  /** Per recipient: sends in flight for the turn, how many were delivered, any failure, decided flag. */
  sends: Map<string, { pending: number; failed: boolean; decided: boolean; delivered: number }>;
  /**
   * How the turn ended (owner decision on review round 2, finding 4): only a
   * delivered answer or a DELIBERATE no-reply (`no_reply`/`defer`) may settle
   * the turn's log entries. Undefined means the turn never said - treated as
   * non-deliberate, so nothing settles without a delivered send.
   */
  disposition?: TurnDisposition | undefined;
}

/**
 * CoreLoop - orchestrates the 4-layer processing pipeline.
 */
export class CoreLoop {
  private readonly agent: Agent;
  private readonly eventBus: EventBus;
  private readonly layers: CoreLoopLayers;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly config: CoreLoopConfig;

  private running = false;
  private tickCount = 0;
  private tickTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Promise for the in-flight tick (so stop() can wait for it to settle) */
  private tickPromise: Promise<void> | null = null;
  /**
   * Signals the in-flight tick has taken off the queue. Cleared when the tick
   * finishes; while it runs they also belong to takePendingSignals(), so a
   * tick the stop deadline cut loose never discards a batch it already took.
   */
  private tickBatch: Signal[] = [];
  /**
   * Set once the stop drain is over: the turn in flight (if it overran) may
   * not apply further intents through its later immediate callbacks.
   */
  private lateEffectsFenced = false;
  /** TEST-ONLY gates that park the tick / scheduler callback (deadline tests) */
  private stallForTest: { tickGate?: Promise<void>; schedulerGate?: Promise<void> } = {};

  private readonly channels = new Map<string, Channel>();
  private readonly pendingSignals: PendingSignal[] = [];
  private readonly healthMonitor: SystemHealthMonitor;

  private readonly conversationManager: ConversationManager | undefined;
  private readonly userModel: UserModel | undefined;
  private readonly memoryProvider: MemoryProvider | undefined;
  private readonly memoryConsolidator: MemoryConsolidator | undefined;
  private readonly recipientRegistry: IRecipientRegistry | undefined;
  private readonly soulProvider: SoulProvider | undefined;
  private readonly cognitionLLM: CognitionLLM | undefined;

  /** Previous alertness mode for detecting transitions */
  private previousAlertnessMode: AlertnessMode | undefined;

  /** Subscription ID for typing events */
  private typingSubscriptionId: string | null = null;

  /** Pending COGNITION operation (non-blocking) */
  private pendingCognition: PendingCognition | null = null;

  /**
   * Commit bookkeeping for the durable inbound log, keyed by the turn's
   * tick id (see PendingTurnCommits).
   */
  private readonly turnCommits = new Map<string, PendingTurnCommits>();

  /**
   * The turn whose bookkeeping owns inbound messages NOW: it survives the
   * stop drain clearing pendingCognition (review round 2, finding 9), so
   * messages absorbed mid-drain still land on their turn and an immediate
   * send keeps its attribution. Cleared when the turn ends for any reason.
   */
  private activeTurnCommits: PendingTurnCommits | null = null;

  /** Durable inbound log (see CoreLoopDeps.inboundLog). */
  private readonly inboundLog: InboundLog | undefined;

  /** Scheduler service for plugin timers */
  private schedulerService: SchedulerService | null = null;

  /** Guard: true while a scheduler tick is in-flight (prevents re-entrant overlap) */
  private schedulerTickInFlight = false;

  /** Promise for the in-flight scheduler tick (for drain on shutdown) */
  private schedulerTickPromise: Promise<void> | null = null;

  /** Track thoughts emitted per tick for budget enforcement */
  private thoughtsThisTick = 0;

  /** Primary recipient ID for proactive features */
  private primaryRecipientId: string | undefined;

  /** Extracted service for domain status updates (predictions, opinions, desires, commitments) */
  private statusUpdates: StatusUpdateService | undefined;

  /** Extracted service for domain tracker scanning (commitments, predictions, desires, thoughts) */
  private domainTrackers: DomainTrackerService | undefined;

  /** Extracted intent applicator (handles the 15-case switch statement) */
  private readonly intentApplicator: IntentApplicator;

  constructor(
    agent: Agent,
    eventBus: EventBus,
    layers: CoreLoopLayers,
    logger: Logger,
    metrics: Metrics,
    config: Partial<CoreLoopConfig> = {},
    deps: CoreLoopDeps = {}
  ) {
    this.agent = agent;
    this.eventBus = eventBus;
    this.layers = layers;
    this.logger = logger.child({ component: 'core-loop' });
    this.inboundLog = deps.inboundLog;
    this.metrics = metrics;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.conversationManager = deps.conversationManager;
    this.userModel = deps.userModel;
    this.memoryProvider = deps.memoryProvider;
    this.memoryConsolidator = deps.memoryConsolidator;
    this.recipientRegistry = deps.recipientRegistry;
    this.soulProvider = deps.soulProvider;
    this.cognitionLLM = deps.cognitionLLM;

    // Initialize system health monitor
    this.healthMonitor = createSystemHealthMonitor(logger, config.health);

    // Set dependencies on layers
    // Include callback for immediate intent application (REMEMBER, SET_INTEREST)
    // so data is visible to subsequent tools in the same agentic loop
    this.layers.cognition.setDependencies({
      conversationManager: deps.conversationManager,
      userModel: deps.userModel,
      eventBus,
      agent: deps.agent,
      cognitionLLM: deps.cognitionLLM,
      memoryProvider: deps.memoryProvider,
      soulProvider: deps.soulProvider,
      pluginManager: deps.pluginManager,
      immediateIntentCallback: (intent) => {
        this.applyImmediateIntent(intent);
      },
    });

    // Set dependencies on AGGREGATION for conversation-aware proactive contact
    if ('updateDeps' in this.layers.aggregation) {
      // Convert primaryUserChatId to recipientId if both registry and chatId are available
      if (this.recipientRegistry && config.primaryUserChatId) {
        this.primaryRecipientId = this.recipientRegistry.getOrCreate(
          'telegram',
          config.primaryUserChatId
        );
        // Set global accessor so any part of the system can access it
        setPrimaryRecipientId(this.primaryRecipientId);
      }

      (this.layers.aggregation as { updateDeps: (deps: unknown) => void }).updateDeps({
        conversationManager: deps.conversationManager,
        userModel: deps.userModel,
        primaryRecipientId: this.primaryRecipientId,
      });
    }

    // Set primary recipient ID on AUTONOMIC for filter context
    // This allows filters (e.g., NewsSignalFilter) to set recipientId on urgent signals
    if ('setPrimaryRecipientId' in this.layers.autonomic) {
      (
        this.layers.autonomic as { setPrimaryRecipientId: (id: string | undefined) => void }
      ).setPrimaryRecipientId(this.primaryRecipientId);
    }

    // Initialize extracted services if memoryProvider is available
    if (deps.memoryProvider) {
      this.statusUpdates = new StatusUpdateService({
        memoryProvider: deps.memoryProvider,
        logger: this.logger,
        soulProvider: deps.soulProvider,
        conversationManager: deps.conversationManager,
        enqueueThought: (data, source) => {
          this.enqueueThoughtSignal(data, source as SignalSource);
        },
      });

      this.domainTrackers = new DomainTrackerService({
        memoryProvider: deps.memoryProvider,
        logger: this.logger,
        primaryRecipientId: this.primaryRecipientId,
      });
    }

    // Initialize intent applicator with all dependencies
    // The channels Map is passed by reference, so new channels registered later are visible
    this.intentApplicator = new IntentApplicator({
      agent,
      logger: this.logger,
      metrics,
      recipientRegistry: deps.recipientRegistry,
      channels: this.channels,
      conversationManager: deps.conversationManager,
      memoryProvider: deps.memoryProvider,
      userModel: deps.userModel,
      eventBus,
      aggregation: layers.aggregation,
      statusUpdates: this.statusUpdates,
      domainTrackers: this.domainTrackers,
      messageComposer: deps.messageComposer,
      enqueueThought: (data, source) => {
        this.enqueueThoughtSignal(data, source);
      },
      running: () => this.running,
      storage: deps.storage,
      pluginLoader: deps.pluginLoader,
      resolveSendTurnKey: (intent) => {
        // A cognition turn's answer carries the turn's tick id in its trace;
        // an in-loop immediate send (no trace) belongs to the turn running.
        const tickId = intent.trace?.tickId;
        if (tickId && this.turnCommits.has(tickId)) return tickId;
        return this.activeTurnCommits?.tickId ?? this.pendingCognition?.tickId;
      },
      onSendTracked: (turnKey, recipientId) => {
        const state = this.turnCommits.get(turnKey);
        if (!state) return;
        if (recipientId !== this.answeredRecipientOf(state)) return;
        const entry = state.sends.get(recipientId) ?? {
          pending: 0,
          failed: false,
          decided: false,
          delivered: 0,
        };
        entry.pending += 1;
        state.sends.set(recipientId, entry);
      },
      resolveSendEntryIdentity: (turnKey, recipientId) => {
        const turn = turnKey
          ? this.turnCommits.get(turnKey)?.turn
          : (this.activeTurnCommits ?? this.turnCommits.get(this.pendingCognition?.tickId ?? ''))
              ?.turn;
        if (!this.inboundLog || !turn) {
          return { seqs: [], delivered: false };
        }
        const seqs = this.ownedSeqs(turn, recipientId);
        // Evidence from ANOTHER turn only: the live turn may send more than
        // once (an acknowledgement, then the answer).
        return { seqs, delivered: this.inboundLog.hasDeliveryEvidence(seqs, turnKey) };
      },
      onSendOutcome: (turnKey, recipientId, delivered) => {
        return this.onTurnSendOutcome(turnKey, recipientId, delivered);
      },
    });
  }

  /** Durable inbound log accessor (observability/tests). */
  getInboundLog(): InboundLog | undefined {
    return this.inboundLog;
  }

  /**
   * Accept a signal that came from a sensory organ. Inbound user messages go
   * through the durable log FIRST: the entry is written and flushed before
   * the signal is queued, so a crash anywhere after receipt still has it.
   * A duplicate update_id is dropped instead of queued. Other signals behave
   * as before (queued immediately, not persisted - internal ones are
   * regenerated by ticks).
   *
   * A pendingPhoto receipt is written durably but NOT queued: it is replayed
   * by the next start, which completes (or re-fetches) the download (review
   * round 2, finding 7). A failed durable append throws - the update is not
   * acknowledged as handled (finding 8).
   */
  async pushInboundSignal(signal: Signal): Promise<void> {
    if (!this.inboundLog || signal.type !== 'user_message') {
      this.pushSignal(signal);
      return;
    }
    const data = signal.data as { recipientId?: unknown; pendingPhoto?: unknown } | undefined;
    if (typeof data?.recipientId !== 'string') {
      this.logger.warn(
        { signalId: signal.id },
        'user_message without recipientId accepted without the durable inbound log'
      );
      this.pushSignal(signal);
      return;
    }

    // Routing the answer needs after a restart (finding 1): the registry may
    // not have persisted its debounce yet when the process dies.
    let routing = null;
    const route = this.recipientRegistry?.resolve(data.recipientId);
    if (route) {
      routing = { channel: route.channel, destination: route.destination };
    }

    const accepted = await this.inboundLog.record(signal, routing);
    if (!accepted) {
      this.logger.debug(
        { signalId: signal.id },
        'Duplicate inbound update dropped by the durable log'
      );
      return;
    }
    if (typeof data.pendingPhoto === 'object' && data.pendingPhoto !== null) {
      // Durable receipt only - the completed photo message queues later.
      this.logger.debug({ signalId: signal.id }, 'Photo receipt logged durably (not queued)');
      return;
    }
    this.pushSignal(signal);
  }

  /** Map a log-owned seq for every user-message signal of a recipient. */
  private ownedSeqs(turn: PendingCognition, recipientId: string): number[] {
    if (!this.inboundLog) return [];
    const seqs: number[] = [];
    for (const signal of [...turn.triggerSignals, ...turn.absorbedSignals]) {
      const data = signal.data as { recipientId?: unknown } | undefined;
      if (signal.type !== 'user_message') continue;
      if (typeof data?.recipientId !== 'string' || data.recipientId !== recipientId) continue;
      const seq = this.inboundLog.seqForSignal(signal.id);
      if (seq !== undefined) seqs.push(seq);
    }
    return seqs;
  }

  /**
   * The ONE recipient this turn answers: real cognition routes everything
   * through triggerSignals[0] (review round 2, finding 2). Bundled messages
   * of OTHER recipients are not owned by this turn - at wake they go back to
   * the queue for their own turn; they can never be committed by it.
   */
  private answeredRecipientOf(state: PendingTurnCommits): string | undefined {
    const first = state.turn.triggerSignals[0];
    if (!first) return undefined;
    const data = first.data as { recipientId?: unknown } | undefined;
    return typeof data?.recipientId === 'string' ? data.recipientId : undefined;
  }

  /**
   * A send of the turn settled. When it was the turn's last open send for the
   * recipient and the turn has resolved, decide the recipient's commit now;
   * the promise is chained into the send chain so the stop drain awaits the
   * commit's flush too.
   */
  private async onTurnSendOutcome(
    turnKey: string,
    recipientId: string,
    delivered: boolean
  ): Promise<void> {
    const state = this.turnCommits.get(turnKey);
    if (!state) {
      // The turn was evicted (rejected/overrun): its entries stay
      // uncommitted and the next start replays them once.
      return;
    }
    const entry = state.sends.get(recipientId);
    if (!entry) {
      this.logger.warn(
        { turnKey, recipientId },
        'Send outcome for a recipient the turn did not track; ignored'
      );
      return;
    }
    entry.pending = Math.max(0, entry.pending - 1);
    if (delivered) {
      entry.delivered += 1;
    } else {
      entry.failed = true;
    }
    if (delivered && this.inboundLog) {
      // Durable delivery evidence, written BEFORE the commit decides
      // (finding 10): the answer really reached the chat, so a crash in the
      // window until the commit must not re-answer it on trust of text.
      const seqs = this.ownedSeqs(state.turn, recipientId);
      if (seqs.length > 0) {
        await this.inboundLog.markDelivered(seqs, turnKey);
      }
    }
    if (state.resolved && entry.pending === 0 && !entry.decided) {
      await this.commitTurnRecipient(state, recipientId);
    }
  }

  /** Commit (or record as failed) a resolved turn's log entries for one recipient. */
  private async commitTurnRecipient(state: PendingTurnCommits, recipientId: string): Promise<void> {
    const entry = state.sends.get(recipientId);
    if (entry) {
      entry.decided = true;
    }
    // Only the answered recipient (finding 2): anything else was never
    // served by this turn and stays queued/uncommitted for its own turn.
    if (this.answeredRecipientOf(state) !== recipientId) {
      return;
    }
    const seqs = this.ownedSeqs(state.turn, recipientId);
    if (seqs.length === 0) {
      return;
    }
    if (entry?.failed) {
      // The answer was not delivered: the entries stay uncommitted so the
      // next start replays them - the message is answered after restart
      // exactly once, never silently dropped (review findings E/3: a send
      // that could not start is a FAILED delivery, not a no-send).
      this.logger.warn(
        { recipientId, entries: seqs.length },
        'Turn settled but its answer was not delivered; inbound log entries stay uncommitted for replay'
      );
      return;
    }
    // Owner decision (review round 2, finding 4): a turn settles its entries
    // ONLY with a delivered answer or with a DELIBERATE no-reply (core.defer,
    // an explicit noAction). An error, a rejected turn, a failed send or a
    // turn that never said how it ended leaves the entries for replay.
    const disposition = state.disposition;
    const deliberateNoReply = disposition === 'no_reply' || disposition === 'defer';
    const delivered = entry?.delivered ?? 0;
    if (delivered === 0 && !deliberateNoReply) {
      this.logger.warn(
        { recipientId, entries: seqs.length, disposition: disposition ?? 'unknown' },
        'Turn settled without a delivered answer and without a deliberate no-reply; inbound log entries stay uncommitted for replay'
      );
      return;
    }
    if (this.inboundLog) {
      await this.inboundLog.commit(seqs);
      this.logger.info(
        { recipientId, entries: seqs.length, delivered, disposition: disposition ?? 'unknown' },
        'Inbound log entries committed (answer delivered or deliberate no-reply)'
      );
    }
  }

  /** Turn-production-time hook: only the ANSWERED recipient is owned (finding 2). */
  private registerTurnCommit(tickId: string, turn: PendingCognition): void {
    const sends = new Map<
      string,
      { pending: number; failed: boolean; decided: boolean; delivered: number }
    >();
    const state: PendingTurnCommits = { tickId, turn, resolved: false, sends };
    const answered = this.answeredRecipientOf(state);
    if (answered !== undefined) {
      state.sends.set(answered, { pending: 0, failed: false, decided: false, delivered: 0 });
    }
    this.turnCommits.set(tickId, state);
    this.activeTurnCommits = state;
    this.requeueUnownedTriggers(state);
  }

  /** Bundled user messages of OTHER recipients are not served by this turn
   * (finding 2): requeue them for their own turn. */
  private requeueUnownedTriggers(state: PendingTurnCommits): void {
    const answered = this.answeredRecipientOf(state);
    for (const signal of state.turn.triggerSignals) {
      if (signal.type !== 'user_message') continue;
      const data = signal.data as { recipientId?: unknown } | undefined;
      const recipientId = typeof data?.recipientId === 'string' ? data.recipientId : undefined;
      if (recipientId === undefined || recipientId === answered) continue;
      this.pushSignal(signal);
      this.logger.debug(
        { signalId: signal.id, recipientId },
        'Bundled user message of another recipient requeued for its own turn'
      );
    }
  }

  /** Turn resolved without a result (rejected or overran): never commit. */
  private evictTurnCommit(tickId: string): void {
    this.turnCommits.delete(tickId);
    if (this.activeTurnCommits?.tickId === tickId) {
      this.activeTurnCommits = null;
    }
  }

  /** Turn resolved with a result: its recipients commit (send outcome permitting). */
  private resolveTurnCommit(tickId: string, disposition?: TurnDisposition): void {
    const state = this.turnCommits.get(tickId);
    if (state) {
      state.resolved = true;
      state.disposition = disposition;
      // The turn's loop is finished: no more mid-loop absorption can land.
      if (this.activeTurnCommits?.tickId === tickId) {
        this.activeTurnCommits = null;
      }
    }
  }

  /**
   * After a resolved turn's intents were applied, commit everything that is
   * already decidable; sends still in flight leave their recipients to the
   * onSendOutcome callback. Called with await so the flushes settle before
   * the stop goes on (bounded by the send chains inside).
   */
  private async evaluateTurnCommits(): Promise<void> {
    for (const [key, state] of [...this.turnCommits.entries()]) {
      if (!state.resolved) continue;
      const answered = this.answeredRecipientOf(state);
      if (answered !== undefined) {
        const entry = state.sends.get(answered);
        if (!entry || (entry.pending === 0 && !entry.decided)) {
          await this.commitTurnRecipient(state, answered);
        }
      }
      const sendEntries = [...state.sends.entries()];
      if (sendEntries.length === 0 || sendEntries.every(([, e]) => e.decided)) {
        this.turnCommits.delete(key);
        if (this.activeTurnCommits?.tickId === key) {
          this.activeTurnCommits = null;
        }
      }
    }
  }

  /**
   * Start the signal loop.
   */
  start(): void {
    if (this.running) {
      this.logger.warn('Core loop already running');
      return;
    }

    this.running = true;
    this.lateEffectsFenced = false;

    // Start system health monitoring
    this.healthMonitor.start();

    // Subscribe to typing events
    this.typingSubscriptionId = this.eventBus.subscribe(
      (event) => void this.handleTypingEvent(event),
      { source: 'internal', type: 'typing_start' }
    );

    this.logger.info({ tickInterval: this.config.tickInterval }, 'Core loop started');

    // Schedule first tick immediately
    this.scheduleTick();
  }

  /**
   * Stop the signal loop. One stop deadline bounds every wait (the in-flight
   * tick, the scheduler callback, the COGNITION turn, its sends); past it the
   * stop continues and the unprocessed is journaled.
   */
  async stop(deadlineMs?: number): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.tickTimeout) {
      clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }

    // Stop system health monitoring
    this.healthMonitor.stop();

    // Unsubscribe from typing events
    if (this.typingSubscriptionId) {
      this.eventBus.unsubscribe(this.typingSubscriptionId);
      this.typingSubscriptionId = null;
    }

    const deadline = deadlineMs ?? Date.now() + this.config.shutdownDrainTimeoutMs;

    // The in-flight tick and the scheduler callback are waited on here (so no
    // signal handling races the drain below); each wait is bounded by the ONE
    // overall stop deadline.
    await awaitWithinDeadline(
      Promise.all([this.tickPromise, this.stallForTest.tickGate ?? Promise.resolve()]).then(
        () => undefined
      ),
      deadline,
      this.logger,
      'tick in flight'
    );
    await awaitWithinDeadline(
      Promise.all([
        this.schedulerTickPromise ?? Promise.resolve(),
        this.stallForTest.schedulerGate ?? Promise.resolve(),
      ]).then(() => undefined),
      deadline,
      this.logger,
      'scheduler tick'
    );

    // Wait for the COGNITION turn in flight, bounded by the same deadline;
    // on overrun every signal the turn owns is requeued.
    await this.drainPendingCognition(deadline);

    // Sends the drained turn scheduled must be delivered (or reported failed)
    // BEFORE the container releases the channels.
    await this.awaitPendingSends(deadline);

    // The stop is over: the turn in flight (if it overran) may not apply
    // further intents through its later immediate callbacks.
    this.lateEffectsFenced = true;

    this.logger.info({ tickCount: this.tickCount }, 'Core loop stopped');
  }

  /**
   * The stop-drain budget in ms (see shutdownDrainTimeoutMs). The container
   * starts ONE overall deadline from it, covering intake stop, the tick, the
   * scheduler callback, the turn in flight and its sends.
   */
  getStopDrainTimeoutMs(): number {
    return this.config.shutdownDrainTimeoutMs;
  }

  /**
   * Wait until no SEND_MESSAGE chain is in flight (or the deadline passes);
   * what remains is logged, and the stop proceeds (the container releases the
   * channels next).
   */
  private async awaitPendingSends(deadline: number): Promise<void> {
    await this.intentApplicator.drainPendingSends(deadline);
    const remaining = this.intentApplicator.pendingSendCount();
    if (remaining > 0) {
      this.logger.warn(
        { remaining },
        'Sends still in flight at the stop deadline; releasing the channels anyway'
      );
    }
  }

  /**
   * Empty the pending-signal queue and return it.
   * Called by the container after stop() to persist what was accepted
   * but never processed (see src/core/pending-signal-journal.ts).
   */
  /** How many signals are queued (accepted, not yet processed). Observable for tests. */
  pendingSignalCount(): number {
    return this.pendingSignals.length;
  }

  /**
   * TEST-ONLY hooks: how many signals the in-flight tick currently holds, and
   * gates that park the tick / scheduler callback so a test can observe a stop
   * against a stalled wait (the deadline must cut it loose).
   */
  takenBatchCount(): number {
    return this.tickBatch.length;
  }

  /**
   * TEST-ONLY: the tick id of the COGNITION turn the loop still owns, or null
   * when none is claimed. The stop drain claims (clears) the turn before it
   * awaits it, so a test can gate on this to prove a mid-drain message is
   * absorbed AFTER the claim (review round 2, finding 9).
   */
  pendingCognitionTickId(): string | null {
    return this.pendingCognition?.tickId ?? null;
  }

  setStallForTest(gates: { tickGate?: Promise<void>; schedulerGate?: Promise<void> }): void {
    this.stallForTest = gates;
  }

  /**
   * TEST-ONLY: emulate a kill -9 on a loop under test. The timer and the
   * health monitor stop and the loop is no longer running, but NOTHING is
   * drained, applied or committed - the instance is as dead as a killed
   * process. A crashed instance must not keep ticking behind the restart
   * under test: one leaked 5ms timer per killed instance made the photo
   * restart test load-dependent (review round 2, item 10).
   */
  haltForTest(): void {
    this.running = false;
    if (this.tickTimeout) {
      clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }
    this.healthMonitor.stop();
    if (this.typingSubscriptionId) {
      this.eventBus.unsubscribe(this.typingSubscriptionId);
      this.typingSubscriptionId = null;
    }
  }

  takePendingSignals(): Signal[] {
    const seen = new Set<string>();
    const out: Signal[] = [];
    const take = (signals: Signal[]) => {
      for (const signal of signals) {
        if (seen.has(signal.id)) continue;
        seen.add(signal.id);
        out.push(signal);
      }
    };
    take(this.pendingSignals.splice(0).map((entry) => entry.signal));
    // Whatever the in-flight tick still holds was accepted too: journal it,
    // never discard it (a stopped tick's taken batch is not lost).
    take(this.tickBatch);
    this.tickBatch = [];
    return out;
  }

  /**
   * Await the COGNITION turn in flight, bounded by the overall stop deadline.
   * - finished in time: its result intents are applied here (normally the
   *   next tick does that, but ticks no longer run); stop() then awaits its
   *   sends before the channels are released.
   * - overran: EVERY signal the turn owns - all trigger signals plus the user
   *   messages it absorbed mid-loop - is requeued (FIFO) for a single redo
   *   after the next start; the abandoned turn's own result is dropped.
   * - rejected: logged like the regular tick error path, with the error.
   */
  private async drainPendingCognition(deadline: number): Promise<void> {
    const pending = this.pendingCognition;
    if (!pending) {
      return;
    }
    // No tick will run again, so claim the turn now to prevent any start
    // racing from a tick that is finishing.
    this.pendingCognition = null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending.promise.then((result) => ({ kind: 'done', result }) as const),
        new Promise<{ kind: 'drain_deadline' }>((resolve) => {
          timer = setTimeout(
            () => {
              resolve({ kind: 'drain_deadline' });
            },
            Math.max(0, deadline - Date.now())
          );
        }),
      ]);

      if (outcome.kind === 'drain_deadline') {
        this.evictTurnCommit(pending.tickId);
        const owned = [...pending.triggerSignals, ...pending.absorbedSignals];
        withTraceContext(pending.traceContext, () => {
          this.logger.warn(
            {
              tickId: pending.tickId,
              requeued: owned.length,
              deadlineBudgetMs: this.config.shutdownDrainTimeoutMs,
            },
            'COGNITION turn in flight overran the stop deadline; the signals it owns are requeued for the next start'
          );
        });
        // Preserve FIFO: triggers arrived before what it absorbed mid-turn.
        for (let i = owned.length - 1; i >= 0; i--) {
          const signal = owned[i];
          if (signal) {
            this.pendingSignals.unshift({ signal, timestamp: new Date() });
          }
        }
        return;
      }

      withTraceContext(pending.traceContext, () => {
        this.logger.info(
          { tickId: pending.tickId, duration: Date.now() - pending.startedAt },
          'COGNITION turn in flight completed during the stop drain'
        );
      });
      this.resolveTurnCommit(pending.tickId, outcome.result.disposition);
      this.applyIntents(outcome.result.intents, pending.traceContext);
      // Commit what is decidable now; sends still in flight turn the rest
      // through their outcome callbacks (each flush is chained onto its
      // send chain, so stop()'s awaitPendingSends waits for it too).
      await this.evaluateTurnCommits();
    } catch (error: unknown) {
      withTraceContext(pending.traceContext, () => {
        this.logger.error(
          { err: error, tickId: pending.tickId },
          'COGNITION rejected unexpectedly during the stop drain'
        );
      });
      this.evictTurnCommit(pending.tickId);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Check if the loop is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register a channel (sensory organ).
   */
  registerChannel(channel: Channel): void {
    if (this.channels.has(channel.name)) {
      this.logger.warn({ channel: channel.name }, 'Channel already registered, replacing');
    }
    this.channels.set(channel.name, channel);
    this.logger.info({ channel: channel.name }, 'Channel registered');
  }

  /**
   * Unregister a channel.
   */
  unregisterChannel(name: string): boolean {
    const removed = this.channels.delete(name);
    if (removed) {
      this.logger.info({ channel: name }, 'Channel unregistered');
    }
    return removed;
  }

  /**
   * Get a registered channel by name.
   */
  getChannel(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  /**
   * Get current tick count.
   */
  getTickCount(): number {
    return this.tickCount;
  }

  /**
   * Get current system health.
   */
  getHealth(): SystemHealth {
    return this.healthMonitor.getHealth();
  }

  /**
   * Get the health monitor (for testing/debugging).
   */
  getHealthMonitor(): SystemHealthMonitor {
    return this.healthMonitor;
  }

  /**
   * Push a signal into the pending queue.
   * Called by channels when they receive data.
   */
  pushSignal(signal: Signal): void {
    this.pendingSignals.push({
      signal,
      timestamp: new Date(),
    });
  }

  /**
   * Schedule the next tick.
   */
  private scheduleTick(): void {
    if (!this.running) return;

    this.tickTimeout = setTimeout(() => {
      // tick() never rejects: its body is a try/catch. Assigned so stop()
      // can wait for the in-flight tick before draining COGNITION.
      this.tickPromise = this.tick();
    }, this.config.tickInterval);
  }

  /**
   * Execute one tick cycle.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const tickStart = Date.now();
    this.tickCount++;
    this.thoughtsThisTick = 0; // Reset per-tick thought budget
    const tickId = randomUUID();
    const tickCtx = createTraceContext(tickId, { spanId: `tick_${String(this.tickCount)}` });

    try {
      // ============================================================================
      // TICK-INITIATED OPERATIONS (run every tick regardless of signals)
      // Uses tickId as trace root for grouping housekeeping work
      // ============================================================================

      // Apply pending plugin changes only when no scheduler tick is in-flight.
      // applyPendingChanges() mutates scheduler state (unregister/pause) which is
      // unsafe while schedulerService.tick() is iterating schedulers concurrently.
      if (!this.schedulerTickInFlight) {
        this.schedulerService?.applyPendingChanges();
      }

      // Check system health - determines which layers are active
      const health = this.healthMonitor.getHealth();
      const { activeLayers, stressLevel } = health;

      const state = this.agent.getState();

      await withTraceContext(tickCtx, async () => {
        this.logger.trace(
          {
            tick: this.tickCount,
            energy: state.energy.toFixed(2),
            socialDebt: state.socialDebt.toFixed(2),
            pendingSignals: this.pendingSignals.length,
            stressLevel,
            tickId,
          },
          '⏱️ Tick starting'
        );

        // Run domain trackers before neurons (pressure calculations + overdue scanning)
        if (this.domainTrackers) {
          const state = this.agent.getState();
          const [thoughtResult, desireResult] = await Promise.all([
            this.domainTrackers.calculateThoughtPressure(state.energy),
            this.domainTrackers.calculateDesirePressure(),
          ]);
          if (thoughtResult.thoughtPressure !== undefined) {
            this.agent.updateState({
              thoughtPressure: thoughtResult.thoughtPressure,
              pendingThoughtCount: thoughtResult.pendingThoughtCount ?? 0,
            });
          }
          if (desireResult.desirePressure !== undefined) {
            this.agent.updateState({ desirePressure: desireResult.desirePressure });
          }

          // Scan for overdue commitments and predictions (produce signals)
          const [commitmentSignals, predictionSignals] = await Promise.all([
            this.domainTrackers.checkOverdueCommitments(),
            this.domainTrackers.checkOverduePredictions(),
          ]);
          for (const signal of commitmentSignals) this.pushSignal(signal);
          for (const signal of predictionSignals) this.pushSignal(signal);
        }
      });

      // ============================================================================
      // SIGNAL-INITIATED OPERATIONS (only when signals exist)
      // Each signal gets its own trace context (signal.id as trace root)
      // correlationId=tickId links all signals to the same tick
      // ============================================================================
      const allIntents: Intent[] = [];
      let allSignals: Signal[] = [];

      // Drain signals (no side effects, no logs)
      const pendingSignals = this.drainPendingSignals();
      // What this tick holds: journaled too if the stop cuts it loose.
      this.tickBatch = pendingSignals;

      // Normalize each signal under its own trace context
      const incomingSignals: Signal[] = [];
      for (const signal of pendingSignals) {
        const signalCtx = createTraceContext(signal.id, { correlationId: tickId });
        const normalized = await withTraceContext(signalCtx, () => this.normalizeSignal(signal));
        incomingSignals.push(normalized);
      }

      // AUTONOMIC layer (batch processing, no per-signal context to prevent leakage)
      if (activeLayers.autonomic) {
        const autonomicResult = await this.processAutonomic(incomingSignals, tickId);
        allIntents.push(...autonomicResult.intents);
        allSignals = autonomicResult.signals;
      } else {
        allSignals = incomingSignals;
        withTraceContext(tickCtx, () => {
          this.logger.warn(
            {
              stressLevel,
              eventLoopLagMs: health.eventLoopLagMs.toFixed(1),
              cpuPercent: health.cpuPercent.toFixed(1),
              elu: health.eventLoopUtilization.toFixed(3),
            },
            'AUTONOMIC layer disabled due to stress'
          );
        });
      }

      // Defer signals that need LLM processing if COGNITION is busy or disabled by stress
      // These signals must wait for COGNITION to be free — otherwise they're consumed and lost
      const deferrableTypes = ['thought', 'message_reaction', 'user_message', 'motor_result'];
      const hasDeferrableSignals = allSignals.some((s) => deferrableTypes.includes(s.type));
      const cognitionAvailable = !this.pendingCognition && activeLayers.cognition;
      if (!cognitionAvailable && hasDeferrableSignals) {
        const toDefer = allSignals.filter((s) => deferrableTypes.includes(s.type));
        const otherSignals = allSignals.filter((s) => !deferrableTypes.includes(s.type));

        const deferReason = this.pendingCognition
          ? 'COGNITION busy'
          : `COGNITION disabled (stress: ${stressLevel})`;

        withTraceContext(tickCtx, () => {
          this.logger.debug(
            {
              reason: deferReason,
              thoughts: toDefer.filter((s) => s.type === 'thought').length,
              reactions: toDefer.filter((s) => s.type === 'message_reaction').length,
              userMessages: toDefer.filter((s) => s.type === 'user_message').length,
            },
            `Deferring signals to next tick: ${deferReason}`
          );
        });

        // Re-queue at the front for next tick (FIFO order preserved)
        for (let i = toDefer.length - 1; i >= 0; i--) {
          const signal = toDefer[i];
          if (signal) {
            this.pendingSignals.unshift({ signal, timestamp: new Date() });
          }
        }
        allSignals = otherSignals;
      }

      // AGGREGATION layer (batch processing)
      let aggregationResult: AggregationResult | null = null;
      if (activeLayers.aggregation) {
        aggregationResult = await this.processAggregation(allSignals);
        allIntents.push(...aggregationResult.intents);
      } else {
        withTraceContext(tickCtx, () => {
          this.logger.warn(
            {
              stressLevel,
              eventLoopLagMs: health.eventLoopLagMs.toFixed(1),
              cpuPercent: health.cpuPercent.toFixed(1),
              elu: health.eventLoopUtilization.toFixed(3),
            },
            'AGGREGATION layer disabled due to stress'
          );
        });
      }

      // Check pending COGNITION completion
      let cognitionResult: CognitionResult | null = null;
      if (this.pendingCognition) {
        const result = await this.checkPendingCognition();
        if (result) {
          cognitionResult = result;
          allIntents.push(...result.intents);
        }
      }

      const shouldWakeCognition = aggregationResult?.wakeCognition && activeLayers.cognition;

      // Start COGNITION if needed (capture trace context from trigger signal)
      if (shouldWakeCognition && aggregationResult && !this.pendingCognition) {
        // Log conversation status for debugging proactive contact issues
        let convStatus = 'unknown';
        if (this.conversationManager && this.primaryRecipientId) {
          try {
            convStatus = (await this.conversationManager.getStatus(this.primaryRecipientId)).status;
          } catch {
            // Non-critical - proceed with unknown status
          }
        }

        withTraceContext(tickCtx, () => {
          this.logger.debug(
            { wakeReason: aggregationResult.wakeReason, conversationStatus: convStatus },
            '🧠 COGNITION layer woken (non-blocking)'
          );
        });

        const cognitionContext = this.buildCognitionContext(
          aggregationResult,
          tickId,
          activeLayers.smart
        );

        const triggerSignal = aggregationResult.triggerSignals[0];
        const traceContext = triggerSignal
          ? createTraceContext(triggerSignal.id, { correlationId: tickId })
          : tickCtx;

        this.startCognitionAsync(
          cognitionContext,
          aggregationResult.triggerSignals,
          triggerSignal,
          traceContext
        );
      } else if (this.pendingCognition && shouldWakeCognition) {
        withTraceContext(tickCtx, () => {
          this.logger.debug('COGNITION already processing, waiting for completion');
        });
      }

      if (aggregationResult?.wakeCognition && !activeLayers.cognition) {
        withTraceContext(tickCtx, () => {
          this.logger.warn(
            {
              stressLevel,
              wakeReason: aggregationResult.wakeReason,
              eventLoopLagMs: health.eventLoopLagMs.toFixed(1),
              cpuPercent: health.cpuPercent.toFixed(1),
              elu: health.eventLoopUtilization.toFixed(3),
            },
            'COGNITION layer disabled due to stress - wake blocked'
          );
        });
      }

      // ============================================================================
      // TICK-INITIATED OPERATIONS (rest of tick work stays under tick context)
      // ============================================================================
      await withTraceContext(tickCtx, async () => {
        // Update agent state (energy, social debt, etc.)
        const agentIntents = this.agent.tick();
        allIntents.push(...agentIntents);

        // Sleep mode transition - memory consolidation
        const currentMode = this.agent.getAlertnessMode();
        if (
          this.memoryConsolidator &&
          this.memoryProvider &&
          currentMode === 'sleeping' &&
          this.previousAlertnessMode !== 'sleeping'
        ) {
          this.logger.info('Entering sleep mode - triggering maintenance');
          void this.memoryConsolidator.consolidate(this.memoryProvider).then((result) => {
            this.logger.info(
              {
                merged: result.merged,
                forgotten: result.forgotten,
                before: result.totalBefore,
                after: result.totalAfter,
                durationMs: result.durationMs,
                thoughtsGenerated: result.thoughts.length,
              },
              'Memory consolidation complete'
            );
            this.metrics.counter('memory_consolidations');
            this.metrics.gauge('memory_entries_merged', result.merged);
            this.metrics.gauge('memory_entries_forgotten', result.forgotten);

            let queuedCount = 0;
            for (const thoughtData of result.thoughts) {
              if (this.enqueueThoughtSignal(thoughtData, 'memory.thought' as SignalSource)) {
                queuedCount++;
              }
            }

            if (queuedCount > 0) {
              this.logger.info(
                { queued: queuedCount, total: result.thoughts.length },
                'Memory thoughts queued'
              );
              this.metrics.gauge('memory_thoughts_queued', queuedCount);
            }
          });

          // Prune dedup sets to prevent unbounded growth
          if (this.domainTrackers) {
            void this.domainTrackers.pruneSignaledSets().catch((err: unknown) => {
              this.logger.warn({ error: err }, 'Failed to prune dedup sets during sleep');
            });
          }

          // Soul sleep maintenance
          if (this.soulProvider) {
            void runSleepMaintenance({
              logger: this.logger,
              soulProvider: this.soulProvider,
              memoryProvider: this.memoryProvider,
              cognitionLLM: this.cognitionLLM,
              userModel: this.userModel,
            }).then((result) => {
              if (result.success) {
                this.logger.info(
                  {
                    voicesRefreshed: result.voicesRefreshed,
                    softLearningPromoted: result.softLearningPromoted,
                    thoughtsMarkedForPruning: result.thoughtsMarkedForPruning,
                    durationMs: result.durationMs,
                  },
                  'Soul sleep maintenance complete'
                );
                this.metrics.counter('soul_sleep_maintenances');
                this.metrics.gauge('soul_voices_refreshed', result.voicesRefreshed);
                this.metrics.gauge('soul_soft_learning_promoted', result.softLearningPromoted);
              } else {
                this.logger.warn({ error: result.error }, 'Soul sleep maintenance failed');
              }
            });
          }
        }
        this.previousAlertnessMode = currentMode;

        // Update user model beliefs (time-based decay)
        if (this.userModel) {
          this.userModel.updateTimeBasedBeliefs();
        }

        // Check conversation status decay
        if (this.conversationManager && this.primaryRecipientId) {
          await this.checkConversationDecay();
        }

        // Check plugin schedulers for due events (non-blocking — fire and forget).
        // Plugin event callbacks may run Docker containers that take 10-30s.
        // Blocking the tick loop would freeze signal processing and conversation decay.
        // Guard prevents re-entrant overlap (next tick skips if previous still running).
        if (this.schedulerService && !this.schedulerTickInFlight) {
          this.schedulerTickInFlight = true;
          this.schedulerTickPromise = this.schedulerService
            .tick()
            .catch((error: unknown) => {
              this.logger.error(
                { error: error instanceof Error ? error.message : String(error) },
                'Scheduler service tick failed'
              );
            })
            .finally(() => {
              this.schedulerTickInFlight = false;
              this.schedulerTickPromise = null;
            });
        }

        // Apply all intents (per-intent context handled inside)
        this.applyIntents(allIntents, tickCtx);
        // Commit the durable inbound log entries of a turn that resolved in
        // this tick (answer delivered or nothing to send).
        await this.evaluateTurnCommits();

        // Periodic maintenance
        if (activeLayers.aggregation && this.tickCount % this.config.pruneInterval === 0) {
          const pruned = this.layers.aggregation.prune();
          if (pruned > 0) {
            this.logger.debug({ pruned }, 'Signals pruned from aggregation');
          }
        }

        // Log tick summary
        const tickDuration = Date.now() - tickStart;
        this.logger.trace(
          {
            tick: this.tickCount,
            duration: tickDuration,
            signalsProcessed: allSignals.length,
            intentsApplied: allIntents.length,
            cognitionWoke: shouldWakeCognition,
            usedSmartRetry: cognitionResult?.usedSmartRetry,
            stressLevel,
            energy: this.agent.getEnergy().toFixed(2),
          },
          'Tick completed'
        );

        // Metrics
        this.metrics.counter('signal_loop_ticks');
        this.metrics.gauge('signal_loop_tick_duration', tickDuration);
        this.metrics.gauge('signal_loop_signals_processed', allSignals.length);
        this.metrics.gauge('system_event_loop_lag_ms', health.eventLoopLagMs);
        this.metrics.gauge('system_cpu_percent', health.cpuPercent);
        this.metrics.gauge('system_elu', health.eventLoopUtilization);
        this.metrics.gauge('system_stress_level', this.stressLevelToNumber(stressLevel));

        this.scheduleTick();
      });
      // The tick is done: its taken batch was either processed or requeued
      // (deferrals above) - it no longer belongs to the stop journal.
      this.tickBatch = [];
    } catch (error) {
      const errorDetails =
        error instanceof Error
          ? { message: error.message, stack: error.stack, name: error.name }
          : { raw: String(error), type: typeof error };

      withTraceContext(tickCtx, () => {
        this.logger.error({ error: errorDetails, tick: this.tickCount }, 'Tick failed');
      });

      // A tick that failed mid-batch while the process is STOPPING must not
      // lose the batch either: hand it back to the queue the journal reads.
      if (!this.running && this.tickBatch.length > 0) {
        for (const signal of this.tickBatch) {
          this.pendingSignals.unshift({ signal, timestamp: new Date() });
        }
      }
      this.tickBatch = [];

      this.scheduleTick();
    }
  }

  /**
   * Drain pending signals without side effects or logging.
   * Separated from normalization to enable per-signal trace context.
   */
  private drainPendingSignals(): Signal[] {
    const signals: Signal[] = [];
    const maxSignals = this.config.maxSignalsPerTick;

    while (this.pendingSignals.length > 0 && signals.length < maxSignals) {
      const pending = this.pendingSignals.shift();
      if (pending) {
        signals.push(pending.signal);
      }
    }

    return signals;
  }

  /**
   * Normalize a single signal (side effects + enrichment).
   * This should be called inside a per-signal trace context.
   */
  private async normalizeSignal(signal: Signal): Promise<Signal> {
    let normalized = signal;

    // Special handling for user messages
    if (normalized.type === 'user_message') {
      this.processUserMessageSignal(normalized);
    }

    // Enrich reaction signals with message preview and add to history as metadata
    // Reactions are passive feedback - they don't wake COGNITION, but appear in history
    // for context when the LLM next processes a message
    if (normalized.type === 'message_reaction') {
      normalized = await this.enrichReactionSignal(normalized);
      await this.processReactionSignal(normalized);
    }

    return normalized;
  }

  /**
   * Process a reaction signal by adding it to conversation history as metadata.
   *
   * Reactions are passive feedback, not user instructions. By adding them as
   * system messages:
   * - They don't wake COGNITION (no immediate response)
   * - They don't inflate turn count (system messages aren't counted)
   * - LLM sees them as context on next interaction, can learn from them
   *
   * This follows the "Energy Conservation" principle - passive signals don't
   * deserve expensive conscious thought.
   */
  private async processReactionSignal(signal: Signal): Promise<void> {
    const data = signal.data as MessageReactionData;
    if (!this.conversationManager || !data.recipientId) return;

    // Skip if already added to history (prevents duplicates on deferral re-queue)
    if (data.historyAdded) return;

    // Skip noisy removal events when we don't have the original message
    if (data.isRemoval && !data.reactedMessagePreview) return;

    const rawPreview = data.reactedMessagePreview ?? '[message not found]';
    // Sanitize preview: strip control chars, escape special chars
    const preview = rawPreview
      .slice(0, 100)
      .split('')
      .filter((c) => {
        const code = c.charCodeAt(0);
        // Keep printable ASCII and non-ASCII (UTF-8), strip control chars
        return code >= 32 && code !== 127;
      })
      .join('')
      .replace(/[[\]"\n\r]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\' + c));

    const content = data.isRemoval
      ? `[Reaction: User removed ${data.emoji} from: "${preview}"]`
      : `[Reaction: User reacted ${data.emoji} to: "${preview}"]`;

    await this.conversationManager.addMessage(data.recipientId, {
      role: 'system',
      content,
    });

    // Mark as processed to prevent duplicates on deferral re-queue
    data.historyAdded = true;
  }

  /**
   * Enrich a reaction signal with the original message preview.
   * Looks up the message in conversation history by channel message ID.
   */
  private async enrichReactionSignal(signal: Signal): Promise<Signal> {
    const data = signal.data as MessageReactionData;
    if (data.reactedMessagePreview) return signal; // Already enriched

    if (!this.conversationManager) {
      return signal;
    }

    try {
      const message = await this.conversationManager.getMessageByChannelId(
        data.recipientId,
        data.channel,
        data.reactedMessageId
      );

      if (message?.content) {
        // Clone signal with enriched data (sanitize preview)
        return {
          ...signal,
          data: {
            ...data,
            reactedMessagePreview: message.content.slice(0, 100).replace(/[\n\r]/g, ' '),
          },
        };
      }
    } catch (error) {
      this.logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to enrich reaction signal with message preview'
      );
    }

    return signal;
  }

  /**
   * Process user message signal for side effects.
   */
  private processUserMessageSignal(signal: Signal): void {
    const data = signal.data as
      | { text?: string; recipientId?: string; sideEffectsApplied?: boolean }
      | undefined;

    // Idempotency guard: skip if already applied (signal was re-queued after deferral)
    if (data?.sideEffectsApplied) return;
    if (data) data.sideEffectsApplied = true;

    // Note: Ack clearing is now handled by ThresholdEngine when it sees user_message

    // User responded - this is positive feedback (recharges energy, reduces social debt)
    this.agent.onPositiveFeedback();

    // Update user model
    if (this.userModel) {
      this.userModel.processSignal('message_received');
      this.processResponseTiming(signal);
    }

    // Save to conversation history (text only — base64 images are NOT persisted)
    if (this.conversationManager) {
      const data = signal.data as
        | { text?: string; recipientId?: string; images?: unknown[] }
        | undefined;
      if (data?.text && data.recipientId) {
        const photoPrefix = data.images?.length
          ? `[Photo${data.images.length > 1 ? ` x${String(data.images.length)}` : ''} attached] `
          : '';
        void this.conversationManager.addMessage(data.recipientId, {
          role: 'user',
          content: photoPrefix + data.text,
        });
      }
    }
  }

  /**
   * Process response timing for learning.
   */
  private processResponseTiming(signal: Signal): void {
    const lastMessageSentAt = this.intentApplicator.lastMessageSentAt;
    if (!this.userModel || !lastMessageSentAt) {
      return;
    }

    const data = signal.data as { recipientId?: string } | undefined;
    if (!data?.recipientId || data.recipientId !== this.intentApplicator.lastMessageRecipientId) {
      return;
    }

    const responseTimeMs = Date.now() - lastMessageSentAt;
    const responseTimeSec = responseTimeMs / 1000;

    if (responseTimeSec < 30) {
      this.userModel.processSignal('quick_response', { responseTimeMs });
      this.logger.debug({ responseTimeSec: responseTimeSec.toFixed(1) }, 'Quick response detected');
    } else if (responseTimeSec > 300) {
      this.userModel.processSignal('slow_response', { responseTimeMs });
      this.logger.debug({ responseTimeSec: responseTimeSec.toFixed(1) }, 'Slow response detected');
    }

    // Reset tracking
    this.intentApplicator.resetResponseTracking();

    this.metrics.histogram('user_response_time_ms', responseTimeMs);
  }

  // Note: Thought/desire pressure, commitment/prediction scanning, and dedup pruning
  // are now handled by DomainTrackerService (domain-trackers.ts).

  /**
   * Process through AUTONOMIC layer.
   */
  private processAutonomic(
    incomingSignals: Signal[],
    tickId: string
  ): AutonomicResult | Promise<AutonomicResult> {
    const state = this.agent.getState();
    return this.layers.autonomic.process(state, incomingSignals, tickId);
  }

  /**
   * Process through AGGREGATION layer.
   */
  private processAggregation(signals: Signal[]): AggregationResult | Promise<AggregationResult> {
    const state = this.agent.getState();
    return this.layers.aggregation.process(signals, state);
  }

  /**
   * Build context for COGNITION layer.
   */
  private buildCognitionContext(
    aggregationResult: AggregationResult,
    tickId: string,
    enableSmartRetry = true
  ): CognitionContext {
    // Get recipientId from trigger signal for mid-loop message injection
    const triggerSignal = aggregationResult.triggerSignals[0];
    const signalData = triggerSignal?.data as { recipientId?: string } | undefined;
    const recipientId = signalData?.recipientId;

    return {
      aggregates: aggregationResult.aggregates,
      triggerSignals: aggregationResult.triggerSignals,
      wakeReason: aggregationResult.wakeReason ?? 'unknown',
      agentState: this.agent.getState(),
      tickId,
      runtimeConfig: {
        enableSmartRetry,
      },
      drainPendingUserMessages: recipientId
        ? this.createPendingMessagesDrainer(recipientId)
        : undefined,
    };
  }

  /**
   * Create a callback to drain pending user messages for mid-loop injection.
   * Returns only user_message signals for the same recipientId, preserving FIFO order.
   */
  private createPendingMessagesDrainer(recipientId: string): () => Signal[] {
    return () => {
      const drained: Signal[] = [];

      // Iterate backwards to safely splice while iterating
      for (let i = this.pendingSignals.length - 1; i >= 0; i--) {
        const entry = this.pendingSignals[i];
        if (!entry) continue; // Guard against undefined entries

        const signal = entry.signal;
        if (signal.type !== 'user_message') continue;

        // Filter by recipient (same conversation only)
        const signalData = signal.data as { recipientId?: string } | undefined;
        const signalRecipient = signalData?.recipientId;
        if (signalRecipient !== recipientId) continue;

        this.pendingSignals.splice(i, 1);
        drained.unshift(signal); // Preserve FIFO order
      }

      // The turn absorbed these from the queue: on an overrun they belong to
      // its redo, not to a silent loss. The owner is the ACTIVE turn bookkeeping
      // (finding 9): it survives the stop drain clearing pendingCognition.
      this.activeTurnCommits?.turn.absorbedSignals.push(...drained);
      if (!this.activeTurnCommits && this.pendingCognition) {
        this.pendingCognition.absorbedSignals.push(...drained);
      }

      return drained;
    };
  }

  /**
   * Start COGNITION processing asynchronously (non-blocking).
   */
  private startCognitionAsync(
    context: CognitionContext,
    triggerSignals: Signal[],
    triggerSignal: Signal | undefined,
    traceContext: TraceContext
  ): void {
    const startedAt = Date.now();

    const promise = this.layers.cognition.process(context);

    this.pendingCognition = {
      promise,
      tickId: context.tickId,
      startedAt,
      triggerSignals,
      primaryTrigger: triggerSignal ?? context.triggerSignals[0] ?? undefined,
      absorbedSignals: [],
      traceContext,
    };
    this.registerTurnCommit(context.tickId, this.pendingCognition);

    promise
      .then(() => {
        withTraceContext(traceContext, () => {
          this.logger.debug(
            {
              tickId: context.tickId,
              duration: Date.now() - startedAt,
            },
            'COGNITION completed (async)'
          );
        });
      })
      .catch((error: unknown) => {
        withTraceContext(traceContext, () => {
          this.logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
              tickId: context.tickId,
            },
            'COGNITION failed (async)'
          );
        });
        if (this.pendingCognition?.tickId === context.tickId) {
          this.pendingCognition = null;
        }
        // A rejected turn's entries stay uncommitted: the durable log
        // replays them once at the next start (review finding G).
        this.evictTurnCommit(context.tickId);
      });
  }

  /**
   * Check if pending COGNITION completed and return result.
   * Returns null if still processing.
   */
  private async checkPendingCognition(): Promise<CognitionResult | null> {
    if (!this.pendingCognition) return null;

    const pending = this.pendingCognition;
    const timeoutPromise = new Promise<'pending'>((resolve) => {
      setImmediate(() => {
        resolve('pending');
      });
    });

    try {
      const result = await Promise.race([pending.promise, timeoutPromise]);

      if (result === 'pending') {
        const elapsed = Date.now() - pending.startedAt;
        if (elapsed > 5000 && elapsed % 5000 < 1000) {
          withTraceContext(pending.traceContext, () => {
            this.logger.debug({ tickId: pending.tickId, elapsed }, 'COGNITION still processing...');

            // Resend typing indicator (Telegram typing expires after ~5 seconds)
            const recipientId = (
              pending.primaryTrigger?.data as Record<string, unknown> | undefined
            )?.['recipientId'] as string | undefined;
            if (recipientId) {
              const route = this.recipientRegistry?.resolve(recipientId);
              if (route) {
                const channel = this.channels.get(route.channel);
                if (channel?.sendTyping) {
                  void channel.sendTyping(route.destination).catch(() => {
                    /* ignore typing errors */
                  });
                }
              }
            }
          });
        }
        return null;
      }

      this.resolveTurnCommit(pending.tickId, result.disposition);
      this.pendingCognition = null;
      return result;
    } catch (error) {
      this.evictTurnCommit(pending.tickId);
      this.pendingCognition = null;
      withTraceContext(pending.traceContext, () => {
        this.logger.error({ error, tickId: pending.tickId }, 'COGNITION rejected unexpectedly');
      });
      return null;
    }
  }

  /**
   * Apply a single intent immediately.
   * Used as callback for AgenticLoop to apply REMEMBER and SET_INTEREST intents
   * during loop execution so subsequent tools can see the data.
   */
  applyImmediateIntent(intent: Intent): void {
    // The stop drain is over and the turn was abandoned: its further writes
    // and sends must not happen behind the released channels and the journal.
    if (this.lateEffectsFenced) {
      this.logger.warn(
        { intentType: intent.type },
        'Late intent from the abandoned COGNITION turn dropped (stop drain overran)'
      );
      return;
    }
    // Only apply data-writing intents immediately so subsequent tools see them
    // SEND_MESSAGE is used for intermediate acknowledgments during tool processing
    // Other intents should wait for normal intent processing
    if (
      intent.type !== 'REMEMBER' &&
      intent.type !== 'SET_INTEREST' &&
      intent.type !== 'COMMITMENT' &&
      intent.type !== 'DESIRE' &&
      intent.type !== 'PERSPECTIVE' &&
      intent.type !== 'SEND_MESSAGE'
    ) {
      this.logger.warn(
        { intentType: intent.type },
        'applyImmediateIntent called with non-immediate intent type, ignoring'
      );
      return;
    }

    // Create trace context from intent's trace info
    const trace = intent.trace;
    let intentCtx: TraceContext;
    if (trace?.parentSignalId ?? trace?.tickId) {
      const traceId = trace.parentSignalId ?? trace.tickId ?? `intent_${String(Date.now())}`;
      const options: { correlationId?: string; parentId?: string } = {};
      if (trace.tickId !== undefined) {
        options.correlationId = trace.tickId;
      }
      if (trace.parentSignalId !== undefined) {
        options.parentId = trace.parentSignalId;
      }
      intentCtx = createTraceContext(traceId, options);
    } else {
      intentCtx = createTraceContext(`intent_${String(Date.now())}`);
    }

    this.intentApplicator.apply([intent], intentCtx);
  }

  /**
   * Apply intents from all layers.
   * Delegates to IntentApplicator for the actual processing.
   */
  private applyIntents(intents: Intent[], tickCtx: TraceContext): void {
    this.intentApplicator.apply(intents, tickCtx);
  }

  /**
   * Enqueue a thought signal with budget check.
   * Deduplication is handled by AGGREGATION layer (brain stem).
   * Returns true if the thought was queued, false if rejected.
   */
  private enqueueThoughtSignal(thoughtData: ThoughtData, signalSource: SignalSource): boolean {
    // Budget check - max thoughts per tick (prevents runaway thought loops)
    if (this.thoughtsThisTick >= THOUGHT_LIMITS.MAX_PER_TICK) {
      this.logger.warn(
        { content: thoughtData.content.slice(0, 30) },
        'Thought rejected: per-tick budget exceeded'
      );
      return false;
    }

    // Create and queue thought signal
    // Deduplication happens in AGGREGATION layer's mergeThoughtSignals()
    const signal = createSignal(
      'thought',
      signalSource,
      { value: 1 },
      {
        priority: 2, // Normal priority
        data: thoughtData,
      }
    );

    this.pushSignal(signal);
    this.thoughtsThisTick++;

    this.logger.debug(
      {
        content: thoughtData.content.slice(0, 30),
        depth: thoughtData.depth,
        triggerSource: thoughtData.triggerSource,
      },
      'Thought queued'
    );
    this.metrics.counter('thoughts_emitted', { triggerSource: thoughtData.triggerSource });

    return true;
  }

  /**
   * Handle typing event.
   */
  private async handleTypingEvent(event: Event): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    const recipientId = payload?.['chatId'] as string | undefined;
    const channelName = event.channel;

    if (!recipientId || !channelName) return;

    // Resolve recipientId to get the actual channel-specific destination (e.g., Telegram chatId)
    const route = this.recipientRegistry?.resolve(recipientId);
    if (!route) return;

    const channel = this.channels.get(channelName);
    if (channel?.sendTyping) {
      await channel.sendTyping(route.destination);
    }
  }

  /**
   * Convert stress level to numeric value for metrics.
   */
  private stressLevelToNumber(level: string): number {
    switch (level) {
      case 'normal':
        return 0;
      case 'elevated':
        return 1;
      case 'high':
        return 2;
      case 'critical':
        return 3;
      default:
        return 0;
    }
  }

  /**
   * Set the scheduler service for plugin timers.
   */
  setSchedulerService(service: SchedulerService): void {
    this.schedulerService = service;
    this.logger.debug('Scheduler service configured');
  }

  /**
   * Check if conversation status should decay due to inactivity.
   *
   * Decay rules (based on CONVERSATION_TIMEOUTS):
   * - awaiting_answer → idle after 10 minutes
   * - active → idle after 30 minutes
   * - closed → idle after 4 hours
   * - idle → stays idle (already decayed)
   */
  private async checkConversationDecay(): Promise<void> {
    if (!this.conversationManager || !this.primaryRecipientId) return;

    try {
      const { status, lastMessageAt } = await this.conversationManager.getStatus(
        this.primaryRecipientId
      );

      // Can't decay if no messages or already idle
      if (!lastMessageAt || status === 'idle') {
        return;
      }

      const timeSinceMessage = Date.now() - lastMessageAt.getTime();
      const timeout = CONVERSATION_TIMEOUTS[status];

      if (timeSinceMessage >= timeout) {
        // Decay to idle
        await this.conversationManager.setStatus(this.primaryRecipientId, 'idle');

        this.logger.info(
          {
            previousStatus: status,
            newStatus: 'idle',
            timeSinceMessageMin: Math.round(timeSinceMessage / 60000),
            timeoutMin: Math.round(timeout / 60000),
          },
          'Conversation status decayed due to inactivity'
        );

        this.metrics.counter('conversation_decay', { from: status });
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to check conversation decay'
      );
    }
  }
}

/**
 * Factory function.
 */
export function createCoreLoop(
  agent: Agent,
  eventBus: EventBus,
  layers: CoreLoopLayers,
  logger: Logger,
  metrics: Metrics,
  config?: Partial<CoreLoopConfig>,
  deps?: CoreLoopDeps
): CoreLoop {
  return new CoreLoop(agent, eventBus, layers, logger, metrics, config, deps);
}
