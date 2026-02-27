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
} from '../types/index.js';
import { createSignal, THOUGHT_LIMITS } from '../types/signal.js';
import {
  createTraceContext,
  withTraceContext,
  type TraceContext,
} from './trace-context.js';
import type {
  AutonomicResult,
  AggregationResult,
  CognitionResult,
  CognitionContext,
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

/**
 * Core loop configuration.
 */
export interface CoreLoopConfig {
  /** Fixed tick interval in ms (default: 1000) */
  tickInterval: number;

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
  /** Original trigger signal (may be undefined) */
  triggerSignal: Signal | undefined;
  /** Trace context captured when cognition started */
  traceContext: TraceContext;
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

  private readonly channels = new Map<string, Channel>();
  private readonly pendingSignals: PendingSignal[] = [];
  private readonly healthMonitor: SystemHealthMonitor;

  private readonly conversationManager: ConversationManager | undefined;
  private readonly userModel: UserModel | undefined;
  private readonly memoryProvider: MemoryProvider | undefined;
  private readonly memoryConsolidator: MemoryConsolidator | undefined;
  private readonly recipientRegistry: IRecipientRegistry | undefined;
  private readonly soulProvider: SoulProvider | undefined;

  /** Previous alertness mode for detecting transitions */
  private previousAlertnessMode: AlertnessMode | undefined;

  /** Subscription ID for typing events */
  private typingSubscriptionId: string | null = null;

  /** Pending COGNITION operation (non-blocking) */
  private pendingCognition: PendingCognition | null = null;

  /** Scheduler service for plugin timers */
  private schedulerService: SchedulerService | null = null;

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
    this.metrics = metrics;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.conversationManager = deps.conversationManager;
    this.userModel = deps.userModel;
    this.memoryProvider = deps.memoryProvider;
    this.memoryConsolidator = deps.memoryConsolidator;
    this.recipientRegistry = deps.recipientRegistry;
    this.soulProvider = deps.soulProvider;

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
    });
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
   * Stop the signal loop.
   */
  stop(): void {
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

    this.logger.info({ tickCount: this.tickCount }, 'Core loop stopped');
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
      void this.tick();
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

      // Apply pending plugin changes FIRST (before any processing)
      this.schedulerService?.applyPendingChanges();

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

        this.startCognitionAsync(cognitionContext, triggerSignal, traceContext);
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
          currentMode === 'sleep' &&
          this.previousAlertnessMode !== 'sleep'
        ) {
          this.logger.info('Entering sleep mode - triggering memory consolidation');
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

        // Check plugin schedulers for due events
        if (this.schedulerService) {
          try {
            await this.schedulerService.tick();
          } catch (error) {
            this.logger.error(
              { error: error instanceof Error ? error.message : String(error) },
              'Scheduler service tick failed'
            );
          }
        }

        // Apply all intents (per-intent context handled inside)
        this.applyIntents(allIntents, tickCtx);

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
        this.metrics.gauge('system_stress_level', this.stressLevelToNumber(stressLevel));

        this.scheduleTick();
      });
    } catch (error) {
      const errorDetails =
        error instanceof Error
          ? { message: error.message, stack: error.stack, name: error.name }
          : { raw: String(error), type: typeof error };

      withTraceContext(tickCtx, () => {
        this.logger.error({ error: errorDetails, tick: this.tickCount }, 'Tick failed');
      });

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

    // Save to conversation history
    if (this.conversationManager) {
      const data = signal.data as { text?: string; recipientId?: string } | undefined;
      if (data?.text && data.recipientId) {
        // Use recipientId as conversation key
        void this.conversationManager.addMessage(data.recipientId, {
          role: 'user',
          content: data.text,
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

      return drained;
    };
  }

  /**
   * Start COGNITION processing asynchronously (non-blocking).
   */
  private startCognitionAsync(
    context: CognitionContext,
    triggerSignal: Signal | undefined,
    traceContext: TraceContext
  ): void {
    const startedAt = Date.now();

    const promise = this.layers.cognition.process(context);

    this.pendingCognition = {
      promise,
      tickId: context.tickId,
      startedAt,
      triggerSignal: triggerSignal ?? context.triggerSignals[0] ?? undefined,
      traceContext,
    };

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
        this.pendingCognition = null;
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
              pending.triggerSignal?.data as Record<string, unknown> | undefined
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

      this.pendingCognition = null;
      return result;
    } catch (error) {
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
  private async handleTypingEvent(event: import('../types/index.js').Event): Promise<void> {
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
