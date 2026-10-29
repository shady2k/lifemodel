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

import { createHash, randomUUID } from 'node:crypto';
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
import { DurableEffectRegistry } from './durable-effect-registry.js';
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
import { getPrimaryRecipientId, setPrimaryRecipientId } from './globals.js';
import { StatusUpdateService } from './status-update-service.js';
import { DomainTrackerService } from './domain-trackers.js';
import { IntentApplicator, type SendOutcome } from './intent-applicator.js';
import { TaskRegistryError, type TaskAcceptanceService, type TaskRecord } from '../ports/tasks.js';
import { TaskChannelError, type TaskQuestion } from '../ports/task-channel.js';
import type { StartTaskIntent } from '../types/intent.js';
import type { Storage } from '../storage/storage.js';
import type { PluginLoader } from './plugin-loader.js';
import type { PluginStatus } from '../layers/cognition/tools/core/manage.js';
import type { InboundMessageStream } from './message-streams.js';
import type { SnapshotOutboxEvent } from '../storage/snapshot-store.js';
import { StaleSnapshotEpochError } from '../storage/snapshot-store.js';
import type { CreatureState } from '../ports/creature-state.js';
import { CREATURE_STATE_HEARTBEAT_MS } from '../storage/creature-state-store.js';
import { StalePostgresEpochError } from '../storage/fenced-postgres.js';
import type { BusSignalStream } from './bus-stream.js';

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
   * appended here at emit time and flushed at once; an entry is removed once
   * its turn reached a recorded outcome (owner decision, comment 54).
   * Optional - without it inbound user messages behave as before (no
   * durability).
   */
  inboundStream?: InboundMessageStream | undefined;
  /** Durable internal signal stream; omitted only by isolated logic tests. */
  busSignalStream?: BusSignalStream | undefined;
  /** Commit the complete state envelope after every completed tick. */
  commitSnapshot?: ((tick: number, outbox: SnapshotOutboxEvent[]) => Promise<void>) | undefined;
  /** Apply projections after the atomic snapshot/outbox commit succeeds. */
  afterSnapshotCommit?: (() => Promise<void>) | undefined;
  initialTickCount?: number | undefined;
  creatureStateEpoch?: number | undefined;
  publishCreatureState?: ((state: CreatureState, epoch: number) => Promise<void>) | undefined;
  onStaleSnapshot?:
    | ((error: StaleSnapshotEpochError | StalePostgresEpochError) => void)
    | undefined;
  /** Called after a drained input fails normalization and must replay on restart. */
  onFatalError?: ((error: Error) => void) | undefined;
}

/**
 * Pending signal from a channel.
 */
interface PendingSignal {
  signal: Signal;
  timestamp: Date;
  streamId?: string;
}

class SignalNormalizationError extends Error {
  constructor(
    readonly step: string,
    readonly signalId: string,
    readonly inputIds: string[],
    cause: unknown
  ) {
    super(`Signal normalization failed at ${step} for ${signalId}`, { cause });
    this.name = 'SignalNormalizationError';
  }
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
   * user messages into one turn). They are part of the set of owned signals
   * whose inbound log entries the turn's answer commits.
   */
  triggerSignals: Signal[];
  /** Recipient this turn answers, captured before any effects. */
  recipientId: string | undefined;
  /** The wake's first trigger (trace/typing/routing) */
  primaryTrigger: Signal | undefined;
  /**
   * User messages this turn absorbed mid-loop through
   * drainPendingUserMessages() - owned by it exactly like its triggers.
   */
  absorbedSignals: Signal[];
  /** Trace context captured when cognition started */
  traceContext: TraceContext;
}

/**
 * The outcome a cognition turn recorded for its durable inbound log entries
 * (owner decision, comment 54). The entry LEAVES the log on any of them, and
 * a failed outcome is never retried; only a turn with NO recorded outcome -
 * a crash mid-turn, a rejected turn, a turn overrunning the stop deadline -
 * leaves its entries for a single replay at the next start.
 */
type TurnLogOutcome = 'answered' | 'deliberate_no_reply' | 'failed_turn';

/**
 * Commit bookkeeping for one cognition turn (the durable inbound log).
 */
interface PendingTurnCommits {
  /** The turn's tick id; the key of the turnCommits map. */
  tickId: string;
  /** The turn this bookkeeping belongs to (it owns the inbound log entries). */
  turn: PendingCognition;
  /** True once the turn settled with a result (its sends still settle after). */
  resolved: boolean;
  /**
   * Sends of the turn that started and have not settled. ALL of them count,
   * the in-loop acknowledgements (core.say) included (review round 4,
   * finding 3): the outcome cannot be decided while any of them is still to
   * come.
   */
  sendsOutstanding: number;
  /** The whole result is being applied; keep ownership until that batch ends. */
  applyingResult: boolean;
  /** SEND_MESSAGE intents in the normalized result batch still to start. */
  finalSendsExpected: number;
  finalSendsStarted: number;
  /**
   * A FINAL send (one that started after the turn resolved) reached the chat.
   * An acknowledgement never sets this: it says nothing about the answer
   * (review round 4, findings 1 and 3).
   */
  finalDelivered: boolean;
  /**
   * A send of the turn reached the chat, acknowledgements included - what
   * makes a turn whose only message WAS the acknowledgement answered.
   */
  anyDelivered: boolean;
  /**
   * How the turn ended (see {@link TurnDisposition}): `error` is a failed
   * turn, `no_reply`/`defer` a deliberate silence. Undefined means the turn
   * never said how it ended.
   */
  disposition?: TurnDisposition | undefined;
  /** Its entries were settled (guards a second commit from a later send). */
  settled: boolean;
  outboundCount: number;
  /** Sends emitted while cognition runs stay tentative until its outcome succeeds. */
  tentativeEvents: SnapshotOutboxEvent[];
  finalErrorAttempt: boolean;
}

/**
 * What the stop still has in flight (see {@link CoreLoop.stopReport}): the one
 * object the hard exit logs at the stop deadline, so the error line names what
 * hung (a stalled tick, a turn that never returned, a hung send) and not only
 * that something did.
 */
export interface StopReport {
  /** The loop's tick timer is off: no further signal processing starts. */
  loopStopped: boolean;
  /** A tick body is still running. */
  tickInFlight: boolean;
  /** The scheduler callback is still running. */
  schedulerInFlight: boolean;
  /** A COGNITION turn is still awaited (the drain waits for it). */
  turnInFlight: boolean;
  /** SEND_MESSAGE chains that have not settled. */
  sendsOutstanding: number;
  /** Signals accepted but never processed (dropped at the stop). */
  queuedSignals: number;
}

/**
 * CoreLoop - orchestrates the 4-layer pipeline.
 */
function compareStreamIds(left: string, right: string): number {
  const leftParts = left.split('-');
  const rightParts = right.split('-');
  if (leftParts.length !== 2 || rightParts.length !== 2) {
    throw new Error('Invalid Valkey stream ID');
  }
  const leftMillis = BigInt(leftParts[0] ?? '');
  const leftSequence = BigInt(leftParts[1] ?? '');
  const rightMillis = BigInt(rightParts[0] ?? '');
  const rightSequence = BigInt(rightParts[1] ?? '');
  return leftMillis < rightMillis
    ? -1
    : leftMillis > rightMillis
      ? 1
      : leftSequence < rightSequence
        ? -1
        : leftSequence > rightSequence
          ? 1
          : 0;
}

export class CoreLoop {
  private readonly agent: Agent;
  private readonly eventBus: EventBus;
  private readonly layers: CoreLoopLayers;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly config: CoreLoopConfig;

