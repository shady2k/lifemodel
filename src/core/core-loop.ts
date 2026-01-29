/**
 * CoreLoop - the heartbeat of the 4-layer agent architecture.
 *
 * Unlike the EventLoop which uses dynamic tick intervals, CoreLoop:
 * - Uses a fixed 1-second tick (like a steady heartbeat)
 * - Processes Signals (not Events) through the 4-layer pipeline
 * - Channels act as "sensory organs" that emit Signals
 *
 * Pipeline per tick:
 * 1. Collect signals from sensory organs (channels)
 * 2. AUTONOMIC: neurons check state, emit internal signals
 * 3. AGGREGATION: collect signals, decide if COGNITION should wake
 * 4. COGNITION: (if woken) process with fast LLM, decide action or escalate
 * 5. SMART: (if escalated) process with expensive LLM
 * 6. Apply intents from all layers
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
} from '../types/index.js';
import { createSignal, THOUGHT_LIMITS } from '../types/signal.js';
import type {
  AutonomicResult,
  AggregationResult,
  CognitionResult,
  SmartResult,
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
import type { SmartProcessor } from '../layers/smart/processor.js';
import type { MessageComposer } from '../llm/composer.js';
import type { ConversationManager } from '../storage/conversation-manager.js';
import type { UserModel } from '../models/user-model.js';
import type { CognitionLLM } from '../layers/cognition/agentic-loop.js';
import type { MemoryProvider } from '../layers/cognition/tools/registry.js';
import type { MemoryConsolidator } from '../storage/memory-consolidator.js';
import type { AlertnessMode } from '../types/agent/state.js';
import type { SchedulerService } from './scheduler-service.js';

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
 * Layer processors for the 4-layer pipeline.
 */
export interface CoreLoopLayers {
  autonomic: AutonomicProcessor;
  aggregation: AggregationProcessor;
  cognition: CognitionProcessor;
  smart: SmartProcessor;
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
  correlationId: string;
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

  /** Previous alertness mode for detecting transitions */
  private previousAlertnessMode: AlertnessMode | undefined;

  /** Subscription ID for typing events */
  private typingSubscriptionId: string | null = null;

  /** Timestamp of last message sent (for response timing) */
  private lastMessageSentAt: number | null = null;
  private lastMessageChatId: string | null = null;

  /** Pending COGNITION operation (non-blocking) */
  private pendingCognition: PendingCognition | null = null;

  /** Scheduler service for plugin timers */
  private schedulerService: SchedulerService | null = null;

  /** Track thoughts emitted per tick for budget enforcement */
  private thoughtsThisTick = 0;

  /** Recent thought deduplication keys with timestamps */
  private recentThoughtKeys = new Map<string, number>();

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

    // Initialize system health monitor
    this.healthMonitor = createSystemHealthMonitor(logger, config.health);

    // Set dependencies on layers
    this.layers.cognition.setDependencies({
      composer: deps.messageComposer,
      conversationManager: deps.conversationManager,
      userModel: deps.userModel,
      eventBus,
      agent: deps.agent,
      cognitionLLM: deps.cognitionLLM,
      memoryProvider: deps.memoryProvider,
    });

    this.layers.smart.setDependencies({
      composer: deps.messageComposer,
      conversationManager: deps.conversationManager,
      userModel: deps.userModel,
      eventBus,
    });

