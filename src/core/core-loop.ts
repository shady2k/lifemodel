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
  SignalType,
  SignalSource,
  Logger,
  Metrics,
  Intent,
  Channel,
  SendOptions,
  Event,
  ThoughtData,
  InterestIntensity,
  MessageReactionData,
} from '../types/index.js';
import { createSignal, THOUGHT_LIMITS } from '../types/signal.js';
import type { PluginEventData } from '../types/signal.js';
import {
  createTraceContext,
  withTraceContext,
  withCaller,
  type TraceContext,
} from './trace-context.js';
import type {
  AutonomicResult,
  AggregationResult,
  CognitionResult,
  CognitionContext,
} from '../types/layers.js';
import { Priority } from '../types/index.js';
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
import type { MemoryProvider, MemoryEntry } from '../layers/cognition/tools/registry.js';
import type { MemoryConsolidator } from '../storage/memory-consolidator.js';
import type { SoulProvider } from '../storage/soul-provider.js';
import type { Precedent } from '../types/agent/soul.js';
import type { AlertnessMode } from '../types/agent/state.js';
import type { SchedulerService } from './scheduler-service.js';
import type { IRecipientRegistry } from './recipient-registry.js';
import { runSleepMaintenance } from '../layers/cognition/soul/sleep-maintenance.js';
import { setPrimaryRecipientId } from './globals.js';
import { markdownToTelegramHtml } from '../utils/telegram-html.js';

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

  private readonly messageComposer: MessageComposer | undefined;
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

  /** Timestamp of last message sent (for response timing) */
  private lastMessageSentAt: number | null = null;
  private lastMessageRecipientId: string | null = null;

  /** Pending COGNITION operation (non-blocking) */
  private pendingCognition: PendingCognition | null = null;

  /** Scheduler service for plugin timers */
  private schedulerService: SchedulerService | null = null;

  /** Track thoughts emitted per tick for budget enforcement */
  private thoughtsThisTick = 0;

  /** Primary recipient ID for proactive features */
  private primaryRecipientId: string | undefined;

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
    this.messageComposer = deps.messageComposer;
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

    // If it's a high-priority signal, wake up immediately
    if (signal.priority <= Priority.HIGH) {
      this.wakeUp();
    }
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

        // Update thought pressure before neurons run
        await this.updateThoughtPressure();

        // Update desire pressure before neurons run (Phase 6)
        await this.updateDesirePressure();

        // Scan for overdue commitments and predictions (Phases 5, 7)
        await this.checkOverdueCommitments();
        await this.checkOverduePredictions();
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
    if (!this.userModel || !this.lastMessageSentAt) {
      return;
    }

    const data = signal.data as { recipientId?: string } | undefined;
    if (!data?.recipientId || data.recipientId !== this.lastMessageRecipientId) {
      return;
    }

    const responseTimeMs = Date.now() - this.lastMessageSentAt;
    const responseTimeSec = responseTimeMs / 1000;

    if (responseTimeSec < 30) {
      this.userModel.processSignal('quick_response', { responseTimeMs });
      this.logger.debug({ responseTimeSec: responseTimeSec.toFixed(1) }, 'Quick response detected');
    } else if (responseTimeSec > 300) {
      this.userModel.processSignal('slow_response', { responseTimeMs });
      this.logger.debug({ responseTimeSec: responseTimeSec.toFixed(1) }, 'Slow response detected');
    }

    // Reset tracking
    this.lastMessageSentAt = null;
    this.lastMessageRecipientId = null;

    this.metrics.histogram('user_response_time_ms', responseTimeMs);
  }

  /**
   * Update thought pressure in agent state.
   *
   * Thought pressure is calculated from:
   * - Count of recent thoughts (more thoughts = more pressure)
   * - Age of oldest thought (older thoughts = more pressure, Zeigarnik Effect)
   * - Energy amplifier (low energy = thoughts feel heavier)
   */
  private async updateThoughtPressure(): Promise<void> {
    if (!this.memoryProvider) {
      return;
    }

    try {
      // Get recent thoughts from the last 30 minutes (working memory window)
      const windowMs = 30 * 60 * 1000;
      const recentThoughts = await this.memoryProvider.getRecentByType('thought', {
        windowMs,
        limit: 20, // Get enough to calculate accurately
      });

      const thoughtCount = recentThoughts.length;

      // Calculate oldest thought age (for pressure calculation)
      let oldestAgeMs = 0;
      if (thoughtCount > 0) {
        const now = Date.now();
        const timestamps = recentThoughts.map((t) => t.timestamp.getTime());
        const oldest = Math.min(...timestamps);
        oldestAgeMs = now - oldest;
      }

      // Pressure formula:
      // - More thoughts = more pressure (capped at 5 for full effect)
      // - Older thoughts = more pressure (max at 2 hours)
      const countFactor = Math.min(1, thoughtCount / 5);
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const ageFactor = Math.min(1, oldestAgeMs / twoHoursMs);

      // Energy amplifier: low energy = thoughts feel heavier
      const state = this.agent.getState();
      const energyAmplifier = 1 + (1 - state.energy) * 0.3;

      // Combined pressure (60% count, 40% age)
      const rawPressure = (countFactor * 0.6 + ageFactor * 0.4) * energyAmplifier;
      const pressure = Math.min(1, rawPressure);

      // Update agent state
      this.agent.updateState({
        thoughtPressure: pressure,
        pendingThoughtCount: thoughtCount,
      });
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to update thought pressure'
      );
    }
  }

  /** Throttle: last time desire pressure was computed */
  private lastDesirePressureCheckAt = 0;

  /**
   * Update desire pressure in agent state.
   *
   * Desire pressure = weighted combination of active desire count and max intensity.
   * Throttled to run at most once per 30 seconds (desires change slowly).
   */
  private async updateDesirePressure(): Promise<void> {
    const mp = this.memoryProvider;
    if (!mp) return;

    // Throttle: only check every 30 seconds
    const now = Date.now();
    if (now - this.lastDesirePressureCheckAt < 30_000) return;
    this.lastDesirePressureCheckAt = now;

    try {
      const activeDesires = await withCaller('updateDesirePressure', () =>
        mp.findByKind('desire', { state: 'active', limit: 20 })
      );
      if (activeDesires.length === 0) {
        this.agent.updateState({ desirePressure: 0 });
        return;
      }

      // Extract intensities from metadata
      const intensities = activeDesires.map((e) => {
        const raw = e.metadata?.['intensity'];
        return typeof raw === 'number' ? raw : (e.confidence ?? 0.5);
      });

      // Pressure formula:
      // - maxIntensity (60%): strongest want dominates
      // - countFactor (40%): more wants = more pressure (capped at 5)
      const maxIntensity = Math.max(...intensities);
      const countFactor = Math.min(1, activeDesires.length / 5);
      const pressure = Math.min(1, maxIntensity * 0.6 + countFactor * 0.4);

      this.agent.updateState({ desirePressure: pressure });
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to update desire pressure'
      );
    }
  }

  /** IDs of commitments already signaled as due (dedup) */
  private readonly signaledDueCommitments = new Set<string>();
  /** IDs of commitments already signaled as overdue (dedup) */
  private readonly signaledOverdueCommitments = new Set<string>();
  /** Grace period before a due commitment becomes overdue (1 hour) */
  private static readonly COMMITMENT_GRACE_PERIOD_MS = 60 * 60 * 1000;
  /** Throttle: last time overdue commitments were checked */
  private lastCommitmentCheckAt = 0;

  /**
   * Check for due and overdue active commitments and emit plugin_event signals.
   *
   * Two-stage lifecycle:
   * 1. `commitment:due` fires when dueAt <= now (nudge: "act on this now")
   * 2. `commitment:overdue` fires when dueAt + grace period <= now (breach: "you missed it, repair")
   *
   * Throttled to run at most once per 60 seconds.
   */
  private async checkOverdueCommitments(): Promise<void> {
    const mp = this.memoryProvider;
    if (!mp) return;

    const now = Date.now();
    if (now - this.lastCommitmentCheckAt < 60_000) return;
    this.lastCommitmentCheckAt = now;

    try {
      const activeCommitments = await withCaller('checkOverdueCommitments', () =>
        mp.findByKind('commitment', { state: 'active', limit: 50 })
      );

      const nowDate = new Date();
      for (const entry of activeCommitments) {
        const dueAtStr = entry.metadata?.['dueAt'];
        if (typeof dueAtStr !== 'string') continue;

        const dueAt = new Date(dueAtStr);
        if (dueAt > nowDate) continue; // Not yet due

        const recipientId = entry.recipientId ?? this.primaryRecipientId ?? 'default';
        const msSinceDue = now - dueAt.getTime();

        // Stage 1: commitment:due (fires at dueAt)
        if (!this.signaledDueCommitments.has(entry.id)) {
          const signalData: PluginEventData = {
            kind: 'plugin_event',
            eventKind: 'commitment:due',
            pluginId: 'commitment',
            fireId: `due_${entry.id}_${String(now)}`,
            payload: {
              commitmentId: entry.id,
              recipientId,
              text: entry.content,
              dueAt: dueAtStr,
              source: (entry.metadata?.['source'] as string | undefined) ?? 'explicit',
            },
          };

          const signal: Signal = {
            id: randomUUID(),
            type: 'plugin_event',
            source: 'plugin.commitment' as SignalSource,
            timestamp: nowDate,
            priority: Priority.HIGH,
            metrics: { value: 1, confidence: 1 },
            data: signalData,
            expiresAt: new Date(now + 60_000),
          };

          this.pushSignal(signal);
          this.signaledDueCommitments.add(entry.id);

          this.logger.info(
            { commitmentId: entry.id, dueAt: dueAtStr, text: entry.content.slice(0, 50) },
            'Commitment due, signal emitted'
          );
          continue; // Don't emit overdue in the same scan — give grace period
        }

        // Stage 2: commitment:overdue (fires after grace period)
        if (
          msSinceDue >= CoreLoop.COMMITMENT_GRACE_PERIOD_MS &&
          !this.signaledOverdueCommitments.has(entry.id)
        ) {
          const signalData: PluginEventData = {
            kind: 'plugin_event',
            eventKind: 'commitment:overdue',
            pluginId: 'commitment',
            fireId: `overdue_${entry.id}_${String(now)}`,
            payload: {
              commitmentId: entry.id,
              recipientId,
              text: entry.content,
              dueAt: dueAtStr,
              source: (entry.metadata?.['source'] as string | undefined) ?? 'explicit',
            },
          };

          const signal: Signal = {
            id: randomUUID(),
            type: 'plugin_event',
            source: 'plugin.commitment' as SignalSource,
            timestamp: nowDate,
            priority: Priority.HIGH,
            metrics: { value: 1, confidence: 1 },
            data: signalData,
            expiresAt: new Date(now + 60_000),
          };

          this.pushSignal(signal);
          this.signaledOverdueCommitments.add(entry.id);

          this.logger.info(
            { commitmentId: entry.id, dueAt: dueAtStr, text: entry.content.slice(0, 50) },
            'Overdue commitment detected, signal emitted'
          );
        }
      }
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to check overdue commitments'
      );
    }
  }

  /** IDs of predictions already signaled as due (dedup) */
  private readonly signaledDuePredictions = new Set<string>();
  /** Throttle: last time overdue predictions were checked */
  private lastPredictionCheckAt = 0;

  /**
   * Check for predictions past their horizon and emit plugin_event signals.
   *
   * Scans memory for pending predictions whose horizonAt has passed.
   * Emits one `perspective:prediction_due` signal per overdue prediction (deduped).
   * Throttled to run at most once per 60 seconds.
   */
  private async checkOverduePredictions(): Promise<void> {
    const mp = this.memoryProvider;
    if (!mp) return;

    const now = Date.now();
    if (now - this.lastPredictionCheckAt < 60_000) return;
    this.lastPredictionCheckAt = now;

    try {
      const pendingPredictions = await withCaller('checkOverduePredictions', () =>
        mp.findByKind('prediction', { state: 'pending', limit: 50 })
      );

      const nowDate = new Date();
      for (const entry of pendingPredictions) {
        const horizonAtStr = entry.metadata?.['horizonAt'];
        if (typeof horizonAtStr !== 'string') continue;

        const horizonAt = new Date(horizonAtStr);
        if (horizonAt > nowDate) continue; // Not yet due

        // Already signaled this prediction
        if (this.signaledDuePredictions.has(entry.id)) continue;

        // Emit prediction_due signal
        const signalData: PluginEventData = {
          kind: 'plugin_event',
          eventKind: 'perspective:prediction_due',
          pluginId: 'perspective',
          fireId: `due_${entry.id}_${String(now)}`,
          payload: {
            predictionId: entry.id,
            recipientId: entry.recipientId ?? this.primaryRecipientId ?? 'default',
            claim: entry.content,
            horizonAt: horizonAtStr,
            confidence: (entry.metadata?.['confidence'] as number | undefined) ?? 0.6,
          },
        };

        const signal: Signal = {
          id: randomUUID(),
          type: 'plugin_event',
          source: 'plugin.perspective' as SignalSource,
          timestamp: nowDate,
          priority: Priority.NORMAL,
          metrics: { value: 1, confidence: 1 },
          data: signalData,
          expiresAt: new Date(now + 60_000),
        };

        this.pushSignal(signal);
        this.signaledDuePredictions.add(entry.id);

        this.logger.info(
          { predictionId: entry.id, horizonAt: horizonAtStr, claim: entry.content.slice(0, 50) },
          'Overdue prediction detected, signal emitted'
        );
      }
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to check overdue predictions'
      );
    }
  }

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

    this.applyIntents([intent], intentCtx);
  }

  /**
   * Apply intents from all layers.
   * Each intent is applied under its own trace context.
   */
  private applyIntents(intents: Intent[], tickCtx: TraceContext): void {
    for (const intent of intents) {
      // Create trace context for this intent
      // Use intent's trace info if available, otherwise fall back to tick context
      const trace = intent.trace;

      let intentCtx: TraceContext;
      if (trace?.parentSignalId ?? trace?.tickId) {
        const traceId = trace.parentSignalId ?? trace.tickId ?? tickCtx.traceId;
        const options: { correlationId?: string; parentId?: string } = {};
        if (trace.tickId !== undefined) options.correlationId = trace.tickId;
        else if (tickCtx.correlationId !== undefined) options.correlationId = tickCtx.correlationId;
        if (trace.parentSignalId !== undefined) options.parentId = trace.parentSignalId;
        intentCtx = createTraceContext(traceId, options);
      } else {
        intentCtx = tickCtx;
      }

      withTraceContext(intentCtx, () => {
        switch (intent.type) {
          case 'UPDATE_STATE':
            this.agent.applyIntent(intent);
            break;

          case 'SEND_MESSAGE': {
            const { recipientId, text, replyTo, conversationStatus } = intent.payload;

            if (!this.recipientRegistry) {
              this.logger.error({ recipientId }, 'RecipientRegistry not configured');
              this.metrics.counter('messages_failed', { reason: 'no_registry' });
              break;
            }

            const route = this.recipientRegistry.resolve(recipientId);
            if (!route) {
              this.logger.error({ recipientId }, 'Could not resolve recipientId');
              this.metrics.counter('messages_failed', { reason: 'unresolved_recipient' });
              break;
            }

            const channelImpl = this.channels.get(route.channel);
            if (!channelImpl) {
              this.logger.error(
                {
                  recipientId,
                  channel: route.channel,
                  registeredChannels: Array.from(this.channels.keys()),
                },
                'Channel not found'
              );
              this.metrics.counter('messages_failed', {
                channel: route.channel,
                reason: 'channel_not_found',
              });
              break;
            }

            const htmlText = markdownToTelegramHtml(text);
            const sendOptions: SendOptions = {
              ...(replyTo && { replyTo }),
              parseMode: 'HTML',
            };
            Promise.resolve()
              .then(async () => {
                // Duplicate detection: skip sending if message is identical to last assistant message
                // This prevents proactive contacts from repeating the same response
                if (this.conversationManager) {
                  const lastMessage =
                    await this.conversationManager.getLastAssistantMessage(recipientId);
                  if (lastMessage && lastMessage === text) {
                    this.logger.warn(
                      { recipientId, textLength: text.length },
                      'Skipping duplicate message - identical to last assistant message'
                    );
                    this.metrics.counter('messages_skipped', { reason: 'duplicate' });
                    return { success: false, skipped: true };
                  }
                }
                return channelImpl.sendMessage(route.destination, htmlText, sendOptions);
              })
              .then((result) => {
                if (result.success) {
                  this.lastMessageSentAt = Date.now();
                  this.lastMessageRecipientId = recipientId;
                  this.metrics.counter('messages_sent', { channel: route.channel });
                  this.agent.onMessageSent();

                  if (this.conversationManager) {
                    // Type guard: messageId only exists on actual send results, not on skipped results
                    const messageId = 'messageId' in result ? result.messageId : undefined;
                    // Note: toolCalls and toolResults are NOT saved to history
                    // They're kept in agentic loop memory only to prevent pollution across triggers
                    void this.saveAgentMessage(
                      recipientId,
                      text,
                      conversationStatus,
                      messageId
                        ? { channelMessageId: messageId, channel: route.channel }
                        : undefined
                    );
                  }
                } else if ('skipped' in result && result.skipped) {
                  // Message was intentionally skipped (duplicate detection)
                  // Already logged and tracked in the duplicate check
                } else {
                  this.logger.warn(
                    { recipientId, channel: route.channel, textLength: text.length },
                    'Message send returned false'
                  );
                  this.metrics.counter('messages_failed', {
                    channel: route.channel,
                    reason: 'returned_false',
                  });
                }
              })
              .catch((error: unknown) => {
                this.logger.error(
                  { error: error instanceof Error ? error.message : String(error), recipientId },
                  'Message send threw an error'
                );
                this.metrics.counter('messages_failed', {
                  channel: route.channel,
                  reason: 'exception',
                });
              });
            break;
          }

          case 'SCHEDULE_EVENT': {
            const { event, delay, scheduleId } = intent.payload;
            const fullEvent: Event = {
              id: scheduleId ?? randomUUID(),
              source: event.source as Event['source'],
              type: event.type,
              priority: event.priority,
              timestamp: new Date(),
              payload: event.payload,
            };
            if (event.channel) {
              fullEvent.channel = event.channel;
            }

            if (delay <= 0) {
              void this.eventBus.publish(fullEvent);
            } else {
              setTimeout(() => {
                if (this.running) {
                  void this.eventBus.publish(fullEvent);
                }
              }, delay);
            }
            break;
          }

          case 'LOG':
            this.logger[intent.payload.level](intent.payload.context ?? {}, intent.payload.message);
            break;

          case 'EMIT_METRIC': {
            const { type: metricType, name, value, labels } = intent.payload;
            switch (metricType) {
              case 'gauge':
                this.metrics.gauge(name, value, labels);
                break;
              case 'counter':
                this.metrics.counter(name, labels);
                break;
              case 'histogram':
                this.metrics.histogram(name, value, labels);
                break;
            }
            break;
          }

          case 'CANCEL_EVENT':
            this.logger.debug({ intent }, 'CANCEL_EVENT not yet implemented');
            break;

          case 'SAVE_TO_MEMORY': {
            const {
              type: memoryType,
              recipientId: memoryRecipientId,
              content,
              fact,
              tags,
            } = intent.payload;

            if (this.memoryProvider) {
              const subject = fact?.subject ?? '';
              const predicate = fact?.predicate ?? '';
              const object = fact?.object ?? '';
              const evidence = fact?.evidence ?? '';
              const entryContent = fact
                ? `${subject} ${predicate} ${object}${evidence ? ` (${evidence})` : ''}`
                : (content ?? '');

              if (entryContent.trim()) {
                const entry = {
                  id: `mem_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`,
                  type: memoryType as 'fact' | 'thought' | 'message' | 'intention',
                  content: entryContent,
                  timestamp: new Date(),
                  recipientId: memoryRecipientId,
                  tags: tags ?? fact?.tags,
                  confidence: fact?.confidence,
                  metadata: fact ? { subject, predicate, object } : undefined,
                };

                this.memoryProvider.save(entry).catch((err: unknown) => {
                  this.logger.error(
                    { error: err instanceof Error ? err.message : String(err) },
                    'Failed to save to memory'
                  );
                });

                this.logger.debug(
                  { entryId: entry.id, type: memoryType, content: entryContent.slice(0, 50) },
                  'Memory entry saved'
                );
              }
            } else {
              this.logger.debug(
                {
                  memoryType,
                  recipientId: memoryRecipientId,
                  hasFact: !!fact,
                  hasContent: !!content,
                },
                'Memory save skipped (no provider)'
              );
            }

            this.metrics.counter('memory_saves', { type: memoryType });
            break;
          }

          case 'ACK_SIGNAL': {
            const { signalId, signalType, source, reason } = intent.payload;

            const ackRegistry = this.layers.aggregation.getAckRegistry();

            if (signalType === 'thought') {
              if (signalId) {
                ackRegistry.markHandled(signalId);
              } else {
                this.logger.warn({ signalType }, 'Thought ACK missing signalId');
              }
            }

            ackRegistry.registerAck({
              signalType: signalType as SignalType,
              source: source as SignalSource | undefined,
              ackType: 'handled',
              reason,
            });

            this.logger.debug({ signalId, signalType, source, reason }, 'Signal acknowledged');
            this.metrics.counter('signal_acks', { signalType, ackType: 'handled' });
            break;
          }

          case 'DEFER_SIGNAL': {
            const { signalType, source, deferMs, valueAtDeferral, overrideDelta, reason } =
              intent.payload;

            let currentValue = valueAtDeferral;
            if (currentValue === undefined) {
              const aggregate = this.layers.aggregation.getAggregate(signalType as SignalType);
              currentValue = aggregate?.currentValue;
            }

            const ackRegistry = this.layers.aggregation.getAckRegistry();
            ackRegistry.registerAck({
              signalType: signalType as SignalType,
              source: source as SignalSource | undefined,
              ackType: 'deferred',
              deferUntil: new Date(Date.now() + deferMs),
              valueAtAck: currentValue,
              overrideDelta,
              reason,
            });

            this.logger.info(
              {
                signalType,
                deferMs,
                deferHours: (deferMs / (60 * 60 * 1000)).toFixed(1),
                reason,
                valueAtDeferral: currentValue?.toFixed(2),
              },
              'Signal deferred'
            );
            this.metrics.counter('signal_acks', { signalType, ackType: 'deferred' });
            break;
          }

          case 'EMIT_THOUGHT': {
            const {
              content,
              triggerSource,
              depth,
              rootThoughtId,
              parentThoughtId,
              signalSource,
              recipientId: thoughtRecipientId,
            } = intent.payload;

            const thoughtData: ThoughtData = {
              kind: 'thought',
              content,
              triggerSource,
              depth,
              rootThoughtId,
              ...(parentThoughtId !== undefined && { parentThoughtId }),
              ...(thoughtRecipientId !== undefined && { recipientId: thoughtRecipientId }),
            };

            this.enqueueThoughtSignal(thoughtData, signalSource as SignalSource);
            break;
          }

          case 'REMEMBER': {
            const {
              subject,
              attribute,
              value,
              confidence,
              source,
              evidence,
              isUserFact,
              recipientId: rememberRecipientId,
            } = intent.payload;
            const trace = intent.trace;

            if (isUserFact && this.userModel) {
              const strValue = value.trim();
              const isDelta = strValue.startsWith('+') || strValue.startsWith('-');
              const deltaNum = isDelta ? this.parseDelta(value) : null;

              if (isDelta && deltaNum !== null) {
                const currentProp = this.userModel.getProperty(attribute);
                const currentNum = typeof currentProp?.value === 'number' ? currentProp.value : 0.5;
                const newValue = Math.max(0, Math.min(1, currentNum + deltaNum));
                this.userModel.setProperty(attribute, newValue, confidence, source, evidence);
                this.logger.debug(
                  {
                    attribute,
                    delta: deltaNum,
                    current: currentNum,
                    newValue,
                    tickId: trace?.tickId,
                  },
                  'User property updated (delta)'
                );
              } else {
                this.userModel.setProperty(attribute, value, confidence, source, evidence);
                this.logger.debug(
                  {
                    attribute,
                    value,
                    confidence,
                    tickId: trace?.tickId,
                    parentSignalId: trace?.parentSignalId,
                  },
                  'User property stored'
                );
              }
            }

            if (this.memoryProvider) {
              const memoryEntry = {
                id: `mem_${randomUUID()}`,
                type: 'fact' as const,
                content: `${subject}.${attribute}: ${value}`,
                timestamp: new Date(),
                recipientId: rememberRecipientId,
                confidence,
                metadata: { subject, attribute, source, evidence, isUserFact },
                tickId: trace?.tickId,
                parentSignalId: trace?.parentSignalId,
              };

              this.memoryProvider.save(memoryEntry).catch((err: unknown) => {
                this.logger.error(
                  { error: err instanceof Error ? err.message : String(err) },
                  'Failed to save remembered fact to memory'
                );
              });

              this.logger.debug(
                {
                  subject,
                  attribute,
                  tickId: trace?.tickId,
                  parentSignalId: trace?.parentSignalId,
                },
                'Memory stored'
              );
            }

            if (rememberRecipientId && this.conversationManager) {
              const summary = `${subject}.${attribute}="${value}"`;
              this.conversationManager
                .addCompletedAction(rememberRecipientId, {
                  tool: 'core.remember',
                  summary,
                })
                .catch((err: unknown) => {
                  this.logger.warn(
                    { error: err instanceof Error ? err.message : String(err) },
                    'Failed to record completed action for remember'
                  );
                });
            }

            this.metrics.counter('facts_remembered', { isUserFact: String(isUserFact) });
            break;
          }

          case 'SET_INTEREST': {
            const {
              topic,
              intensity,
              urgent,
              source,
              recipientId: interestRecipientId,
            } = intent.payload;
            const trace = intent.trace;

            if (!this.userModel) {
              this.logger.warn({ topic }, 'SET_INTEREST skipped: no UserModel');
              break;
            }

            if (typeof topic !== 'string' || topic.length === 0) {
              this.logger.error({ topic, intensity }, 'SET_INTEREST: invalid topic');
              break;
            }

            const keywords = topic
              .split(',')
              .map((kw) => kw.trim().toLowerCase())
              .filter((kw) => kw.length >= 2);

            if (keywords.length === 0) {
              this.logger.error({ topic, intensity }, 'SET_INTEREST: no valid keywords');
              break;
            }

            const delta = CoreLoop.INTENSITY_DELTAS[intensity];
            const interests = this.userModel.getInterests();

            for (const keyword of keywords) {
              const currentWeight = interests?.weights[keyword] ?? 0.5;
              const newWeight = Math.max(0, Math.min(1, currentWeight + delta));
              this.userModel.setTopicWeight(keyword, newWeight);

              if (urgent) {
                const currentUrgency = interests?.urgency[keyword] ?? 0.5;
                const newUrgency = Math.max(0, Math.min(1, currentUrgency + 0.5));
                this.userModel.setTopicUrgency(keyword, newUrgency);
              }
            }

            if (interestRecipientId && this.conversationManager) {
              const summary = `topic="${topic}", intensity=${intensity}${urgent ? ', urgent' : ''}`;
              this.conversationManager
                .addCompletedAction(interestRecipientId, {
                  tool: 'core.setInterest',
                  summary,
                })
                .catch((err: unknown) => {
                  this.logger.warn(
                    { error: err instanceof Error ? err.message : String(err) },
                    'Failed to record completed action for setInterest'
                  );
                });
            }

            this.logger.debug(
              {
                originalTopic: topic,
                keywords,
                intensity,
                delta,
                urgent,
                source,
                tickId: trace?.tickId,
              },
              'Topic interests updated'
            );

            this.metrics.counter('interests_set', { intensity, urgent: String(urgent) });

            // Bump curiosity when user shows interest (Phase 2: Dynamic Curiosity)
            // Random bump between 0.1-0.15 to add natural variation
            const curiosityBump = 0.1 + Math.random() * 0.05;
            this.agent.applyIntent({
              type: 'UPDATE_STATE',
              payload: { key: 'curiosity', value: curiosityBump, delta: true },
            });
            break;
          }

          case 'COMMITMENT': {
            const {
              action,
              commitmentId,
              text,
              dueAt,
              source,
              confidence,
              repairNote,
              recipientId: commitmentRecipientId,
            } = intent.payload;
            const trace = intent.trace;

            if (!this.memoryProvider) {
              this.logger.warn({ action }, 'COMMITMENT skipped: no MemoryProvider');
              break;
            }

            if (action === 'create') {
              if (!commitmentId || !text || !dueAt) {
                this.logger.error(
                  { commitmentId, text, dueAt },
                  'COMMITMENT create: missing fields'
                );
                break;
              }

              // Store commitment as MemoryEntry
              const entry: MemoryEntry = {
                id: commitmentId,
                type: 'fact',
                content: text,
                timestamp: new Date(),
                recipientId: commitmentRecipientId,
                tags: ['commitment', 'state:active'],
                confidence: confidence ?? 0.9,
                metadata: {
                  kind: 'commitment',
                  dueAt: dueAt.toISOString(),
                  source: source ?? 'explicit',
                  createdAt: new Date().toISOString(),
                },
                tickId: trace?.tickId,
                parentSignalId: trace?.parentSignalId,
              };

              this.memoryProvider.save(entry).catch((err: unknown) => {
                this.logger.error(
                  { commitmentId, error: err instanceof Error ? err.message : String(err) },
                  'Failed to save commitment'
                );
              });

              // Record completed action
              if (commitmentRecipientId && this.conversationManager) {
                const dueDate = new Date(dueAt);
                const summary = `promise: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" (due ${dueDate.toLocaleDateString()})`;
                this.conversationManager
                  .addCompletedAction(commitmentRecipientId, {
                    tool: 'core.commitment',
                    summary,
                  })
                  .catch((err: unknown) => {
                    this.logger.warn(
                      { error: err instanceof Error ? err.message : String(err) },
                      'Failed to record completed action for commitment'
                    );
                  });
              }

              this.logger.info(
                { commitmentId, text: text.slice(0, 50), dueAt, source },
                'Commitment created'
              );
              this.metrics.counter('commitments_created', { source: source ?? 'explicit' });
            } else if (action === 'mark_kept') {
              // Update commitment status to kept
              if (commitmentId) {
                void this.updateCommitmentStatus(commitmentId, 'kept', commitmentRecipientId);
                this.logger.info({ commitmentId }, 'Commitment marked as kept');
                this.metrics.counter('commitments_kept');
              }
            } else if (action === 'mark_repaired') {
              // Update commitment status to repaired with note
              if (commitmentId) {
                void this.updateCommitmentStatus(
                  commitmentId,
                  'repaired',
                  commitmentRecipientId,
                  repairNote
                );
                this.logger.info({ commitmentId, repairNote }, 'Commitment marked as repaired');
                this.metrics.counter('commitments_repaired');
              }
            } else if (action === 'cancel') {
              // Update commitment status to cancelled
              if (commitmentId) {
                void this.updateCommitmentStatus(commitmentId, 'cancelled', commitmentRecipientId);
                this.logger.info({ commitmentId }, 'Commitment cancelled');
                this.metrics.counter('commitments_cancelled');
              }
            }
            break;
          }

          case 'DESIRE': {
            const {
              action,
              desireId,
              want,
              intensity,
              source,
              evidence,
              recipientId: desireRecipientId,
            } = intent.payload;
            const trace = intent.trace;

            if (!this.memoryProvider) {
              this.logger.warn({ action }, 'DESIRE skipped: no MemoryProvider');
              break;
            }

            if (action === 'create') {
              if (!desireId || !want) {
                this.logger.error({ desireId, want }, 'DESIRE create: missing fields');
                break;
              }

              // Store desire as MemoryEntry
              const entry: MemoryEntry = {
                id: desireId,
                type: 'fact',
                content: want,
                timestamp: new Date(),
                recipientId: desireRecipientId,
                tags: ['desire', 'state:active'],
                confidence: intensity ?? 0.5,
                metadata: {
                  kind: 'desire',
                  intensity: intensity ?? 0.5,
                  source: source ?? 'self_inference',
                  evidence: evidence ?? '',
                  createdAt: new Date().toISOString(),
                },
                tickId: trace?.tickId,
                parentSignalId: trace?.parentSignalId,
              };

              this.memoryProvider.save(entry).catch((err: unknown) => {
                this.logger.error(
                  { desireId, error: err instanceof Error ? err.message : String(err) },
                  'Failed to save desire'
                );
              });

              this.logger.info(
                { desireId, want: want.slice(0, 50), intensity, source },
                'Desire created'
              );
              this.metrics.counter('desires_created', { source: source ?? 'self_inference' });
            } else if (action === 'adjust') {
              // Update desire intensity
              if (desireId) {
                void this.updateDesireStatus(desireId, 'active', desireRecipientId, intensity);
                this.logger.info({ desireId, intensity }, 'Desire intensity adjusted');
                this.metrics.counter('desires_adjusted');
              }
            } else if (action === 'resolve') {
              // Mark desire as satisfied
              if (desireId) {
                void this.updateDesireStatus(desireId, 'satisfied', desireRecipientId);
                this.logger.info({ desireId }, 'Desire resolved');
                this.metrics.counter('desires_resolved');
              }
            }
            break;
          }

          case 'PERSPECTIVE': {
            const {
              action,
              opinionId,
              predictionId,
              topic,
              stance,
              rationale,
              confidence,
              claim,
              horizonAt,
              outcome,
              recipientId: perspectiveRecipientId,
            } = intent.payload;
            const trace = intent.trace;

            if (!this.memoryProvider) {
              this.logger.warn({ action }, 'PERSPECTIVE skipped: no MemoryProvider');
              break;
            }

            if (action === 'set_opinion') {
              if (!opinionId || !topic || !stance) {
                this.logger.error(
                  { opinionId, topic, stance },
                  'PERSPECTIVE set_opinion: missing fields'
                );
                break;
              }

              // Store opinion as MemoryEntry
              const entry: MemoryEntry = {
                id: opinionId,
                type: 'fact',
                content: `${topic}: ${stance}`,
                timestamp: new Date(),
                recipientId: perspectiveRecipientId,
                tags: ['opinion', 'state:active'],
                confidence: confidence ?? 0.7,
                metadata: {
                  kind: 'opinion',
                  topic,
                  stance,
                  rationale: rationale ?? '',
                  confidence: confidence ?? 0.7,
                  createdAt: new Date().toISOString(),
                },
                tickId: trace?.tickId,
                parentSignalId: trace?.parentSignalId,
              };

              this.memoryProvider.save(entry).catch((err: unknown) => {
                this.logger.error(
                  { opinionId, error: err instanceof Error ? err.message : String(err) },
                  'Failed to save opinion'
                );
              });

              this.logger.info(
                { opinionId, topic, stance: stance.slice(0, 50), confidence },
                'Opinion created'
              );
              this.metrics.counter('opinions_created');
            } else if (action === 'predict') {
              if (!predictionId || !claim || !horizonAt) {
                this.logger.error(
                  { predictionId, claim, horizonAt },
                  'PERSPECTIVE predict: missing fields'
                );
                break;
              }

              // Store prediction as MemoryEntry
              const entry: MemoryEntry = {
                id: predictionId,
                type: 'fact',
                content: claim,
                timestamp: new Date(),
                recipientId: perspectiveRecipientId,
                tags: ['prediction', 'state:pending'],
                confidence: confidence ?? 0.6,
                metadata: {
                  kind: 'prediction',
                  claim,
                  horizonAt: horizonAt.toISOString(),
                  confidence: confidence ?? 0.6,
                  status: 'pending',
                  createdAt: new Date().toISOString(),
                },
                tickId: trace?.tickId,
                parentSignalId: trace?.parentSignalId,
              };

              this.memoryProvider.save(entry).catch((err: unknown) => {
                this.logger.error(
                  { predictionId, error: err instanceof Error ? err.message : String(err) },
                  'Failed to save prediction'
                );
              });

              this.logger.info(
                { predictionId, claim: claim.slice(0, 50), horizonAt, confidence },
                'Prediction created'
              );
              this.metrics.counter('predictions_created');
            } else if (action === 'resolve_prediction') {
              if (predictionId && outcome) {
                void this.updatePredictionStatus(predictionId, outcome, perspectiveRecipientId);
                this.logger.info({ predictionId, outcome }, 'Prediction resolved');
                this.metrics.counter('predictions_resolved', { outcome });
              }
            } else if (action === 'revise_opinion') {
              if (opinionId) {
                void this.updateOpinionStatus(
                  opinionId,
                  stance,
                  confidence,
                  perspectiveRecipientId
                );
                this.logger.info({ opinionId }, 'Opinion revised');
                this.metrics.counter('opinions_revised');
              }
            }
            break;
          }
        }
      });
    }
  }

  /**
   * Update prediction status in memory.
   * If prediction is missed, enqueues a reflection thought.
   */
  private async updatePredictionStatus(
    predictionId: string,
    outcome: 'confirmed' | 'missed' | 'mixed',
    _recipientId?: string
  ): Promise<void> {
    if (!this.memoryProvider) return;

    try {
      const prediction = await this.memoryProvider.getById(predictionId);
      if (!prediction) {
        this.logger.warn({ predictionId }, 'Prediction not found for status update');
        return;
      }

      const claim = prediction.content;

      // Update tags
      const oldTags = prediction.tags ?? [];
      const newTags = oldTags.filter((t) => !t.startsWith('state:'));
      newTags.push(`state:${outcome}`);

      // Update metadata
      const metadata = {
        ...(prediction.metadata ?? {}),
        status: outcome,
        resolvedAt: new Date().toISOString(),
      };

      const updatedEntry: MemoryEntry = {
        ...prediction,
        tags: newTags,
        metadata,
      };

      await this.memoryProvider.save(updatedEntry);

      // Clear from due dedup set so it won't block future signals
      this.signaledDuePredictions.delete(predictionId);

      // If missed, enqueue reflection thought (Phase 7.2)
      if (outcome === 'missed') {
        const thoughtContent = `My prediction was wrong: "${claim}". What can I learn from this?`;
        this.enqueueThoughtSignal(
          {
            kind: 'thought',
            content: thoughtContent,
            triggerSource: 'memory',
            depth: 0,
            rootThoughtId: `pred_missed_${predictionId}`,
          },
          'cognition.thought'
        );
        this.logger.info(
          { predictionId, claim },
          'Reflection thought enqueued for missed prediction'
        );
      }
    } catch (err) {
      this.logger.error(
        { predictionId, outcome, error: err instanceof Error ? err.message : String(err) },
        'Failed to update prediction status'
      );
    }
  }

  /** Validation count threshold for promoting an opinion to a soul precedent */
  private static readonly OPINION_PROMOTION_THRESHOLD = 3;

  /**
   * Update opinion status in memory.
   *
   * Tracks validation count: when an opinion is revised with same-or-higher
   * confidence, it counts as a validation. After reaching the promotion
   * threshold, the opinion is promoted to a soul precedent (case law).
   */
  private async updateOpinionStatus(
    opinionId: string,
    newStance?: string,
    newConfidence?: number,
    _recipientId?: string
  ): Promise<void> {
    if (!this.memoryProvider) return;

    try {
      const opinion = await this.memoryProvider.getById(opinionId);
      if (!opinion) {
        this.logger.warn({ opinionId }, 'Opinion not found for status update');
        return;
      }

      const oldConfidence =
        typeof opinion.metadata?.['confidence'] === 'number' ? opinion.metadata['confidence'] : 0.5;
      const oldValidationCount =
        typeof opinion.metadata?.['validationCount'] === 'number'
          ? opinion.metadata['validationCount']
          : 0;

      // A revision with same-or-higher confidence counts as validation
      const isValidation = newConfidence !== undefined && newConfidence >= oldConfidence;
      const newValidationCount = isValidation ? oldValidationCount + 1 : oldValidationCount;

      // Update metadata
      const metadata: Record<string, unknown> = {
        ...(opinion.metadata ?? {}),
        previousStance: opinion.metadata?.['stance'],
        revisedAt: new Date().toISOString(),
        validationCount: newValidationCount,
      };

      if (newStance) {
        metadata['stance'] = newStance;
      }
      if (newConfidence !== undefined) {
        metadata['confidence'] = newConfidence;
      }

      const topicValue = opinion.metadata?.['topic'];
      const topic = typeof topicValue === 'string' ? topicValue : 'topic';
      const stance =
        typeof metadata['stance'] === 'string'
          ? metadata['stance']
          : typeof opinion.metadata?.['stance'] === 'string'
            ? opinion.metadata['stance']
            : '';

      const updatedEntry: MemoryEntry = {
        ...opinion,
        content: newStance ? `${topic}: ${newStance}` : opinion.content,
        metadata,
      };

      await this.memoryProvider.save(updatedEntry);

      // Promote to soul precedent if validation threshold reached
      if (
        newValidationCount >= CoreLoop.OPINION_PROMOTION_THRESHOLD &&
        oldValidationCount < CoreLoop.OPINION_PROMOTION_THRESHOLD &&
        this.soulProvider
      ) {
        const rationale =
          typeof opinion.metadata?.['rationale'] === 'string' ? opinion.metadata['rationale'] : '';

        const precedent: Precedent = {
          id: `prec_${opinionId}`,
          situation: `Forming a view on: ${topic}`,
          choice: stance,
          reasoning:
            rationale || `Validated ${String(newValidationCount)} times through experience`,
          valuesPrioritized: ['honesty', 'informed_judgment'],
          outcome: 'helped',
          binding: false, // Non-binding — can be overridden by stronger evidence
          scopeConditions: [`topic:${topic}`],
          createdAt: new Date(),
        };

        await this.soulProvider.addPrecedent(precedent);

        this.logger.info(
          { opinionId, topic, validationCount: newValidationCount, precedentId: precedent.id },
          'Opinion promoted to soul precedent (case law)'
        );
        this.metrics.counter('opinions_promoted_to_precedent');
      }
    } catch (err) {
      this.logger.error(
        { opinionId, error: err instanceof Error ? err.message : String(err) },
        'Failed to update opinion status'
      );
    }
  }

  /**
   * Update desire status in memory.
   * Helper method for DESIRE intent handling.
   */
  private async updateDesireStatus(
    desireId: string,
    status: 'active' | 'satisfied' | 'stale' | 'dropped',
    _recipientId?: string,
    newIntensity?: number
  ): Promise<void> {
    if (!this.memoryProvider) return;

    try {
      const desire = await this.memoryProvider.getById(desireId);
      if (!desire) {
        this.logger.warn({ desireId }, 'Desire not found for status update');
        return;
      }

      // Update tags (remove old state, add new state)
      const oldTags = desire.tags ?? [];
      const newTags = oldTags.filter((t) => !t.startsWith('state:'));
      newTags.push(`state:${status}`);

      // Update metadata
      const metadata = {
        ...(desire.metadata ?? {}),
        status,
        [`${status}At`]: new Date().toISOString(),
      };

      if (newIntensity !== undefined) {
        metadata['intensity'] = newIntensity;
      }

      // Save updated entry
      const updatedEntry: MemoryEntry = {
        ...desire,
        tags: newTags,
        metadata,
      };

      await this.memoryProvider.save(updatedEntry);
    } catch (err) {
      this.logger.error(
        { desireId, status, error: err instanceof Error ? err.message : String(err) },
        'Failed to update desire status'
      );
    }
  }

  /**
   * Update commitment status in memory.
   * Helper method for COMMITMENT intent handling.
   */
  private async updateCommitmentStatus(
    commitmentId: string,
    status: 'kept' | 'breached' | 'repaired' | 'cancelled',
    recipientId?: string,
    repairNote?: string
  ): Promise<void> {
    if (!this.memoryProvider) return;

    try {
      const commitment = await this.memoryProvider.getById(commitmentId);
      if (!commitment) {
        this.logger.warn({ commitmentId }, 'Commitment not found for status update');
        return;
      }

      // Update tags (remove old state, add new state)
      const oldTags = commitment.tags ?? [];
      const newTags = oldTags.filter((t) => !t.startsWith('state:'));
      newTags.push(`state:${status}`);

      // Update metadata
      const metadata = {
        ...(commitment.metadata ?? {}),
        status,
        [`${status}At`]: new Date().toISOString(),
      };

      if (repairNote) {
        metadata['repairNote'] = repairNote;
      }

      // Save updated entry
      const updatedEntry: MemoryEntry = {
        ...commitment,
        tags: newTags,
        metadata,
      };

      await this.memoryProvider.save(updatedEntry);

      // Clear from dedup sets so it won't block future signals if re-activated
      this.signaledDueCommitments.delete(commitmentId);
      this.signaledOverdueCommitments.delete(commitmentId);

      // Record completed action for kept/repaired
      if (recipientId && this.conversationManager && (status === 'kept' || status === 'repaired')) {
        const summary = `commitment ${status}: "${commitment.content.slice(0, 30)}..."`;
        this.conversationManager
          .addCompletedAction(recipientId, {
            tool: 'core.commitment',
            summary,
          })
          .catch((err: unknown) => {
            this.logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              'Failed to record completed action for commitment update'
            );
          });
      }
    } catch (err) {
      this.logger.error(
        { commitmentId, status, error: err instanceof Error ? err.message : String(err) },
        'Failed to update commitment status'
      );
    }
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
   * Parse a delta value from string.
   * Accepts formats: "+0.2", "-0.1", "0.3" (treated as +0.3)
   * Returns null if parsing fails.
   */
  private parseDelta(value: unknown): number | null {
    const str = String(value).trim();
    const num = parseFloat(str);
    if (Number.isNaN(num)) return null;
    // Clamp delta to reasonable range (-1 to +1)
    return Math.max(-1, Math.min(1, num));
  }

  /**
   * Intensity-to-delta mapping for SET_INTEREST intent.
   */
  private static readonly INTENSITY_DELTAS: Record<InterestIntensity, number> = {
    strong_positive: 0.5,
    weak_positive: 0.2,
    weak_negative: -0.2,
    strong_negative: -0.5,
  };

  /**
   * Save agent message to conversation history.
   * When tool call data is present, saves as a full turn (assistant + tool results).
   */
  private async saveAgentMessage(
    chatId: string,
    text: string,
    conversationStatus?: 'active' | 'awaiting_answer' | 'closed' | 'idle',
    channelMeta?: {
      channelMessageId?: string;
      channel?: string;
    }
  ): Promise<void> {
    if (!this.conversationManager) return;

    try {
      // Only save the final response text - tool calls are internal to the agentic loop
      // This keeps conversation history clean: user messages, reactions, and assistant responses
      await this.conversationManager.addMessage(
        chatId,
        {
          role: 'assistant',
          content: text,
        },
        channelMeta
      );

      // Use inline status if provided, otherwise fall back to LLM classification
      if (conversationStatus) {
        await this.conversationManager.setStatus(chatId, conversationStatus);
      } else if (this.messageComposer) {
        // Fallback: classify via separate LLM call (legacy path)
        const classification = await this.messageComposer.classifyConversationStatus(text);
        await this.conversationManager.setStatus(chatId, classification.status);
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), chatId },
        'Failed to save agent message'
      );
    }
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
   * Wake up the loop immediately.
   */
  wakeUp(): void {
    if (!this.running) return;

    if (this.tickTimeout) {
      clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }

    // Schedule immediate tick
    this.tickTimeout = setTimeout(() => {
      void this.tick();
    }, 0);

    this.logger.debug('Core loop woken up');
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