  private running = false;
  private tickCount = 0;
  private readonly creatureStateEpoch: number | undefined;
  private readonly publishCreatureState: CoreLoopDeps['publishCreatureState'];
  private creatureStateHeartbeat: ReturnType<typeof setInterval> | null = null;
  private publishedCreatureState: CreatureState | null = null;
  private lastCommitAt = 0;
  private tickTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Promise for the in-flight tick (so stop() can wait for it to settle) */
  private tickPromise: Promise<void> | null = null;
  /**
   * Tick bodies running right now (normally 0 or 1). The stop report reads
   * it: a tick the deadline cut loose is exactly the "stalled tick" the hard
   * exit names (src/core/hard-exit.ts).
   */
  private tickInFlight = 0;
  /**
   * The tick id of the COGNITION turn the stop drain is waiting for (null
   * outside a drain). The turn is CLAIMED (pendingCognition cleared) before
   * it is awaited, so the stop report needs this to keep naming it; a turn the
   * deadline ABANDONED keeps its name there until the process leaves.
   */
  private drainingTurnTickId: string | null = null;
  private finalDrainNeedsCommit = false;
  /**
   * Set once the stop drain is over: the turn in flight (if it overran) may
   * not apply further intents through its later immediate callbacks.
   */
  private lateEffectsFenced = false;
  /**
   * Set by the container right before the stop's FINAL storage flush: no write
   * may land after it (a write into a storage that already shut down is lost
   * silently). A send that settles from here on keeps its message in the
   * durable log instead of committing behind the flush - the entry is on disk
   * anyway, so it replays once at the next start.
   */
  private durableWritesClosed = false;
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
  private pendingCognitionStart: (() => void) | null = null;

  /**
   * Commit bookkeeping for snapshot-owned inbound entries, keyed by the turn's
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

  /** Snapshot-owned inbound stream offsets and pending entries. */
  private readonly inboundStream: InboundMessageStream | undefined;
  private tickOutbox: SnapshotOutboxEvent[] = [];
  private readonly sendTurnByEvent = new Map<string, string>();
  private readonly commitSnapshot:
    | ((tick: number, outbox: SnapshotOutboxEvent[]) => Promise<void>)
    | undefined;
  private snapshotCommitStarted = false;
  private readonly afterSnapshotCommit: (() => Promise<void>) | undefined;
  private readonly busSignalStream: BusSignalStream | undefined;
  private readonly pendingBusWrites: Promise<void>[] = [];
  private readonly knownBusEntries = new Set<string>();
  private readonly signalStreamIds = new Map<string, string>();
  private tickConsumedBusEntries: string[] = [];
  /** Highest bus entry not yet covered by a committed turn outcome. */
  private readonly onStaleSnapshot:
    | ((error: StaleSnapshotEpochError | StalePostgresEpochError) => void)
    | undefined;
  private readonly onFatalError: ((error: Error) => void) | undefined;