    // Set dependencies on AGGREGATION for conversation-aware proactive contact
    if ('updateDeps' in this.layers.aggregation) {
      (this.layers.aggregation as { updateDeps: (deps: unknown) => void }).updateDeps({
        conversationManager: deps.conversationManager,
        userModel: deps.userModel,
        primaryUserChatId: config.primaryUserChatId,
      });
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
    const correlationId = `tick-${String(this.tickCount)}-${randomUUID().slice(0, 8)}`;

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
        correlationId,
      },
      '⏱️ Tick starting'
    );

    try {
      // Collect all intents from all layers
      const allIntents: Intent[] = [];
      let allSignals: Signal[] = [];

      // 1. Collect incoming signals from channels (sensory input)
      const incomingSignals = this.collectIncomingSignals();

      // 2. AUTONOMIC: neurons check state, emit internal signals
      // Always runs - vital signs monitoring
      if (activeLayers.autonomic) {
        const autonomicResult = await this.processAutonomic(incomingSignals, correlationId);
        allIntents.push(...autonomicResult.intents);
        allSignals = autonomicResult.signals;
      } else {
        // Critical stress - just pass through incoming signals
        allSignals = incomingSignals;
        this.logger.warn({ stressLevel }, 'AUTONOMIC layer disabled due to stress');
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
      let smartResult: SmartResult | null = null;

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

        const cognitionContext = this.buildCognitionContext(aggregationResult, correlationId);

        // Start COGNITION in background (non-blocking)
        this.startCognitionAsync(cognitionContext, aggregationResult.triggerSignals[0]);
      } else if (this.pendingCognition && shouldWakeCognition) {
        // Already processing, log that we're queueing
        this.logger.debug('COGNITION already processing, new wake request queued');
      }

      // 5. SMART: (if COGNITION completed and escalated) process with expensive LLM
      if (cognitionResult?.escalateToSmart && cognitionResult.smartContext && activeLayers.smart) {
        this.logger.debug(
          { escalationReason: cognitionResult.escalationReason },
          '🎯 SMART layer engaged'
        );

        smartResult = await this.layers.smart.process(cognitionResult.smartContext);
        allIntents.push(...smartResult.intents);
      } else if (cognitionResult?.escalateToSmart && !activeLayers.smart) {
        this.logger.warn(
          { stressLevel, escalationReason: cognitionResult.escalationReason },
          'SMART layer disabled due to stress - escalation blocked'
        );
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

      // 7b. Check plugin schedulers for due events
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
          smartEngaged: smartResult !== null,
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
      this.logger.error({ error, tick: this.tickCount }, 'Tick failed');

      // Continue running despite error
      this.scheduleTick();
    }
  }

  /**
   * Collect incoming signals from pending queue.
   */
  private collectIncomingSignals(): Signal[] {
    const signals: Signal[] = [];
    const maxSignals = this.config.maxSignalsPerTick;

    while (this.pendingSignals.length > 0 && signals.length < maxSignals) {
      const pending = this.pendingSignals.shift();
      if (pending) {
        signals.push(pending.signal);

        // Special handling for user messages
        if (pending.signal.type === 'user_message') {
          this.processUserMessageSignal(pending.signal);
        }
      }
    }

    return signals;
  }

  /**
   * Process user message signal for side effects.
   */
  private processUserMessageSignal(signal: Signal): void {
    // Note: Ack clearing is now handled by ThresholdEngine when it sees user_message

    // Update user model
    if (this.userModel) {
      this.userModel.processSignal('message_received');
      this.processResponseTiming(signal);
    }

    // Save to conversation history
    if (this.conversationManager) {
      const data = signal.data as { text?: string; chatId?: string } | undefined;
      if (data?.text && data.chatId) {
        void this.conversationManager.addMessage(data.chatId, {
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

    const data = signal.data as { chatId?: string } | undefined;
    if (!data?.chatId || data.chatId !== this.lastMessageChatId) {
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
    this.lastMessageChatId = null;

    this.metrics.histogram('user_response_time_ms', responseTimeMs);
  }

  /**
   * Process through AUTONOMIC layer.
   */
  private processAutonomic(
    incomingSignals: Signal[],
    correlationId: string
  ): AutonomicResult | Promise<AutonomicResult> {
    const state = this.agent.getState();
    return this.layers.autonomic.process(state, incomingSignals, correlationId);
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
    correlationId: string
  ): CognitionContext {
    return {
      aggregates: aggregationResult.aggregates,
      triggerSignals: aggregationResult.triggerSignals,
      wakeReason: aggregationResult.wakeReason ?? 'unknown',
      agentState: this.agent.getState(),
      correlationId,
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
      correlationId: context.correlationId,
      startedAt,
      triggerSignal: triggerSignal ?? context.triggerSignals[0] ?? undefined,
    };

    // Handle completion in background (don't await here)
    promise
      .then(() => {
        this.logger.debug(
          {
            correlationId: context.correlationId,
            duration: Date.now() - startedAt,
          },
          'COGNITION completed (async)'
        );
      })
      .catch((error: unknown) => {
        this.logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            correlationId: context.correlationId,
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
          this.logger.debug(
            { correlationId: pending.correlationId, elapsed },
            'COGNITION still processing...'
          );

          // Resend typing indicator (Telegram typing expires after ~5 seconds)
          const chatId = (pending.triggerSignal?.data as Record<string, unknown> | undefined)?.[
            'chatId'
          ] as string | undefined;
          if (chatId) {
            const channel = this.channels.get('telegram');
            if (channel?.sendTyping) {
              channel.sendTyping(chatId).catch(() => {
                /* ignore typing errors */
              });
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
      this.logger.error(
        { error, correlationId: pending.correlationId },
        'COGNITION rejected unexpectedly'
      );
      return null;
    }
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
          const { channel, text, target, replyTo } = intent.payload;
          const channelImpl = this.channels.get(channel);
          if (channelImpl && target) {
            const sendOptions = replyTo ? { replyTo } : undefined;
            channelImpl
              .sendMessage(target, text, sendOptions)
              .then((success) => {
                if (success) {
                  this.lastMessageSentAt = Date.now();
                  this.lastMessageChatId = target;
                  this.metrics.counter('messages_sent', { channel });
                  // Save agent message to history
                  if (this.conversationManager) {
                    void this.saveAgentMessage(target, text);
                  }
                } else {
                  this.logger.warn(
                    { channel, target, textLength: text.length },
                    'Message send returned false'
                  );
                  this.metrics.counter('messages_failed', { channel, reason: 'returned_false' });
                }
              })
              .catch((error: unknown) => {
                this.logger.error(
                  {
                    error: error instanceof Error ? error.message : String(error),
                    channel,
                    target,
                    textLength: text.length,
                  },
                  'Message send threw an error'
                );
                this.metrics.counter('messages_failed', { channel, reason: 'exception' });
              });
          } else {
            this.logger.error(
              {
                channel,
                target,
                hasChannel: Boolean(channelImpl),
                hasTarget: Boolean(target),
                textPreview: text.slice(0, 50),
                registeredChannels: Array.from(this.channels.keys()),
              },
              'Cannot route message: channel not found or no target'
            );
            this.metrics.counter('messages_failed', { channel, reason: 'routing' });
          }
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

        case 'UPDATE_USER_MODEL': {
          const { chatId, field, value, confidence, source } = intent.payload;
          if (this.userModel && chatId) {
            // Apply update to user model based on field
            let applied = false;

            switch (field) {
              case 'name':
                if (typeof value === 'string' && value.length > 0) {
                  this.userModel.setName(value);
                  applied = true;
                }
                break;

              case 'gender':
                if (value === 'male' || value === 'female') {
                  this.userModel.setGender(value);
                  applied = true;
                }
                break;

              case 'mood':
                if (typeof value === 'string') {
                  this.userModel.setMood(
                    value as
                      | 'positive'
                      | 'neutral'
                      | 'negative'
                      | 'stressed'
                      | 'tired'
                      | 'excited'
                      | 'unknown'
                  );
                  applied = true;
                }
                break;

              case 'energy':
                if (typeof value === 'number') {
                  this.userModel.updateEnergy(value);
                  applied = true;
                }
                break;

              case 'availability':
                if (typeof value === 'number') {
                  this.userModel.updateAvailability(value);
                  applied = true;
                }
                break;

              case 'language':
                if (typeof value === 'string') {
                  this.userModel.setLanguage(value);
                  applied = true;
                }
                break;

              case 'timezone':
                if (typeof value === 'number') {
                  this.userModel.setTimezone(value);
                  applied = true;
                }
                break;
            }

            this.logger.debug(
              { chatId, field, value, confidence, source, applied },
              'User model update from COGNITION'
            );
            this.metrics.counter('user_model_updates', { field, source });
          }
          break;
        }

        case 'SAVE_TO_MEMORY': {
          const { type: memoryType, chatId: memoryChatId, content, fact, tags } = intent.payload;

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
                chatId: memoryChatId,
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
              { memoryType, chatId: memoryChatId, hasFact: !!fact, hasContent: !!content },
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
          const {
            content,
            triggerSource,
            depth,
            rootThoughtId,
            parentThoughtId,
            dedupeKey,
            signalSource,
          } = intent.payload;

          // Build thought data
          const thoughtData: ThoughtData = {
            kind: 'thought',
            content,
            triggerSource,
            depth,
            rootThoughtId,
            dedupeKey,
            ...(parentThoughtId !== undefined && { parentThoughtId }),
          };

          // Use shared enqueue logic with budget/dedupe checks
          this.enqueueThoughtSignal(thoughtData, signalSource as SignalSource);
          break;
        }
      }
    }
  }

  /**
   * Cleanup old thought deduplication keys.
   */
  private cleanupOldThoughtKeys(now: number): void {
    for (const [key, timestamp] of this.recentThoughtKeys) {
      if (now - timestamp > THOUGHT_LIMITS.DEDUPE_WINDOW_MS) {
        this.recentThoughtKeys.delete(key);
      }
    }
  }

  /**
   * Enqueue a thought signal with budget and dedupe checks.
   * Returns true if the thought was queued, false if rejected.
   */
  private enqueueThoughtSignal(thoughtData: ThoughtData, signalSource: SignalSource): boolean {
    // Budget check - max thoughts per tick
    if (this.thoughtsThisTick >= THOUGHT_LIMITS.MAX_PER_TICK) {
      this.logger.warn(
        { content: thoughtData.content.slice(0, 30) },
        'Thought rejected: per-tick budget exceeded'
      );
      return false;
    }

    // Dedupe check - clean old entries first
    const now = Date.now();
    this.cleanupOldThoughtKeys(now);

    if (this.recentThoughtKeys.has(thoughtData.dedupeKey)) {
      this.logger.debug({ dedupeKey: thoughtData.dedupeKey }, 'Thought rejected: duplicate');
      return false;
    }
    this.recentThoughtKeys.set(thoughtData.dedupeKey, now);

    // Create and queue thought signal
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
   * Save agent message to conversation history.
   */
  private async saveAgentMessage(chatId: string, text: string): Promise<void> {
    if (!this.conversationManager) return;

    try {
      await this.conversationManager.addMessage(chatId, {
        role: 'assistant',
        content: text,
      });

      // Classify conversation status
      if (this.messageComposer) {
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
    const chatId = payload?.['chatId'] as string | undefined;
    const channelName = event.channel;

    if (!chatId || !channelName) return;

    const channel = this.channels.get(channelName);
    if (channel?.sendTyping) {
      await channel.sendTyping(chatId);
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
