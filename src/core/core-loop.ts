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
  Event,
  ThoughtData,
  InterestIntensity,
  MessageReactionData,
} from '../types/index.js';
import { createSignal, THOUGHT_LIMITS } from '../types/signal.js';
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
import type { MemoryProvider } from '../layers/cognition/tools/registry.js';
import type { MemoryConsolidator } from '../storage/memory-consolidator.js';
import type { SoulProvider } from '../storage/soul-provider.js';
import type { AlertnessMode } from '../types/agent/state.js';
import type { SchedulerService } from './scheduler-service.js';
import type { IRecipientRegistry } from './recipient-registry.js';

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
    // tickId for batch grouping in logs (NOT causal tracing - use parentId for that)
    const tickId = randomUUID();

    // Apply pending plugin changes FIRST (before any processing)
    // This handles queued scheduler unregistrations from pause/unload
    this.schedulerService?.applyPendingChanges();

    // Check system health - determines which layers are active
    const health = this.healthMonitor.getHealth();
    const { activeLayers, stressLevel } = health;

    const state = this.agent.getState();
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

    try {
      // Collect all intents from all layers
      const allIntents: Intent[] = [];
      let allSignals: Signal[] = [];

      // 1. Collect incoming signals from channels (sensory input)
      // Enriches reaction signals with message previews (async)
      const incomingSignals = await this.collectIncomingSignals();

      // 1b. Update thought pressure before neurons run
      // This allows ThoughtsNeuron to see current pressure
      await this.updateThoughtPressure();

      // 2. AUTONOMIC: neurons check state, emit internal signals
      // Always runs - vital signs monitoring
      if (activeLayers.autonomic) {
        const autonomicResult = await this.processAutonomic(incomingSignals, tickId);
        allIntents.push(...autonomicResult.intents);
        allSignals = autonomicResult.signals;
      } else {
        // Critical stress - just pass through incoming signals
        allSignals = incomingSignals;
        this.logger.warn({ stressLevel }, 'AUTONOMIC layer disabled due to stress');
      }

      // 2b. Defer thought signals if COGNITION is busy
      // Thought signals need COGNITION to process them, so if COGNITION is busy,
      // re-queue them for the next tick rather than losing them in AGGREGATION
      const hasThoughtSignals = allSignals.some((s) => s.type === 'thought');
      if (this.pendingCognition && hasThoughtSignals) {
        const thoughtSignals = allSignals.filter((s) => s.type === 'thought');
        const otherSignals = allSignals.filter((s) => s.type !== 'thought');

        this.logger.debug(
          { pendingThoughts: thoughtSignals.length },
          'COGNITION busy, deferring thought signals to next tick'
        );

        // Re-queue thoughts at the front for next tick (FIFO order preserved)
        for (let i = thoughtSignals.length - 1; i >= 0; i--) {
          const signal = thoughtSignals[i];
          if (signal) {
            this.pendingSignals.unshift({ signal, timestamp: new Date() });
          }
        }

        // Continue with non-thought signals only
        allSignals = otherSignals;
      }

      // 3. AGGREGATION: collect signals, decide if COGNITION should wake
      let aggregationResult: AggregationResult | null = null;

      if (activeLayers.aggregation) {
        aggregationResult = await this.processAggregation(allSignals);
        allIntents.push(...aggregationResult.intents);
      } else {
        this.logger.warn({ stressLevel }, 'AGGREGATION layer disabled due to stress');
      }

      // 4. COGNITION: (if woken) process with fast LLM (NON-BLOCKING)
      let cognitionResult: CognitionResult | null = null;
      // Check if pending COGNITION completed
      if (this.pendingCognition) {
        const result = await this.checkPendingCognition();
        if (result) {
          cognitionResult = result;
          allIntents.push(...result.intents);
        }
      }

      const shouldWakeCognition = aggregationResult?.wakeCognition && activeLayers.cognition;

      // Only start new COGNITION if no pending operation
      if (shouldWakeCognition && aggregationResult && !this.pendingCognition) {
        this.logger.debug(
          { wakeReason: aggregationResult.wakeReason },
          '🧠 COGNITION layer woken (non-blocking)'
        );

        // Pass enableSmartRetry based on activeLayers.smart (reuses health gating)
        const cognitionContext = this.buildCognitionContext(
          aggregationResult,
          tickId,
          activeLayers.smart
        );

        // Start COGNITION in background (non-blocking)
        this.startCognitionAsync(cognitionContext, aggregationResult.triggerSignals[0]);
      } else if (this.pendingCognition && shouldWakeCognition) {
        // Already processing - thought signals were already re-queued in step 2b above
        // This path handles user_message signals which can overlap with pending COGNITION
        this.logger.debug('COGNITION already processing, waiting for completion');
      }

      if (aggregationResult?.wakeCognition && !activeLayers.cognition) {
        this.logger.warn(
          { stressLevel, wakeReason: aggregationResult.wakeReason },
          'COGNITION layer disabled due to stress - wake blocked'
        );
      }

      // 6. Update agent state (energy, social debt, etc.)
      const agentIntents = this.agent.tick();
      allIntents.push(...agentIntents);

      // 6b. Check for sleep mode transition - trigger memory consolidation
      const currentMode = this.agent.getAlertnessMode();
      if (
        this.memoryConsolidator &&
        this.memoryProvider &&
        currentMode === 'sleep' &&
        this.previousAlertnessMode !== 'sleep'
      ) {
        // Entering sleep mode - consolidate memories (like human sleep)
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

          // Create and queue thought signals from consolidation
          // Uses shared enqueue logic with budget/dedupe checks
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
      }
      this.previousAlertnessMode = currentMode;

      // 7. Update user model beliefs (time-based decay)
      if (this.userModel) {
        this.userModel.updateTimeBasedBeliefs();
      }

      // 7b. Check conversation status decay (active/awaiting_answer → idle after timeout)
      if (this.conversationManager && this.primaryRecipientId) {
        await this.checkConversationDecay();
      }

      // 7c. Check plugin schedulers for due events
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

      // 8. Apply all intents
      this.applyIntents(allIntents);

      // 9. Periodic maintenance (only if aggregation is active)
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

      // Update metrics
      this.metrics.counter('signal_loop_ticks');
      this.metrics.gauge('signal_loop_tick_duration', tickDuration);
      this.metrics.gauge('signal_loop_signals_processed', allSignals.length);
      this.metrics.gauge('system_event_loop_lag_ms', health.eventLoopLagMs);
      this.metrics.gauge('system_cpu_percent', health.cpuPercent);
      this.metrics.gauge('system_stress_level', this.stressLevelToNumber(stressLevel));

      // Schedule next tick
      this.scheduleTick();
    } catch (error) {
      // Serialize error properly for logging (pino doesn't serialize all error types well)
      const errorDetails =
        error instanceof Error
          ? { message: error.message, stack: error.stack, name: error.name }
          : { raw: String(error), type: typeof error };

      this.logger.error({ error: errorDetails, tick: this.tickCount }, 'Tick failed');

      // Continue running despite error
      this.scheduleTick();
    }
  }

  /**
   * Collect incoming signals from pending queue.
   * Enriches reaction signals with message previews asynchronously.
   */
  private async collectIncomingSignals(): Promise<Signal[]> {
    const signals: Signal[] = [];
    const maxSignals = this.config.maxSignalsPerTick;

    while (this.pendingSignals.length > 0 && signals.length < maxSignals) {
      const pending = this.pendingSignals.shift();
      if (pending) {
        let signal = pending.signal;

        // Special handling for user messages
        if (signal.type === 'user_message') {
          this.processUserMessageSignal(signal);
        }

        // Enrich reaction signals with message preview (async lookup)
        if (signal.type === 'message_reaction') {
          signal = await this.enrichReactionSignal(signal);
        }

        signals.push(signal);
      }
    }

    return signals;
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
    return {
      aggregates: aggregationResult.aggregates,
      triggerSignals: aggregationResult.triggerSignals,
      wakeReason: aggregationResult.wakeReason ?? 'unknown',
      agentState: this.agent.getState(),
      tickId,
      runtimeConfig: {
        enableSmartRetry,
      },
    };
  }

  /**
   * Start COGNITION processing asynchronously (non-blocking).
   */
  private startCognitionAsync(context: CognitionContext, triggerSignal: Signal | undefined): void {
    const startedAt = Date.now();

    // Create promise for COGNITION processing
    const promise = this.layers.cognition.process(context);

    this.pendingCognition = {
      promise,
      tickId: context.tickId,
      startedAt,
      triggerSignal: triggerSignal ?? context.triggerSignals[0] ?? undefined,
    };

    // Handle completion in background (don't await here)
    promise
      .then(() => {
        this.logger.debug(
          {
            tickId: context.tickId,
            duration: Date.now() - startedAt,
          },
          'COGNITION completed (async)'
        );
      })
      .catch((error: unknown) => {
        this.logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            tickId: context.tickId,
          },
          'COGNITION failed (async)'
        );
        // Clear pending on error
        this.pendingCognition = null;
      });
  }

  /**
   * Check if pending COGNITION completed and return result.
   * Returns null if still processing.
   */
  private async checkPendingCognition(): Promise<CognitionResult | null> {
    if (!this.pendingCognition) return null;

    // Check if promise is settled (non-blocking check using Promise.race)
    const pending = this.pendingCognition;
    const timeoutPromise = new Promise<'pending'>((resolve) => {
      // Resolve immediately to check if cognition is done
      setImmediate(() => {
        resolve('pending');
      });
    });

    try {
      const result = await Promise.race([pending.promise, timeoutPromise]);

      if (result === 'pending') {
        // Still processing
        const elapsed = Date.now() - pending.startedAt;
        if (elapsed > 5000 && elapsed % 5000 < 1000) {
          // Log every ~5 seconds
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
                channel.sendTyping(route.destination).catch(() => {
                  /* ignore typing errors */
                });
              }
            }
          }
        }
        return null;
      }

      // Completed - clear pending and return result
      this.pendingCognition = null;
      return result;
    } catch (error) {
      // COGNITION rejected - clear pending and log error
      this.pendingCognition = null;
      this.logger.error({ error, tickId: pending.tickId }, 'COGNITION rejected unexpectedly');
      return null;
    }
  }

  /**
   * Apply a single intent immediately.
   * Used as callback for AgenticLoop to apply REMEMBER and SET_INTEREST intents
   * during loop execution so subsequent tools can see the data.
   */
  applyImmediateIntent(intent: Intent): void {
    // Only apply REMEMBER and SET_INTEREST immediately
    // Other intents should wait for normal intent processing
    if (intent.type !== 'REMEMBER' && intent.type !== 'SET_INTEREST') {
      this.logger.warn(
        { intentType: intent.type },
        'applyImmediateIntent called with non-immediate intent type, ignoring'
      );
      return;
    }
    this.applyIntents([intent]);
  }

  /**
   * Apply intents from all layers.
   */
  private applyIntents(intents: Intent[]): void {
    for (const intent of intents) {
      switch (intent.type) {
        case 'UPDATE_STATE':
          this.agent.applyIntent(intent);
          break;

        case 'SEND_MESSAGE': {
          const { recipientId, text, replyTo, conversationStatus, toolCalls, toolResults } =
            intent.payload;

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

          const sendOptions = replyTo ? { replyTo } : undefined;
          // Wrap in Promise.resolve to catch both sync throws and async rejections
          Promise.resolve()
            .then(() => channelImpl.sendMessage(route.destination, text, sendOptions))
            .then((result) => {
              if (result.success) {
                this.lastMessageSentAt = Date.now();
                // Use recipientId (not route.destination) for tracking - matches processResponseTiming
                this.lastMessageRecipientId = recipientId;
                this.metrics.counter('messages_sent', { channel: route.channel });

                // Notify agent that message was sent (relieves social pressure)
                this.agent.onMessageSent();

                if (this.conversationManager) {
                  // Use recipientId as conversation key for consistency
                  // Pass tool call data for full turn preservation
                  // Include channel metadata for reaction lookup
                  void this.saveAgentMessage(
                    recipientId,
                    text,
                    conversationStatus,
                    toolCalls,
                    toolResults,
                    result.messageId
                      ? { channelMessageId: result.messageId, channel: route.channel }
                      : undefined
                  );
                }
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
            // Build memory entry from fact or content
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
                type: memoryType as 'fact' | 'thought' | 'message',
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

          // For thought signals, mark the specific signal ID as handled
          // Note: This is in-memory only (won't persist across restarts)
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

          // Get current value if not provided
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
          const { content, triggerSource, depth, rootThoughtId, parentThoughtId, signalSource } =
            intent.payload;

          // Build thought data
          const thoughtData: ThoughtData = {
            kind: 'thought',
            content,
            triggerSource,
            depth,
            rootThoughtId,
            ...(parentThoughtId !== undefined && { parentThoughtId }),
          };

          // Use shared enqueue logic with budget check
          // Deduplication handled by AGGREGATION layer
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

          // 1. If user fact → update UserModel
          if (isUserFact && this.userModel) {
            // Check if value is a delta for numeric properties
            const strValue = value.trim();
            const isDelta = strValue.startsWith('+') || strValue.startsWith('-');
            const deltaNum = isDelta ? this.parseDelta(value) : null;

            if (isDelta && deltaNum !== null) {
              // Apply delta to current value
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
              // Store as-is (string or absolute value)
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

          // 2. Always store in memory for semantic search
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
              { subject, attribute, tickId: trace?.tickId, parentSignalId: trace?.parentSignalId },
              'Memory stored'
            );
          }

          // 3. Record completed action to prevent LLM re-execution
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

          // Validate topic is a string
          if (typeof topic !== 'string' || topic.length === 0) {
            this.logger.error({ topic, intensity }, 'SET_INTEREST: invalid topic');
            break;
          }

          // Split comma-separated keywords into individual entries
          // "отключения,газ,вода" → ["отключения", "газ", "вода"]
          const keywords = topic
            .split(',')
            .map((kw) => kw.trim().toLowerCase())
            .filter((kw) => kw.length >= 2); // Skip empty or single-char

          if (keywords.length === 0) {
            this.logger.error({ topic, intensity }, 'SET_INTEREST: no valid keywords');
            break;
          }

          // Get delta from intensity enum
          const delta = CoreLoop.INTENSITY_DELTAS[intensity];
          const interests = this.userModel.getInterests();

          // Store each keyword as a separate interest entry
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

          // Record completed action to prevent LLM re-execution
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
          break;
        }
      }
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
    toolCalls?: {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }[],
    toolResults?: {
      tool_call_id: string;
      content: string;
    }[],
    channelMeta?: {
      channelMessageId?: string;
      channel?: string;
    }
  ): Promise<void> {
    if (!this.conversationManager) return;

    try {
      // Use addTurn when we have tool call data (preserves OpenAI format)
      if (toolCalls && toolCalls.length > 0) {
        await this.conversationManager.addTurn(
          chatId,
          {
            content: text,
            tool_calls: toolCalls,
          },
          toolResults,
          channelMeta
        );
      } else {
        // Simple message without tool calls
        await this.conversationManager.addMessage(
          chatId,
          {
            role: 'assistant',
            content: text,
          },
          channelMeta
        );
      }

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