  /**
   * Set by haltForTest(): this object emulates a process that was killed. A
   * killed instance applies and settles NOTHING more, so work already in
   * flight cannot write into the data or log directories behind a restart
   * under test.
   */
  private deadForTest = false;

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
  private readonly durableEffects = new DurableEffectRegistry();

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
    this.inboundStream = deps.inboundStream;
    this.commitSnapshot = deps.commitSnapshot;
    this.afterSnapshotCommit = deps.afterSnapshotCommit;
    this.busSignalStream = deps.busSignalStream;
    if (this.busSignalStream && !deps.commitSnapshot) {
      throw new Error('A bus signal stream requires a snapshot commit callback');
    }
    this.onStaleSnapshot = deps.onStaleSnapshot;
    this.onFatalError = deps.onFatalError;
    this.tickCount = deps.initialTickCount ?? 0;
    this.creatureStateEpoch = deps.creatureStateEpoch;
    this.publishCreatureState = deps.publishCreatureState;
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
      if (this.recipientRegistry) {
        this.primaryRecipientId =
          this.recipientRegistry.lookup('web', 'owner') ??
          this.recipientRegistry.getOrCreate('web', 'owner');
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
      durableEffects: this.durableEffects,
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
      enqueueOutbound: (event) => {
        const turnKey = this.sendTurnByEvent.get(event.eventId);
        this.sendTurnByEvent.delete(event.eventId);
        const turn = turnKey ? this.turnCommits.get(turnKey) : undefined;
        if (turn) {
          if (turn.disposition === 'error' && !turn.finalErrorAttempt) return;
          turn.tentativeEvents.push(event);
          if (turn.resolved) this.tickOutbox.push(...turn.tentativeEvents.splice(0));
          return;
        }
        this.tickOutbox.push(event);
      },
      storage: deps.storage,
      pluginLoader: deps.pluginLoader,
      resolveSendTurn: (intent) => {
        // A cognition turn's answer carries the turn's tick id in its trace;
        // an in-loop immediate send (no trace, e.g. core.say) belongs to the
        // turn running. `final` says which of the two this send is (review
        // round 4): a send that starts while the turn is still running is an
        // acknowledgment, one that starts after it resolved is an answer.
        const tickId = intent.trace?.tickId;
        const turnKey =
          tickId && this.turnCommits.has(tickId)
            ? tickId
            : (this.activeTurnCommits?.tickId ?? this.pendingCognition?.tickId);
        if (turnKey === undefined) return undefined;
        const state = this.turnCommits.get(turnKey);
        const inboundIds = state
          ? this.ownedInboundIds(state.turn, intent.payload.recipientId)
          : [];
        const triggerIds = state
          ? [...state.turn.triggerSignals, ...state.turn.absorbedSignals]
              .filter((signal) => {
                const data = signal.data as { recipientId?: unknown } | undefined;
                return (
                  data?.recipientId === undefined || data.recipientId === intent.payload.recipientId
                );
              })
              .map((signal) =>
                signal.type === 'user_message'
                  ? (this.inboundStream?.messageIdForSignal(signal) ?? signal.id)
                  : signal.id
              )
              .sort()
          : [];
        // The first owned trigger is the immutable identity. Absorbing later
        // triggers on replay must not alter effect keys for the same turn.
        const turnIdentity = state?.turn.tickId ?? triggerIds[0] ?? turnKey ?? randomUUID();
        const ordinal = state ? state.outboundCount++ : 0;
        const effectKind = state?.disposition === 'error' ? 'error-notice' : 'answer';
        const eventHash = createHash('sha256')
          .update(
            effectKind === 'error-notice'
              ? `error-notice|${intent.payload.recipientId}|${turnIdentity}|${String(ordinal)}`
              : `${intent.payload.recipientId}|${turnIdentity}|${String(ordinal)}`
          )
          .digest('hex');
        const eventId = `${effectKind === 'error-notice' ? 'error-notice' : 'send'}:${eventHash}`;
        const stableTurnKey = turnKey;
        if (stableTurnKey !== undefined) this.sendTurnByEvent.set(eventId, stableTurnKey);
        const inboundChannel = state?.turn.triggerSignals
          .concat(state.turn.absorbedSignals)
          .find((signal) => {
            const data = signal.data as { recipientId?: unknown } | undefined;
            return (
              signal.type === 'user_message' && data?.recipientId === intent.payload.recipientId
            );
          })?.data as { channel?: unknown } | undefined;
        return {
          turnKey,
          final: state?.resolved ?? false,
          answersInbound: inboundIds.length > 0,
          ...(typeof inboundChannel?.channel === 'string'
            ? { channel: inboundChannel.channel }
            : {}),
          eventId,
        };
      },
      onSendStarted: (turnKey, recipientId, final) => {
        this.onTurnSendStarted(turnKey, recipientId, final);
      },
      onSendSettled: (turnKey, recipientId, final, outcome) => {
        this.onTurnSendSettled(turnKey, recipientId, final, outcome);
      },
    });
  }

  /** Admit a user message into the durable Valkey inbound stream. */
  async pushInboundSignal(signal: Signal): Promise<void> {
    if (signal.type !== 'user_message' || !this.inboundStream) {
      this.pushSignal(signal);
      return;
    }
    await this.inboundStream.append(signal);
  }

  /** Signal ids owned by this turn for the recipient it answers. */
  private ownedInboundIds(turn: PendingCognition, recipientId: string): string[] {
    if (!this.inboundStream) return [];
    return [...turn.triggerSignals, ...turn.absorbedSignals]
      .filter((signal) => {
        const data = signal.data as { recipientId?: unknown } | undefined;
        return signal.type === 'user_message' && data?.recipientId === recipientId;
      })
      .map((signal) => signal.id);
  }

  /**
   * The ONE recipient this turn answers: real cognition routes everything
   * through triggerSignals[0] (review round 2, finding 2). Bundled messages
   * of OTHER recipients are not owned by this turn - at wake they go back to
   * the queue for their own turn; they can never be committed by it.
   */
  private answeredRecipientOf(state: PendingTurnCommits): string | undefined {
    return state.turn.recipientId;
  }

  /**
   * The outcome a resolved turn recorded for its entries, or undefined while
   * it has none (owner decision, comment 54). The four outcomes are mutually
   * exclusive; the FINAL send decides between the first and the third, an
   * acknowledgement never does.
   */
  private turnOutcome(state: PendingTurnCommits): TurnLogOutcome | undefined {
    if (state.disposition === 'error') return 'failed_turn';
    if (state.finalSendsStarted > 0) {
      return state.finalDelivered ? 'answered' : undefined;
    }
    // The turn ends with no final send: only an acknowledgement went out (an
    // empty final response after core.say is a valid answer).
    if (state.anyDelivered) return 'answered';
    if (state.disposition === 'no_reply' || state.disposition === 'defer') {
      return 'deliberate_no_reply';
    }
    // Quiet proactive turns (including tools-only work) have already done
    // their work. Replaying them repeats effects and model cost. Only a
    // final answer that started but was not counted delivered is undecided.
    if (
      ![...state.turn.triggerSignals, ...state.turn.absorbedSignals].some(
        (signal) => signal.type === 'user_message'
      )
    )
      return 'deliberate_no_reply';
    return undefined;
  }

  /**
   * A send of the turn started (see IntentApplicatorDeps.onSendStarted).
   * Registered synchronously, so the outcome is never decided while a send is
   * still to come; a send that starts after the turn resolved is one of its
   * FINAL answers (review round 4, findings 1 and 3).
   */
  private onTurnSendStarted(turnKey: string, recipientId: string, final: boolean): void {
    const state = this.turnCommits.get(turnKey);
    if (!state) return;
    if (recipientId !== this.answeredRecipientOf(state)) return;
    state.sendsOutstanding += 1;
    if (final) {
      state.finalSendsStarted += 1;
    }
  }

  /**
   * A send of the turn settled (see IntentApplicatorDeps.onSendSettled). The
   * turn's entries leave the log once the turn has a recorded outcome; a
   * failed send is part of that outcome and is never retried. The returned
   * promise is chained into the send chain, so the stop drain awaits the
   * commit's flush too.
   */
  private onTurnSendSettled(
    turnKey: string,
    recipientId: string,
    final: boolean,
    outcome: SendOutcome
  ): void {
    const state = this.turnCommits.get(turnKey);
    if (!state) {
      // The turn is gone (evicted, or already settled): a later send of it
      // settles nothing.
      return;
    }
    if (recipientId !== this.answeredRecipientOf(state)) {
      // Only the recipient a turn answers owns entries (finding 2); a send to
      // anybody else was never served by this turn's messages.
      return;
    }
    state.sendsOutstanding = Math.max(0, state.sendsOutstanding - 1);
    if (outcome.delivered) {
      state.anyDelivered = true;
      if (final) {
        state.finalDelivered = true;
      }
    }
    this.settleTurn(state);
  }

  /**
   * Settle a turn that reached an outcome: its entries are REMOVED from the
   * durable log, so it is never replayed. A failed outcome - a failed turn
   * (error disposition) or a send that did not reach the chat - is never
   * retried for inbound work, which follows its own durable policy. Internal
   * bus entries retry once in this core and then complete with a warning. A
   * resolved internal turn retries an undecided final answer, but a quiet
   * non-error turn completes without replay. Inbound work keeps its own policy.
   */
  private settleTurn(state: PendingTurnCommits): void {
    if (state.settled || this.deadForTest) return;
    if (this.durableWritesClosed) {
      // The stop ran its final flush: a write made now reaches a storage that
      // already shut down and would be lost. The entry is on disk, so it
      // replays once at the next start (lifemodel-ctc.1.2).
      state.settled = true;
      const owner = this.answeredRecipientOf(state);
      const owned = owner === undefined ? [] : this.ownedInboundIds(state.turn, owner);
      this.dropTurnCommit(state);
      if (owned.length > 0) {
        this.logger.warn(
          {
            recipientId: owner,
            entries: owned.length,
            outcome: this.turnOutcome(state) ?? 'none',
          },
          'The stop passed its final flush: nothing is written after it, so the message stays in the log and replays once at the next start'
        );
      }
      return;
    }
    // Nothing is decided on a guess: the outcome exists only once the turn has
    // resolved, EVERY send of it (acknowledgements included) has settled, and
    // the sends its own result produces have really started (review round 4:
    // the window between the resolution and the application of its intents).
    if (!state.resolved || state.applyingResult || state.sendsOutstanding > 0) return;
    if (state.finalSendsStarted < state.finalSendsExpected) return;
    state.settled = true;
    const recipientId = this.answeredRecipientOf(state);
    const inboundIds =
      recipientId === undefined ? [] : this.ownedInboundIds(state.turn, recipientId);
    const outcome = this.turnOutcome(state);
    const ownedBusIds = [...state.turn.triggerSignals, ...state.turn.absorbedSignals]
      .map((signal) => this.signalStreamIds.get(signal.id))
      .filter((id): id is string => id !== undefined);
    this.dropTurnCommit(state);
    if (outcome === undefined || outcome === 'failed_turn') {
      this.busSignalStream?.markFailed(ownedBusIds);
      const retryBusIds: string[] = [];
      const exhaustedBusIds: string[] = [];
      for (const id of ownedBusIds) {
        const failed = this.busSignalStream?.stateFor(id);
        if (failed?.status !== 'failed') continue;
        if (failed.retries < 2) {
          this.busSignalStream?.markOwned([id], failed.turnId);
          retryBusIds.push(id);
        } else {
          exhaustedBusIds.push(id);
        }
      }
      for (const id of exhaustedBusIds) {
        const signal = [...state.turn.triggerSignals, ...state.turn.absorbedSignals].find(
          (signal) => this.signalStreamIds.get(signal.id) === id
        );
        this.logger.warn(
          { streamId: id, signalType: signal?.type, signalSource: signal?.source },
          'Internal signals failed twice and were completed with their recorded failure'
        );
      }
      this.busSignalStream?.markCompleted(exhaustedBusIds);
      const retrySignals = [...state.turn.triggerSignals, ...state.turn.absorbedSignals];
      for (const signal of retrySignals.reverse()) {
        const streamId = this.signalStreamIds.get(signal.id);
        if (!streamId || !retryBusIds.includes(streamId)) continue;
        this.knownBusEntries.add(streamId);
        this.pendingSignals.unshift({ signal, timestamp: signal.timestamp, streamId });
      }
      const exhaustedIds =
        outcome === 'failed_turn' ? (this.inboundStream?.markFailedTurn(inboundIds) ?? []) : [];
      if (state.finalErrorAttempt && exhaustedIds.length > 0)
        this.inboundStream?.settle(exhaustedIds);
      if (inboundIds.length > 0) {
        this.logger.warn(
          {
            recipientId,
            entries: inboundIds.length,
            outcome: outcome ?? 'none',
            disposition: state.disposition ?? null,
          },
          exhaustedIds.length > 0
            ? 'Inbound messages remain pending but will not be retried after repeated errors'
            : 'Inbound turn failed; its messages remain pending for bounded retry'
        );
      }
      return;
    }
    this.busSignalStream?.markCompleted(ownedBusIds);
    if (recipientId === undefined || inboundIds.length === 0) return;
    this.logger.info(
      { recipientId, entries: inboundIds.length, outcome },
      "Inbound messages settled by the turn's outcome"
    );
    this.inboundStream?.settle(inboundIds);
  }

  /** The turn is over: its bookkeeping goes (a settled/undecided turn waits on nothing). */
  private dropTurnCommit(state: PendingTurnCommits): void {
    this.turnCommits.delete(state.tickId);
    if (this.activeTurnCommits?.tickId === state.tickId) {
      this.activeTurnCommits = null;
    }
  }

  /** Turn-production-time hook: only the ANSWERED recipient is owned (finding 2). */
  private registerTurnCommit(tickId: string, turn: PendingCognition): void {
    const state: PendingTurnCommits = {
      tickId,
      turn,
      resolved: false,
      applyingResult: false,
      sendsOutstanding: 0,
      finalSendsExpected: 0,
      finalSendsStarted: 0,
      finalDelivered: false,
      anyDelivered: false,
      settled: false,
      outboundCount: 0,
      tentativeEvents: [],
      finalErrorAttempt: false,
    };
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

  private finalErrorNotice(state: PendingTurnCommits): Intent[] {
    if (!state.finalErrorAttempt) return [];
    const recipientId = this.answeredRecipientOf(state);
    if (!recipientId) return [];
    return [
      {
        type: 'SEND_MESSAGE',
        payload: { recipientId, text: 'I could not complete that request after two attempts.' },
        trace: {
          tickId: state.tickId,
          parentSignalId: state.turn.primaryTrigger?.id ?? state.turn.triggerSignals[0]?.id ?? '',
        },
      },
    ];
  }

  /**
   * Turn resolved with a result: its disposition is recorded and the FINAL
   * sends its own result will apply are counted, so the outcome is decided
   * once they - and every acknowledgement still in flight - have settled.
   */
  private resolveTurnCommit(
    tickId: string,
    disposition: TurnDisposition | undefined,
    intents: Intent[]
  ): Intent[] {
    const state = this.turnCommits.get(tickId);
    if (!state) return intents;
    state.resolved = true;
    state.applyingResult = true;
    const answered = this.answeredRecipientOf(state);
    const inboundIds = answered === undefined ? [] : this.ownedInboundIds(state.turn, answered);
    const hasAnswerIntent = intents.some(
      (intent) => intent.type === 'SEND_MESSAGE' && intent.payload.recipientId === answered
    );
    // A resolved inbound turn with no answer and no explicit silence is a
    // failed attempt, not durable progress that may replay forever.
    const effectiveDisposition =
      disposition !== 'error' &&
      disposition !== 'no_reply' &&
      disposition !== 'defer' &&
      inboundIds.length > 0 &&
      !hasAnswerIntent &&
      !state.anyDelivered
        ? 'error'
        : disposition;
    state.disposition = effectiveDisposition;
    state.finalErrorAttempt =
      effectiveDisposition === 'error' &&
      (this.inboundStream?.willExhaustRetries(inboundIds) ?? false);
    let appliedIntents = intents;
    if (effectiveDisposition === 'error') {
      state.tentativeEvents = [];
      // Result sends are tentative as a batch: none may escape through the
      // unowned outbox path after an earlier suppressed send settles.
      appliedIntents = intents.filter((intent) => intent.type !== 'SEND_MESSAGE');
      if (state.finalErrorAttempt) appliedIntents.push(...this.finalErrorNotice(state));
    } else {
      this.tickOutbox.push(...state.tentativeEvents.splice(0));
    }
    state.finalSendsExpected =
      answered === undefined
        ? 0
        : appliedIntents.filter(
            (intent) => intent.type === 'SEND_MESSAGE' && intent.payload.recipientId === answered
          ).length;
    // The turn's loop is finished: no more mid-loop absorption can land.
    if (this.activeTurnCommits?.tickId === tickId) {
      this.activeTurnCommits = null;
    }
    return appliedIntents;
  }

  private markResultApplicationsComplete(): void {
    for (const state of this.turnCommits.values()) {
      if (state.resolved) state.applyingResult = false;
    }
  }

  /**
   * Settle every turn whose outcome is recorded. Called after a resolved
   * turn's intents were applied (which starts its sends) and again from a
   * send that settled; awaited so the commit's flush lands before the stop
   * goes on.
   */
  private evaluateTurnCommits(): void {
    for (const state of [...this.turnCommits.values()]) {
      this.settleTurn(state);
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
    this.durableWritesClosed = false;
    this.drainingTurnTickId = null;

    // Start system health monitoring
    this.healthMonitor.start();

    // Subscribe to typing events
    this.typingSubscriptionId = this.eventBus.subscribe(
      (event) => void this.handleTypingEvent(event),
      { source: 'internal', type: 'typing_start' }
    );

    this.logger.info({ tickInterval: this.config.tickInterval }, 'Core loop started');

    // Publish before the first tick without making core progress depend on Valkey.
    void this.publishCurrentCreatureState(true);
    this.scheduleTick();
    if (this.publishCreatureState && this.creatureStateEpoch !== undefined) {
      this.creatureStateHeartbeat = setInterval(() => {
        if (this.running) void this.publishCurrentCreatureState(true);
      }, CREATURE_STATE_HEARTBEAT_MS);
      this.creatureStateHeartbeat.unref?.();
    }
  }

  /**
   * Stop the signal loop. One stop deadline bounds every wait (the in-flight
   * tick, the scheduler callback, the COGNITION turn, its sends); past it the
   * stop continues and the process exits hard at that deadline
   * (src/core/hard-exit.ts). Signals still queued are dropped: they are
   * internal signals remain before their committed bus offset; inbound user
   * messages remain in the durable inbound log.
   */
  async stop(deadlineMs?: number): Promise<void> {
    const deadline = deadlineMs ?? Date.now() + this.config.shutdownDrainTimeoutMs;
    if (!this.running) {
      this.clearCreatureStateHeartbeat();
      await this.durableEffects.drain(deadline, this.logger);
      return;
    }

    this.running = false;
    this.clearCreatureStateHeartbeat();

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
    // a turn that overruns is abandoned (its inbound log entries recorded no
    // outcome, so they replay once at the next start).
    const previousBusSnapshot = this.busSignalStream?.exportSnapshot();
    await this.drainPendingCognition(deadline);
    if (this.commitSnapshot && (this.finalDrainNeedsCommit || this.tickOutbox.length > 0)) {
      const batch = [...this.tickOutbox];
      const committingBusOffset = this.busSignalStream?.committedOffset();
      try {
        const result = await awaitWithinDeadline(
          this.commitSnapshot(this.tickCount, batch),
          deadline,
          this.logger,
          'final drained-turn snapshot commit'
        );
        if (result.done) {
          const committed = new Set(batch);
          for (let index = this.tickOutbox.length - 1; index >= 0; index--) {
            const event = this.tickOutbox[index];
            if (event && committed.has(event)) this.tickOutbox.splice(index, 1);
          }
          if (this.busSignalStream && committingBusOffset !== undefined) {
            await this.busSignalStream.trimBefore(committingBusOffset);
          }
        } else {
          if (previousBusSnapshot && this.busSignalStream)
            await this.busSignalStream.hydrateSnapshot(previousBusSnapshot);
          this.logger.warn(
            'Final drained-turn commit missed the stop deadline; owned triggers will replay'
          );
        }
      } catch (error) {
        if (previousBusSnapshot && this.busSignalStream)
          await this.busSignalStream.hydrateSnapshot(previousBusSnapshot);
        this.logger.error(
          { err: error },
          'Final drained-turn snapshot commit failed; owned triggers will replay'
        );
      }
    }

    await this.durableEffects.drain(deadline, this.logger);

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

  /** How many signals are queued (accepted, not yet processed). Observable for tests. */
  pendingSignalCount(): number {
    return this.pendingSignals.length;
  }

  /** TEST-ONLY: events waiting for the current tick's snapshot commit. */
  getOutboxForTest(): SnapshotOutboxEvent[] {
    return [...this.tickOutbox];
  }

  /**
   * TEST-ONLY: the signals queued right now, without taking them (a channel
   * test asks what the loop accepted, e.g. a completed photo replay).
   */
  queuedSignalsForTest(): Signal[] {
    return this.pendingSignals.map((entry) => entry.signal);
  }

  /**
   * The stop reached its final storage flush, called by the container right
   * before it (shutdownSequence step 5). From here on NOTHING writes into
   * storage: a send that settles keeps its message in the durable log for a
   * single replay at the next start (see {@link settleTurn}), so no commit can
   * land behind the flush - where it would be written into a cache that is
   * never flushed again, and lost.
   */
  closeDurableWrites(): void {
    this.durableWritesClosed = true;
  }

  /**
   * What the stop still has in flight, read by the hard exit at the stop
   * deadline so its error line NAMES what hung instead of only saying that
   * something did (src/index.ts, src/core/hard-exit.ts).
   */
  stopReport(): StopReport {
    return {
      loopStopped: !this.running,
      tickInFlight: this.tickInFlight > 0,
      schedulerInFlight: this.schedulerTickInFlight,
      turnInFlight: this.pendingCognition !== null || this.drainingTurnTickId !== null,
      sendsOutstanding: this.intentApplicator.pendingSendCount(),
      queuedSignals: this.pendingSignals.length,
    };
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
   * health monitor stop, the loop is no longer running, work already in
   * flight is fenced (late intents are dropped, nothing settles), and
   * NOTHING is drained, applied or committed - the instance is as dead as a
   * killed process. A crashed instance must not keep ticking or writing
   * behind the restart under test: one leaked 5ms timer per killed instance
   * made the photo restart test load-dependent (review round 2, item 10).
   */
  haltForTest(): void {
    this.running = false;
    this.clearCreatureStateHeartbeat();
    this.deadForTest = true;
    this.lateEffectsFenced = true;
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

  /**
   * TEST-ONLY: join the work a killed instance still had in flight (the tick
   * and the scheduler callback it had taken), so that after this resolves the
   * instance can write nothing more. Fences first (haltForTest), so the
   * joined work cannot apply intents or settle log entries on its way out.
   */
  async fenceForTest(deadlineMs = 1_000): Promise<void> {
    this.haltForTest();
    const deadline = Date.now() + deadlineMs;
    await awaitWithinDeadline(
      Promise.all([
        this.tickPromise,
        this.schedulerTickPromise ?? Promise.resolve(),
        this.stallForTest.tickGate ?? Promise.resolve(),
        this.stallForTest.schedulerGate ?? Promise.resolve(),
      ]).then(() => undefined),
      deadline,
      this.logger,
      'fenced test instance work'
    );
  }

  /**
   * Await the COGNITION turn in flight, bounded by the overall stop deadline.
   * - finished in time: its result intents are applied here (normally the
   *   next tick does that, but ticks no longer run); stop() then awaits its
   *   sends before the channels are released.
   * - overran: the turn is abandoned and its own result is dropped. Every
   *   signal it owned is dropped with it - an internal signal is regenerated
   *   by the next run's ticks, and an inbound user message carries no recorded
   *   outcome, so the durable inbound log replays it once at the next start.
   * - rejected: logged like the regular tick error path, with the error.
   */
  private async drainPendingCognition(deadline: number): Promise<void> {
    const pending = this.pendingCognition;
    if (!pending) {
      return;
    }
    // No tick will run again, so claim the turn now to prevent any start
    // racing from a tick that is finishing. The claim is remembered so the
    // stop report still names the turn while it is awaited (see stopReport).
    this.pendingCognition = null;
    this.drainingTurnTickId = pending.tickId;

    let abandoned = false;
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
        // No outcome is recorded for the turn: inbound entries stay unsettled,
        // and internal triggers remain before their committed bus offset.
        // The turn is ABANDONED, not finished: the stop report keeps naming it
        // until the process leaves (see stopReport), so the hard exit's error
        // line tells the truth about a turn that never returned.
        abandoned = true;
        this.evictTurnCommit(pending.tickId);
        withTraceContext(pending.traceContext, () => {
          this.logger.warn(
            {
              tickId: pending.tickId,
              abandonedSignals: pending.triggerSignals.length + pending.absorbedSignals.length,
              deadlineBudgetMs: this.config.shutdownDrainTimeoutMs,
            },
            'COGNITION turn in flight overran the stop deadline; it is abandoned (its inbound log entries replay once at the next start)'
          );
        });
        return;
      }

      withTraceContext(pending.traceContext, () => {
        this.logger.info(
          { tickId: pending.tickId, duration: Date.now() - pending.startedAt },
          'COGNITION turn in flight completed during the stop drain'
        );
      });
      const resultIntents = this.resolveTurnCommit(
        pending.tickId,
        outcome.result.disposition,
        outcome.result.intents
      );
      this.applyIntents(this.attributedToTurn(resultIntents, pending), pending.traceContext);
      this.markResultApplicationsComplete();
      // Commit what is decidable now; sends still in flight turn the rest
      // through their outcome callbacks (each flush is chained onto its
      // send chain, so stop()'s awaitPendingSends waits for it too).
      this.evaluateTurnCommits();
      this.finalDrainNeedsCommit = true;
    } catch (error: unknown) {
      withTraceContext(pending.traceContext, () => {
        this.logger.error(
          { err: error, tickId: pending.tickId },
          'COGNITION rejected unexpectedly during the stop drain'
        );
      });
      const errorIntents = this.resolveTurnCommit(pending.tickId, 'error', []);
      if (errorIntents.length > 0) this.applyIntents(errorIntents, pending.traceContext);
      this.markResultApplicationsComplete();
      this.evaluateTurnCommits();
      this.finalDrainNeedsCommit = true;
    } finally {
      // An abandoned turn keeps its name in the stop report: it is still
      // running, and the hard exit must be able to say so.
      if (!abandoned) {
        this.drainingTurnTickId = null;
      }
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

  getLastCommitAt(): number {
    return this.lastCommitAt;
  }

  /**
   * Get current system health.
   */
  getHealth(): SystemHealth & { taskQuestionLookupDegraded: boolean } {
    return {
      ...this.healthMonitor.getHealth(),
      taskQuestionLookupDegraded: [...this.taskQuestionRetries.values()].some(
        (retry) => retry.failures >= 3
      ),
    };
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
    if (signal.type === 'task_outcome' && signal.data?.kind === 'task_outcome') {
      signal = { ...signal, id: signal.data.outcomeKey };
    }
    const durableBusSignal =
      this.busSignalStream && !(signal.type === 'user_message' && this.inboundStream);
    if (!durableBusSignal) this.pendingSignals.push({ signal, timestamp: new Date() });
    if (durableBusSignal) {
      const write = this.busSignalStream.append(signal).then((id) => {
        this.signalStreamIds.set(signal.id, id);
      });
      this.pendingBusWrites.push(write);
    }
  }

  private clearCreatureStateHeartbeat(): void {
    if (this.creatureStateHeartbeat) clearInterval(this.creatureStateHeartbeat);
    this.creatureStateHeartbeat = null;
  }

  private async publishCurrentCreatureState(force = false): Promise<void> {
    if (!this.publishCreatureState || this.creatureStateEpoch === undefined) return;
    const state: CreatureState = this.pendingCognition
      ? 'thinking'
      : this.agent.getAlertnessMode() === 'sleeping'
        ? 'asleep'
        : 'awake';
    if (!force && state === this.publishedCreatureState) return;
    try {
      await this.publishCreatureState(state, this.creatureStateEpoch);
      this.publishedCreatureState = state;
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to publish creature state');
    }
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

    // The stop report reads this: a tick the deadline cuts loose is the
    // "stalled tick" the hard exit names.
    this.tickInFlight++;
    const tickStart = Date.now();
    this.tickCount++;
    this.thoughtsThisTick = 0; // Reset per-tick thought budget
    const tickId = randomUUID();
    const tickCtx = createTraceContext(tickId, { spanId: `tick_${String(this.tickCount)}` });
    const previousBusSnapshot = this.busSignalStream?.exportSnapshot();

    this.tickConsumedBusEntries = [];
    try {
      // Pull durable inbound entries after the snapshot offset. Pending entries
      // hydrated from an earlier snapshot are replayed by the same call.
      for (const entry of (await this.inboundStream?.readNew()) ?? []) {
        this.pendingSignals.push({ signal: entry.signal, timestamp: entry.signal.timestamp });
      }
      const exhaustedInbound = this.inboundStream?.exhaustedEntries() ?? [];
      for (const entry of exhaustedInbound) {
        const data = entry.signal.data as { channel?: unknown };
        const route = this.recipientRegistry?.resolve(entry.recipientId);
        const channel =
          route?.channel ?? (typeof data.channel === 'string' ? data.channel : undefined);
        if (!channel) {
          throw new Error(
            `Could not determine outbound channel for recipient ${entry.recipientId}`
          );
        }
        const eventHash = createHash('sha256')
          .update(`error-notice|${entry.recipientId}|${entry.messageId}|0`)
          .digest('hex');
        this.tickOutbox.push({
          eventId: `error-notice:${eventHash}`,
          type: 'send.command',
          payload: {
            recipientId: entry.recipientId,
            channel,
            ...(route ? { destination: route.destination } : {}),
            text: 'I could not complete that request after two attempts.',
          },
        });
      }
      if (exhaustedInbound.length > 0) {
        this.inboundStream?.settle(exhaustedInbound.map((entry) => entry.signal.id));
      }

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

      // Reload every uncommitted bus entry after a process restart.
      await this.loadBusSignals();
      // Drain signals (no side effects, no logs)
      const pendingSignals = this.drainPendingSignals();

      // Normalize each signal under its own trace context
      const incomingSignals: Signal[] = [];
      for (const signal of pendingSignals) {
        const signalCtx = createTraceContext(signal.id, { correlationId: tickId });
        try {
          const normalized = await withTraceContext(signalCtx, () => this.normalizeSignal(signal));
          if (normalized) incomingSignals.push(normalized);
          else {
            const streamId = this.signalStreamIds.get(signal.id);
            this.pendingSignals.push({
              signal,
              timestamp: signal.timestamp,
              ...(streamId !== undefined ? { streamId } : {}),
            });
          }
        } catch (error) {
          throw new SignalNormalizationError(
            `normalize ${signal.type}`,
            signal.id,
            pendingSignals.map(({ id }) => id),
            error
          );
        }
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
      const deferrableTypes = [
        'thought',
        'message_reaction',
        'user_message',
        'motor_result',
        'task_outcome',
      ];
      const needsQuestionTurn = (s: Signal) =>
        s.type === 'task_report' &&
        s.data?.kind === 'task_report' &&
        s.data.eventKind === 'question' &&
        !!s.data.question;
      const isBusPluginEvent = (s: Signal) =>
        s.type === 'plugin_event' && this.signalStreamIds.has(s.id);
      const isDeferrable = (s: Signal) =>
        deferrableTypes.includes(s.type) || needsQuestionTurn(s) || isBusPluginEvent(s);
      const hasDeferrableSignals = allSignals.some(isDeferrable);
      const cognitionAvailable = !this.pendingCognition && activeLayers.cognition;
      if (!cognitionAvailable && hasDeferrableSignals) {
        const toDefer = allSignals.filter(isDeferrable);
        const otherSignals = allSignals.filter((s) => !isDeferrable(s));

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
              pluginEvents: toDefer.filter(isBusPluginEvent).length,
            },
            `Deferring signals to next tick: ${deferReason}`
          );
        });

        // Re-queue at the front for next tick (FIFO order preserved)
        for (let i = toDefer.length - 1; i >= 0; i--) {
          const signal = toDefer[i];
          if (signal) {
            const streamId = this.signalStreamIds.get(signal.id);
            this.pendingSignals.unshift({
              signal,
              timestamp: signal.timestamp,
              ...(streamId !== undefined ? { streamId } : {}),
            });
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

      // Cognition consumes one task outcome per turn. Bus plugin events wait
      // only when another trigger won this tick or aggregation could not run.
      // A quiet aggregation evaluation completes them without a cognition turn.
      // In-memory derived plugin events still follow aggregation's normal path.
      if (aggregationResult?.triggerSignals[0]?.type === 'task_outcome') {
        aggregationResult.triggerSignals = [aggregationResult.triggerSignals[0]];
      }
      const selected = new Set(aggregationResult?.triggerSignals.map((signal) => signal.id) ?? []);
      for (const signal of allSignals) {
        const pluginNeedsLaterEvaluation =
          isBusPluginEvent(signal) && (aggregationResult === null || selected.size > 0);
        if (
          (signal.type !== 'task_outcome' &&
            !needsQuestionTurn(signal) &&
            !pluginNeedsLaterEvaluation) ||
          selected.has(signal.id)
        )
          continue;
        const streamId = this.signalStreamIds.get(signal.id);
        this.pendingSignals.push({
          signal,
          timestamp: signal.timestamp,
          ...(streamId ? { streamId } : {}),
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
        // The turn's own trace, and the trigger that woke it: the turn's model
        // calls hang under it and record the trigger type (lifemodel-d4t8).
        const traceContext = triggerSignal
          ? createTraceContext(triggerSignal.id, {
              correlationId: tickId,
              triggerType: triggerSignal.type,
            })
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
            const prune = this.domainTrackers.pruneSignaledSets();
            this.durableEffects.track('sleep dedup-set pruning', prune);
            void prune.catch((err: unknown) => {
              this.logger.warn({ error: err }, 'Failed to prune dedup sets during sleep');
            });
          }

          // Soul sleep maintenance
          if (this.soulProvider) {
            const maintenance = runSleepMaintenance({
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
            this.durableEffects.track('soul sleep maintenance', maintenance);
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
        this.markResultApplicationsComplete();
        // Settle the durable inbound log entries of a turn that reached its
        // outcome in this tick (its sends settle after, through the applicator).
        this.evaluateTurnCommits();
        const turnOwnedSignalIds = new Set(
          [...this.turnCommits.values()].flatMap((state) =>
            [...state.turn.triggerSignals, ...state.turn.absorbedSignals].map((signal) => signal.id)
          )
        );
        const deferredBusIds = new Set(
          this.pendingSignals
            .map((entry) => entry.streamId)
            .filter((id): id is string => id !== undefined)
        );
        const tickLocalCompleted = this.tickConsumedBusEntries.filter((id) => {
          const signalId = [...this.signalStreamIds.entries()].find(
            ([, streamId]) => streamId === id
          )?.[0];
          const busState = this.busSignalStream?.stateFor(id);
          const belongsToTurn = busState?.status === 'owned' && busState.turnId !== `pending:${id}`;
          return (
            !deferredBusIds.has(id) &&
            !belongsToTurn &&
            (!signalId || !turnOwnedSignalIds.has(signalId))
          );
        });
        this.busSignalStream?.markCompleted(tickLocalCompleted);

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

        // This awaited CAS is the tick's durability boundary. The next tick
        // cannot start until the complete snapshot is committed.
        const committingOutbox = [...this.tickOutbox];
        const committingBusOffset = this.busSignalStream?.committedOffset();
        this.snapshotCommitStarted = true;
        try {
          await this.commitSnapshot?.(this.tickCount, committingOutbox);
          if (this.commitSnapshot) {
            this.lastCommitAt = Date.now();
            const committed = new Set(committingOutbox);
            for (let index = this.tickOutbox.length - 1; index >= 0; index--) {
              const event = this.tickOutbox[index];
              if (event && committed.has(event)) this.tickOutbox.splice(index, 1);
            }
          }
        } catch (error) {
          if (this.busSignalStream && previousBusSnapshot) {
            await this.busSignalStream.hydrateSnapshot(previousBusSnapshot);
          }
          if (this.pendingCognitionStart) {
            const pending = this.pendingCognition;
            this.pendingCognitionStart = null;
            this.pendingCognition = null;
            if (pending) this.evictTurnCommit(pending.tickId);
          }
          throw error;
        }
        this.snapshotCommitStarted = false;
        if (this.busSignalStream && committingBusOffset !== undefined) {
          const committedOffset = committingBusOffset;
          for (const id of this.knownBusEntries) {
            if (compareStreamIds(id, committedOffset) <= 0) this.knownBusEntries.delete(id);
          }
          for (const [signalId, streamId] of this.signalStreamIds) {
            if (compareStreamIds(streamId, committedOffset) <= 0)
              this.signalStreamIds.delete(signalId);
          }
          await this.busSignalStream.trimBefore(committedOffset);
        }
        this.tickConsumedBusEntries = [];
        this.pendingCognitionStart?.();
        this.pendingCognitionStart = null;
        await this.afterSnapshotCommit?.();
        this.scheduleTick();
      });
    } catch (error) {
      if (error instanceof SignalNormalizationError) {
        this.running = false;
        this.clearCreatureStateHeartbeat();
        if (this.tickTimeout) clearTimeout(this.tickTimeout);
        this.tickTimeout = null;
        withTraceContext(tickCtx, () => {
          this.logger.error(
            {
              error: error.message,
              cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
              step: error.step,
              failedSignalId: error.signalId,
              inputIds: error.inputIds,
              tick: this.tickCount,
            },
            'Durable signal normalization failed; stopping core so inputs replay'
          );
        });
        setTimeout(() => this.onFatalError?.(error), 0);
        return;
      }
      const errorDetails =
        error instanceof Error
          ? { message: error.message, stack: error.stack, name: error.name }
          : { raw: String(error), type: typeof error };

      if (error instanceof StaleSnapshotEpochError || error instanceof StalePostgresEpochError) {
        this.running = false;
        this.clearCreatureStateHeartbeat();
        if (this.tickTimeout) clearTimeout(this.tickTimeout);
        this.tickTimeout = null;
        withTraceContext(tickCtx, () => {
          this.logger.error(
            { error: error.message, tick: this.tickCount },
            'Postgres or snapshot epoch fenced; stopping core writer'
          );
        });
        setTimeout(() => this.onStaleSnapshot?.(error), 0);
      } else {
        withTraceContext(tickCtx, () => {
          this.logger.error({ error: errorDetails, tick: this.tickCount }, 'Tick failed');
        });
        // Once a snapshot attempt starts, its in-memory section state may be
        // ahead of durable state. Stop and let restart hydrate the last commit.
        if (this.snapshotCommitStarted) {
          this.running = false;
          this.clearCreatureStateHeartbeat();
          return;
        }
        this.scheduleTick();
      }
    } finally {
      void this.publishCurrentCreatureState();
      this.tickInFlight--;
    }
  }

  private async loadBusSignals(): Promise<void> {
    if (!this.busSignalStream) return;
    await Promise.all(this.pendingBusWrites);
    this.pendingBusWrites.length = 0;
    // A previous version could trim uncommitted in-memory progress. Recover
    // its orphan ledger entries without inventing a payload or a new turn.
    // Check only replay candidates, never entries owned by a running turn.
    const replayEntries = Object.entries(this.busSignalStream.exportSnapshot().entries).filter(
      ([id, state]) => state.status !== 'completed' && !this.knownBusEntries.has(id)
    );
    const missing = await this.busSignalStream.missingEntryIds(replayEntries.map(([id]) => id));
    for (const id of missing) {
      this.logger.warn(
        { streamId: id, status: this.busSignalStream.stateFor(id)?.status },
        'Internal bus ledger entry has no stream row; completed with recorded loss'
      );
    }
    this.busSignalStream.markCompleted(missing);
    const offset = this.busSignalStream.committedOffset();
    let cursor = offset;
    let admitted = 0;
    while (admitted < this.config.maxSignalsPerTick) {
      const entries = await this.busSignalStream.readAfter(cursor, this.config.maxSignalsPerTick);
      if (entries.length === 0) break;
      let stoppedForCapacity = false;
      for (const entry of entries) {
        cursor = entry.id;
        // Completing a replayed gap can retire later completed entries that
        // were already read in this batch. Never admit those rows again.
        if (compareStreamIds(entry.id, this.busSignalStream.committedOffset()) <= 0) continue;
        const state = this.busSignalStream.stateFor(entry.id);
        if (state?.status === 'completed' || this.knownBusEntries.has(entry.id)) continue;
        // A restored turn that already used its two attempts must not run
        // again. Complete it in the next epoch-checked snapshot, including
        // legacy failed/owned entries whose retry count exceeded the budget.
        if (state && state.retries >= 2) {
          this.busSignalStream.markCompleted([entry.id]);
          this.logger.warn(
            {
              streamId: entry.id,
              retries: state.retries,
              signalType: entry.signal.type,
              signalSource: entry.signal.source,
            },
            'Internal signals failed twice and were completed with their recorded failure'
          );
          continue;
        }
        if (!state) {
          if (this.busSignalStream.admissionCapacity() === 0) {
            stoppedForCapacity = true;
            break;
          }
          this.busSignalStream.ensureOwned(entry.id, `pending:${entry.id}`);
          admitted += 1;
        }
        this.signalStreamIds.set(entry.signal.id, entry.id);
        this.knownBusEntries.add(entry.id);
        this.pendingSignals.push({
          signal: entry.signal,
          timestamp: entry.signal.timestamp,
          streamId: entry.id,
        });
      }
      if (stoppedForCapacity || entries.length < this.config.maxSignalsPerTick) break;
    }
    this.pendingSignals.sort((a, b) => {
      if (!a.streamId) return b.streamId ? 1 : 0;
      if (!b.streamId) return -1;
      return compareStreamIds(a.streamId, b.streamId);
    });
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
        if (pending.streamId) this.tickConsumedBusEntries.push(pending.streamId);
      }
    }

    return signals;
  }

  /**
   * Normalize a single signal (side effects + enrichment).
   * This should be called inside a per-signal trace context.
   */
  setTaskService(service: TaskAcceptanceService): void {
    this.intentApplicator.setTaskService(service);
  }

  applyStartTask(intent: StartTaskIntent): Promise<TaskRecord> {
    return this.intentApplicator.applyStartTask(intent);
  }

  private taskReportConsumer: ((signal: Signal) => Promise<void>) | undefined;

  /** Infrastructure handoff must settle before tick-local bus completion. */
  setTaskReportConsumer(consumer: (signal: Signal) => Promise<void>): void {
    this.taskReportConsumer = consumer;
  }

  private readonly taskQuestionRetries = new Map<
    string,
    { failures: number; nextAttemptAt: number }
  >();

  private taskQuestionReader:
    | ((taskId: string, questionId: string) => Promise<TaskQuestion | null>)
    | undefined;

  setTaskQuestionReader(
    reader: (taskId: string, questionId: string) => Promise<TaskQuestion | null>
  ): void {
    this.taskQuestionReader = reader;
  }

  private async normalizeSignal(signal: Signal): Promise<Signal | undefined> {
    let normalized = signal;
    if (
      signal.type === 'task_report' &&
      signal.data?.kind === 'task_report' &&
      signal.data.eventKind === 'terminal'
    ) {
      await this.taskReportConsumer?.(signal);
    }

    if (
      signal.type === 'task_report' &&
      signal.data?.kind === 'task_report' &&
      signal.data.eventKind === 'question'
    ) {
      // A prepared question may wait for cognition without a SQL read each tick.
      // Revalidate once cognition is free, since another turn may have answered it.
      if (this.pendingCognition && signal.data.question) return signal;
      const retry = this.taskQuestionRetries.get(signal.id);
      if (retry && Date.now() < retry.nextAttemptAt) return undefined;
      let question: TaskQuestion | null | undefined;
      try {
        question = await this.taskQuestionReader?.(signal.data.taskId, signal.data.messageId);
        this.taskQuestionRetries.delete(signal.id);
      } catch (error) {
        // Only known store/transport failures can change on a later attempt.
        // Unknown exceptions (including TypeError) are deterministic, not retries.
        const code =
          error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        const transient =
          (error instanceof TaskChannelError &&
            error.code === 'storage_error' &&
            error.status >= 500) ||
          (error instanceof TaskRegistryError && error.code === 'storage_error') ||
          (typeof code === 'string' &&
            (/^(08|53|58)/.test(code) ||
              [
                '40001',
                '40P01',
                '55P03',
                '57014',
                '57P01',
                '57P02',
                '57P03',
                'ECONNRESET',
                'ECONNREFUSED',
                'ETIMEDOUT',
                'EPIPE',
                'EAI_AGAIN',
              ].includes(code)));
        if (!transient) {
          this.taskQuestionRetries.delete(signal.id);
          this.logger.warn(
            {
              code: 'task_question_lookup_refused',
              signalId: signal.id,
              taskId: signal.data.taskId,
            },
            'Task question lookup refused; completing signal without a question'
          );
          question = null;
        } else {
          const failures = Math.min((retry?.failures ?? 0) + 1, 32);
          const retryAfterMs = Math.min(1000 * 2 ** (failures - 1), 30_000);
          this.taskQuestionRetries.set(signal.id, {
            failures,
            nextAttemptAt: Date.now() + retryAfterMs,
          });
          this.logger.warn(
            {
              code: 'task_question_lookup_pending',
              signalId: signal.id,
              taskId: signal.data.taskId,
              failures,
              retryAfterMs,
              degraded: failures >= 3,
            },
            failures === 3
              ? 'Task question lookup health degraded after consecutive failures'
              : 'Task question lookup failed; leaving signal pending for a later tick'
          );
          return undefined;
        }
      }
      const streamId = this.signalStreamIds.get(signal.id);
      const owner = streamId ? this.busSignalStream?.stateFor(streamId) : undefined;
      const replaying =
        owner && streamId && owner.status !== 'completed' && owner.turnId !== `pending:${streamId}`;
      const { question: _oldQuestion, ...data } = signal.data;
      normalized = {
        ...signal,
        data: {
          ...data,
          ...(question?.questionId === signal.data.messageId &&
          (!question.answerCommandId || replaying)
            ? { question }
            : {}),
        },
      };
    }

    // Special handling for user messages
    if (normalized.type === 'user_message') {
      await this.processUserMessageSignal(normalized);
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
  private async processUserMessageSignal(signal: Signal): Promise<void> {
    const data = signal.data as
      | {
          text?: string;
          recipientId?: string;
          sideEffectsApplied?: boolean;
          replyTo?: { sequence: string; role: 'user' | 'assistant'; excerpt: string };
        }
      | undefined;

    // Idempotency guard: skip if already applied (signal was re-queued after deferral)
    if (data?.sideEffectsApplied) return;

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
        | {
            text?: string;
            recipientId?: string;
            images?: unknown[];
            replyTo?: { sequence: string; role: 'user' | 'assistant'; excerpt: string };
          }
        | undefined;
      if (data?.text && data.recipientId) {
        const photoPrefix = data.images?.length
          ? `[Photo${data.images.length > 1 ? ` x${String(data.images.length)}` : ''} attached] `
          : '';
        await this.conversationManager.addMessage(
          data.recipientId,
          {
            role: 'user',
            content: photoPrefix + data.text,
          },
          {
            messageId: `inbound:${signal.id}`,
            ...(data.replyTo ? { replyTo: data.replyTo } : {}),
          }
        );
      }
    }
    if (data) data.sideEffectsApplied = true;
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

      if (this.busSignalStream) {
        // A single snapshot offset can cover only a consumed FIFO prefix.
        // Do not absorb a later user message past an unconsumed bus entry.
        while (this.pendingSignals.length > 0) {
          const entry = this.pendingSignals[0];
          if (entry?.signal.type !== 'user_message') break;
          const signalData = entry.signal.data as { recipientId?: string } | undefined;
          if (signalData?.recipientId !== recipientId) break;
          this.pendingSignals.shift();
          drained.push(entry.signal);
          if (entry.streamId) this.tickConsumedBusEntries.push(entry.streamId);
        }
      } else {
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
      }

      // The turn absorbed these from the queue: they are part of its set of
      // owned signals, which the durable inbound log commits with its answer.
      // The owner is the ACTIVE turn bookkeeping (finding 9): it survives the
      // stop drain clearing pendingCognition.
      const owner =
        this.activeTurnCommits ??
        (this.pendingCognition ? this.turnCommits.get(this.pendingCognition.tickId) : undefined);
      if (owner) {
        owner.turn.absorbedSignals.push(...drained);
        this.busSignalStream?.markOwned(
          drained
            .map((signal) => this.signalStreamIds.get(signal.id))
            .filter((id): id is string => id !== undefined),
          owner.turn.tickId
        );
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
    const triggerIds = triggerSignals
      .map((signal) => this.signalStreamIds.get(signal.id))
      .filter((id): id is string => id !== undefined);
    const existingTurnId = triggerIds
      .map((id) => ({ id, state: this.busSignalStream?.stateFor(id) }))
      .find(
        ({ id, state }) =>
          (state?.status === 'owned' || state?.status === 'failed') &&
          state.turnId !== `pending:${id}`
      )?.state;
    const triggerSignalId = triggerSignals[0];
    const data = triggerSignalId?.data as { updateId?: unknown } | undefined;
    const stableTurnId =
      existingTurnId && existingTurnId.status !== 'completed'
        ? existingTurnId.turnId
        : triggerIds.length > 0
          ? randomUUID()
          : typeof data?.updateId === 'string' && data.updateId
            ? data.updateId
            : `signal:${triggerSignalId?.id ?? context.tickId}`;
    context.tickId = stableTurnId;
    if (triggerIds.length > 0) this.busSignalStream?.markOwned(triggerIds, stableTurnId);

    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    // The turn runs under its own trace context, not the tick's: its model
    // calls (and its log lines) belong to the signal that woke it.
    const promise = startGate.then(() =>
      withTraceContext(traceContext, () => this.layers.cognition.process(context))
    );
    this.pendingCognitionStart = releaseStart;

    this.pendingCognition = {
      promise,
      tickId: context.tickId,
      startedAt,
      triggerSignals,
      // All proactive triggers route to the configured owner, just as
      // cognition does. Capture that owner so its send settles the bus entry in
      // the same snapshot as the answer, even after outbound dedup is trimmed.
      recipientId: (() => {
        const first = triggerSignals[0];
        const data = first?.data as { recipientId?: unknown } | undefined;
        return typeof data?.recipientId === 'string'
          ? data.recipientId
          : first?.type !== 'user_message'
            ? getPrimaryRecipientId()
            : undefined;
      })(),
      primaryTrigger: triggerSignal ?? context.triggerSignals[0] ?? undefined,
      absorbedSignals: [],
      traceContext,
    };
    this.registerTurnCommit(context.tickId, this.pendingCognition);
    void this.publishCurrentCreatureState();

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
      });
  }

  /**
   * The turn's OWN result intents, attributed to it (lifemodel-ctc.2.1, review
   * round 8). A producer may hand back a SEND_MESSAGE without the turn's trace
   * (the cognition processor's apology for a thrown agentic loop did), and by
   * the time the result is applied the active turn is already cleared - so the
   * send would belong to NO turn: it would never report start or settle, the
   * turn would never reach an outcome, and its inbound entry would replay after
   * a GRACEFUL restart (a second answer). The turn is known HERE, so the trace
   * is added here, for the intents that carry none; an intent that names its
   * own turn keeps it.
   */
  private attributedToTurn(intents: Intent[], turn: PendingCognition): Intent[] {
    const tickId = turn.tickId;
    const parentSignalId = turn.primaryTrigger?.id ?? turn.triggerSignals[0]?.id ?? '';
    return intents.map((intent) =>
      intent.trace === undefined
        ? ({ ...intent, trace: { tickId, parentSignalId } } as Intent)
        : intent
    );
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

      const resultIntents = this.resolveTurnCommit(
        pending.tickId,
        result.disposition,
        result.intents
      );
      this.pendingCognition = null;
      void this.publishCurrentCreatureState();
      // The turn is known here and nowhere later (see attributedToTurn): its
      // own result intents leave with their turn's trace.
      return { ...result, intents: this.attributedToTurn(resultIntents, pending) };
    } catch (error) {
      const errorIntents = this.resolveTurnCommit(pending.tickId, 'error', []);
      this.pendingCognition = null;
      void this.publishCurrentCreatureState();
      if (errorIntents.length > 0) this.applyIntents(errorIntents, pending.traceContext);
      this.markResultApplicationsComplete();
      this.evaluateTurnCommits();
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
    // and sends must not happen behind the released channels.
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
