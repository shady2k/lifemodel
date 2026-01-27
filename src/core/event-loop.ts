import { randomUUID } from 'node:crypto';
import type {
  Event,
  EventQueue,
  Logger,
  Metrics,
  Intent,
  PruneConfig,
  Thought,
  Channel,
} from '../types/index.js';
import { Priority, PRIORITY_DISTURBANCE_WEIGHT } from '../types/index.js';
import type { Agent } from './agent.js';
import type { EventBus } from './event-bus.js';
import type { LayerProcessor } from '../layers/layer-processor.js';
import type { RuleEngine } from '../rules/rule-engine.js';
import type { MessageComposer } from '../llm/composer.js';
import type { UserModel } from '../models/user-model.js';
import type { LearningEngine } from '../learning/learning-engine.js';
import type { ConversationManager } from '../storage/conversation-manager.js';

/**
 * Event loop configuration.
 */
export interface EventLoopConfig {
  /** Minimum tick interval in ms (default: 1000) */
  minTickInterval: number;

  /** Maximum tick interval in ms (default: 60000) */
  maxTickInterval: number;

  /** Default tick interval in ms (default: 30000) */
  defaultTickInterval: number;

  /** Max events to process per tick (default: 100) */
  maxEventsPerTick: number;

  /** Run aggregation every N ticks (default: 5) */
  aggregationInterval: number;

  /** Run pruning every N ticks (default: 10) */
  pruneInterval: number;

  /** Prune config for overload handling */
  pruneConfig: PruneConfig;

  /** Primary user's Telegram chat ID for proactive messages */
  primaryUserChatId?: string;
}

/**
 * Optional dependencies for proactive messaging.
 */
export interface EventLoopDeps {
  /** Message composer for generating proactive messages */
  messageComposer?: MessageComposer | undefined;
  /** User model for checking user state before contacting */
  userModel?: UserModel | undefined;
  /** Learning engine for self-learning */
  learningEngine?: LearningEngine | undefined;
  /** Conversation manager for storing message history */
  conversationManager?: ConversationManager | undefined;
}

const DEFAULT_CONFIG: EventLoopConfig = {
  minTickInterval: 1_000,
  maxTickInterval: 60_000,
  defaultTickInterval: 30_000,
  maxEventsPerTick: 100,
  aggregationInterval: 5,
  pruneInterval: 10,
  pruneConfig: {
    maxAge: 60_000, // 1 minute
    maxPriorityToDrop: Priority.LOW,
    emergencyThreshold: 1000,
  },
};

/**
 * EventLoop - the heartbeat of the agent.
 *
 * Two concurrent processes:
 * 1. Event receiver (async, always listening) - via EventBus subscriptions
 * 2. Tick loop (periodic, dynamic interval) - this class
 *
 * The tick loop:
 * - Processes queued events
 * - Updates agent state (decay, accumulation)
 * - Evaluates rules (returns intents)
 * - Applies intents
 * - Calculates next tick interval
 *
 * Like a heartbeat, the tick never stops while the loop is running.
 */
export class EventLoop {
  private readonly agent: Agent;
  private readonly eventQueue: EventQueue;
  private readonly eventBus: EventBus;
  private readonly layerProcessor: LayerProcessor;
  private readonly ruleEngine: RuleEngine;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly config: EventLoopConfig;

  private running = false;
  private tickCount = 0;
  private tickTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly channels = new Map<string, Channel>();
  private readonly messageComposer: MessageComposer | undefined;
  private readonly userModel: UserModel | undefined;
  private readonly learningEngine: LearningEngine | undefined;
  private readonly conversationManager: ConversationManager | undefined;

  /** Timestamp of last message sent by agent (for response timing) */
  private lastMessageSentAt: number | null = null;
  /** Chat ID of last message sent (to match responses) */
  private lastMessageChatId: string | null = null;

  constructor(
    agent: Agent,
    eventQueue: EventQueue,
    eventBus: EventBus,
    layerProcessor: LayerProcessor,
    ruleEngine: RuleEngine,
    logger: Logger,
    metrics: Metrics,
    config: Partial<EventLoopConfig> = {},
    deps: EventLoopDeps = {}
  ) {
    this.agent = agent;
    this.eventQueue = eventQueue;
    this.eventBus = eventBus;
    this.layerProcessor = layerProcessor;
    this.ruleEngine = ruleEngine;
    this.logger = logger.child({ component: 'event-loop' });
    this.metrics = metrics;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.messageComposer = deps.messageComposer;
    this.userModel = deps.userModel;
    this.learningEngine = deps.learningEngine;
    this.conversationManager = deps.conversationManager;
  }

  /**
   * Start the event loop.
   */
  start(): void {
    if (this.running) {
      this.logger.warn('Event loop already running');
      return;
    }

    this.running = true;
    this.logger.info('Event loop started');

    // Schedule first tick immediately
    this.scheduleTick(0);
  }

  /**
   * Stop the event loop.
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

    this.logger.info({ tickCount: this.tickCount }, 'Event loop stopped');
  }

  /**
   * Check if the loop is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register a channel for message routing.
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
   * Emit an event into the system.
   * Events go to the queue and are processed on next tick.
   */
  async emit(event: Omit<Event, 'id' | 'timestamp'>): Promise<string> {
    const fullEvent: Event = {
      ...event,
      id: randomUUID(),
      timestamp: new Date(),
    };

    await this.eventQueue.push(fullEvent);
    return fullEvent.id;
  }

  /**
   * Emit a tick event.
   */
  private emitTickEvent(): void {
    const tickEvent: Event = {
      id: randomUUID(),
      source: 'time',
      type: 'tick',
      priority: Priority.NORMAL,
      timestamp: new Date(),
      payload: { tickCount: this.tickCount },
    };

    // Publish directly to bus (don't queue ticks)
    void this.eventBus.publish(tickEvent);
  }

  /**
   * Schedule the next tick.
   */
  private scheduleTick(delay: number): void {
    if (!this.running) return;

    this.tickTimeout = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  /**
   * Execute one tick cycle.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const tickStart = Date.now();
    this.tickCount++;

    const state = this.agent.getState();
    this.logger.debug(
      {
        tick: this.tickCount,
        energy: state.energy.toFixed(2),
        socialDebt: state.socialDebt.toFixed(2),
        taskPressure: state.taskPressure.toFixed(2),
        curiosity: state.curiosity.toFixed(2),
        mode: this.agent.getAlertnessMode(),
        queueSize: this.eventQueue.size(),
      },
      '⏱️ Tick starting'
    );

    try {
      // 1. Process queued events
      const eventsProcessed = await this.processEvents();

      // 2. Update agent state (energy, social debt, etc.)
      const agentIntents = this.agent.tick();

      // 2b. Update user model beliefs (time-based decay)
      if (this.userModel) {
        this.userModel.updateTimeBasedBeliefs();
      }

      // 3. Evaluate rules
      const ruleIntents = this.ruleEngine.evaluateTick(this.agent.getState());

      // 4. Combine and apply all intents
      const allIntents = [...agentIntents, ...ruleIntents];
      this.applyIntents(allIntents);

      // 5. Emit tick event to subscribers
      this.emitTickEvent();

      // 6. Periodic maintenance
      await this.periodicMaintenance();

      // 7. Calculate next tick interval
      const nextInterval = this.calculateNextInterval();

      // 8. Log tick summary
      const tickDuration = Date.now() - tickStart;
      this.logger.debug(
        {
          tick: this.tickCount,
          eventsProcessed,
          agentIntents: agentIntents.length,
          ruleIntents: ruleIntents.length,
          duration: tickDuration,
          nextInterval,
          mode: this.agent.getAlertnessMode(),
          energy: this.agent.getEnergy().toFixed(2),
        },
        'Tick completed'
      );

      // Update metrics
      this.metrics.counter('event_loop_ticks');
      this.metrics.gauge('event_loop_tick_duration', tickDuration);
      this.metrics.gauge('event_loop_events_processed', eventsProcessed);
      this.metrics.gauge('event_loop_next_interval', nextInterval);

      // Schedule next tick
      this.scheduleTick(nextInterval);
    } catch (error) {
      this.logger.error({ error, tick: this.tickCount }, 'Tick failed');

      // Continue running despite error
      this.scheduleTick(this.config.defaultTickInterval);
    }
  }

  /**
   * Process events from the queue through the layer processor.
   */
  private async processEvents(): Promise<number> {
    let processed = 0;
    const mode = this.agent.getAlertnessMode();

    while (processed < this.config.maxEventsPerTick) {
      const event = await this.eventQueue.peek();

      if (!event) break;

      // Filter based on alertness mode
      if (!this.shouldProcessEvent(event, mode)) {
        // Add disturbance for filtered events
        const disturbance = PRIORITY_DISTURBANCE_WEIGHT[event.priority];
        const woke = this.agent.addDisturbance(disturbance);

        if (woke) {
          // Agent woke up - process this event
          this.logger.debug({ eventId: event.id, priority: event.priority }, 'Event woke agent');
        } else {
          // Skip this event, but remove it from queue
          await this.eventQueue.pull();
          processed++;
          continue;
        }
      }

      // Pull the event
      await this.eventQueue.pull();

      // Notify agent of event processing (drains energy)
      this.agent.onEventProcessed();

      // Special handling for proactive contact events
      if (event.type === 'contact_pressure_threshold') {
        await this.handleProactiveContact(event);
        processed++;
        continue;
      }

      // Process through 6-layer brain pipeline
      const result = await this.layerProcessor.process(event);

      // Evaluate event-specific rules
      const eventRuleIntents = this.ruleEngine.evaluateEvent(this.agent.getState(), event);

      // Record interaction for rule engine (resets timeSinceLastInteraction)
      if (event.source === 'communication') {
        this.ruleEngine.recordInteraction();

        // Update user beliefs based on message
        if (this.userModel) {
          this.userModel.processSignal('message_received');

          // Check for response timing (if we sent a message recently)
          this.processResponseTiming(event);
        }

        // Process learning for message received
        if (this.learningEngine) {
          this.learningEngine.processFeedback('message_received');
        }

        // Save user message to conversation history
        await this.saveUserMessage(event);
      }

      // Apply intents from layer processing and rules
      this.applyIntents([...result.intents, ...eventRuleIntents]);

      // Recycle thoughts that need further processing
      await this.recycleThoughts(result.thoughts);

      // Also publish to EventBus for any additional subscribers
      await this.eventBus.publish(event);

      // Log processing summary
      this.logger.debug(
        {
          eventId: event.id,
          layers: result.layersExecuted.length,
          intents: result.intents.length,
          thoughts: result.thoughts.length,
          hoisted: result.hoisted,
          timeMs: result.processingTimeMs,
        },
        'Event processed through layers'
      );

      // Update metrics
      this.metrics.histogram('layer_processing_time', result.processingTimeMs);
      this.metrics.counter('events_processed_through_layers');

      processed++;

      // CRITICAL events wake the agent immediately
      if (event.priority === Priority.CRITICAL) {
        this.agent.wake();
      }
    }

    return processed;
  }

  /**
   * Convert thoughts that require processing into internal events.
   * This completes the thinking loop - thoughts can trigger further processing.
   */
  private async recycleThoughts(thoughts: Thought[]): Promise<void> {
    if (thoughts.length > 0) {
      this.logger.debug({ count: thoughts.length }, 'Processing generated thoughts');
    }

    for (const thought of thoughts) {
      if (!thought.requiresProcessing) {
        // Log thoughts that don't need processing
        this.logger.debug(
          { thoughtId: thought.id, content: thought.content },
          '💭 Thought noted (passive)'
        );
        continue;
      }

      // Convert thought to internal event for further processing
      const thoughtEvent: Event = {
        id: randomUUID(),
        source: 'thoughts',
        type: 'internal_thought',
        priority: thought.priority,
        timestamp: new Date(),
        payload: {
          thoughtId: thought.id,
          content: thought.content,
          sourceEvent: thought.source,
        },
      };

      await this.eventQueue.push(thoughtEvent);

      this.logger.debug(
        {
          thoughtId: thought.id,
          eventId: thoughtEvent.id,
          priority: thought.priority,
          content: thought.content,
        },
        '💭 Thought queued for processing (active)'
      );

      this.metrics.counter('thoughts_recycled');
    }
  }

  /**
   * Handle proactive contact events.
   * Composes a message using the LLM and sends it to the primary user.
   */
  private async handleProactiveContact(event: Event): Promise<void> {
    const chatId = this.config.primaryUserChatId;

    // Check prerequisites
    if (!chatId) {
      this.logger.debug('Skipping proactive contact: no primary user chat ID configured');
      return;
    }

    if (!this.messageComposer) {
      this.logger.debug('Skipping proactive contact: no message composer available');
      return;
    }

    const telegramChannel = this.channels.get('telegram');
    if (!telegramChannel) {
      this.logger.debug('Skipping proactive contact: telegram channel not available');
      return;
    }

    // Check if user is available (if userModel configured)
    if (this.userModel) {
      const contactScore = this.userModel.getContactScore();
      if (contactScore < 0.3) {
        this.logger.info(
          { contactScore: contactScore.toFixed(2) },
          'Skipping proactive contact: user likely unavailable'
        );
        return;
      }

      // Check if user is asleep
      if (this.userModel.isLikelyAsleep()) {
        this.logger.info('Skipping proactive contact: user likely asleep');
        return;
      }
    }

    // Extract reason from event payload
    const payload = event.payload as Record<string, unknown> | undefined;
    const pressure = payload?.['pressure'] as number | undefined;
    const reason = payload?.['reason'] as string | undefined;

    // Compose proactive message
    this.logger.info({ pressure: pressure?.toFixed(2), reason }, 'Composing proactive message');

    // Notify agent of LLM call (drains energy)
    this.agent.onLLMCall();

    const result = await this.messageComposer.composeProactive(reason ?? 'social debt accumulated');

    if (!result.success || !result.message) {
      this.logger.warn({ error: result.error }, 'Failed to compose proactive message');
      return;
    }

    // Send the message
    const sent = await telegramChannel.sendMessage(chatId, result.message);

    if (sent) {
      this.logger.info(
        { chatId, messageLength: result.message.length, tokensUsed: result.tokensUsed },
        'Proactive message sent'
      );
      this.metrics.counter('proactive_messages_sent');

      // Record behavior for learning
      if (this.learningEngine) {
        const userAvailability = this.userModel?.estimateAvailability() ?? 0.5;
        const behaviorContext: Parameters<typeof this.learningEngine.recordBehavior>[1] = {
          hour: new Date().getHours(),
          userAvailability,
          energy: this.agent.getEnergy(),
        };
        if (pressure !== undefined) {
          behaviorContext.contactPressure = pressure;
        }
        this.learningEngine.recordBehavior('proactive_contact', behaviorContext, [
          'socialDebt',
          'taskPressure',
          'curiosity',
          'userAvailability',
        ]);
      }

      // Track for response timing
      this.lastMessageSentAt = Date.now();
      this.lastMessageChatId = chatId;

      // Reset social debt after successful contact
      this.agent.applyIntent({
        type: 'UPDATE_STATE',
        payload: { key: 'socialDebt', value: 0.1 },
      });
    } else {
      this.logger.warn({ chatId }, 'Failed to send proactive message');
      this.metrics.counter('proactive_messages_failed');
    }
  }

  /**
   * Save user message to conversation history.
   */
  private async saveUserMessage(event: Event): Promise<void> {
    if (!this.conversationManager) {
      return;
    }

    const payload = event.payload as Record<string, unknown> | undefined;
    const chatId = payload?.['chatId'] as string | undefined;
    const text = payload?.['text'] as string | undefined;

    if (!chatId || !text) {
      return;
    }

    try {
      await this.conversationManager.addMessage(chatId, {
        role: 'user',
        content: text,
      });
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), chatId },
        'Failed to save user message to history'
      );
    }
  }

  /**
   * Save agent message to conversation history.
   */
  private async saveAgentMessage(chatId: string, text: string): Promise<void> {
    if (!this.conversationManager) {
      return;
    }

    try {
      await this.conversationManager.addMessage(chatId, {
        role: 'assistant',
        content: text,
      });
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), chatId },
        'Failed to save agent message to history'
      );
    }
  }

  /**
   * Process response timing to learn from user behavior.
   * Called when a communication event is received.
   */
  private processResponseTiming(event: Event): void {
    if (!this.userModel || !this.lastMessageSentAt) {
      return;
    }

    // Extract chat ID from event payload
    const payload = event.payload as Record<string, unknown> | undefined;
    const chatId = payload?.['chatId'] as string | undefined;

    // Only process if this is a response to our message
    if (!chatId || chatId !== this.lastMessageChatId) {
      return;
    }

    const responseTimeMs = Date.now() - this.lastMessageSentAt;
    const responseTimeSec = responseTimeMs / 1000;

    // Classify response speed and process signals
    // Quick: < 30 seconds
    // Normal: 30 seconds - 5 minutes
    // Slow: 5 - 30 minutes
    // Very slow: > 30 minutes (but still responded)
    if (responseTimeSec < 30) {
      this.userModel.processSignal('quick_response', { responseTimeMs });
      // Also process learning
      if (this.learningEngine) {
        this.learningEngine.processFeedback('quick_response', { responseTimeMs });
      }
      this.logger.debug({ responseTimeSec: responseTimeSec.toFixed(1) }, 'Quick response detected');
    } else if (responseTimeSec > 300) {
      this.userModel.processSignal('slow_response', { responseTimeMs });
      // Also process learning
      if (this.learningEngine) {
        this.learningEngine.processFeedback('slow_response', { responseTimeMs });
      }
      this.logger.debug({ responseTimeSec: responseTimeSec.toFixed(1) }, 'Slow response detected');
    }
    // Normal response time doesn't trigger a specific signal

    // Reset tracking after processing
    this.lastMessageSentAt = null;
    this.lastMessageChatId = null;

    this.metrics.histogram('user_response_time_ms', responseTimeMs);
  }

  /**
   * Check if an event should be processed based on alertness mode.
   */
  private shouldProcessEvent(event: Event, mode: string): boolean {
    switch (mode) {
      case 'alert':
        return true; // Process all events

      case 'normal':
        return true; // Process all events

      case 'relaxed':
        // Only HIGH and above
        return event.priority <= Priority.HIGH;

      case 'sleep':
        // Only CRITICAL
        return event.priority === Priority.CRITICAL;

      default:
        return true;
    }
  }

  /**
   * Apply intents from agent tick.
   */
  private applyIntents(intents: Intent[]): void {
    for (const intent of intents) {
      switch (intent.type) {
        case 'UPDATE_STATE':
          this.agent.applyIntent(intent);
          break;

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
          // Only assign channel if provided
          if (event.channel) {
            fullEvent.channel = event.channel;
          }

          if (delay <= 0) {
            // Immediate - push to queue now
            void this.eventQueue.push(fullEvent);
            this.logger.debug(
              { eventId: fullEvent.id, type: fullEvent.type },
              'Event scheduled immediately'
            );
          } else {
            // Delayed - schedule with setTimeout
            setTimeout(() => {
              if (this.running) {
                void this.eventQueue.push(fullEvent);
                this.logger.debug(
                  { eventId: fullEvent.id, type: fullEvent.type, delay },
                  'Delayed event queued'
                );
              }
            }, delay);
            this.logger.debug(
              { eventId: fullEvent.id, type: fullEvent.type, delay },
              'Event scheduled with delay'
            );
          }
          break;
        }

        case 'SEND_MESSAGE': {
          const { channel, text, target, replyTo } = intent.payload;
          const channelImpl = this.channels.get(channel);
          if (channelImpl && target) {
            // Build options only if replyTo is provided
            const sendOptions = replyTo ? { replyTo } : undefined;
            // Fire and forget - don't block tick on send
            void channelImpl.sendMessage(target, text, sendOptions).then((success) => {
              if (success) {
                // Track for response timing
                this.lastMessageSentAt = Date.now();
                this.lastMessageChatId = target;
                this.metrics.counter('messages_sent', { channel });
                // Save agent message to conversation history
                void this.saveAgentMessage(target, text);
              } else {
                this.metrics.counter('messages_failed', { channel });
              }
            });
          } else {
            this.logger.warn(
              { channel, target, hasChannel: Boolean(channelImpl) },
              'Cannot route message: channel not found or no target'
            );
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
          // TODO: Implement event cancellation
          this.logger.debug({ intent }, 'CANCEL_EVENT not yet implemented');
          break;
      }
    }
  }

  /**
   * Run periodic maintenance tasks.
   */
  private async periodicMaintenance(): Promise<void> {
    // Aggregation
    if (this.tickCount % this.config.aggregationInterval === 0) {
      if (this.eventQueue.aggregate) {
        const aggregated = await this.eventQueue.aggregate();
        if (aggregated > 0) {
          this.logger.debug({ aggregated }, 'Events aggregated');
        }
      }
    }

    // Pruning
    if (this.tickCount % this.config.pruneInterval === 0) {
      if (this.eventQueue.prune) {
        const pruned = await this.eventQueue.prune(this.config.pruneConfig);
        if (pruned > 0) {
          this.logger.debug({ pruned }, 'Events pruned');
        }
      }
    }
  }

  /**
   * Calculate the next tick interval based on agent state.
   */
  private calculateNextInterval(): number {
    // Get interval from agent state
    const agentInterval = this.agent.getState().tickInterval;

    // Clamp to configured bounds
    return Math.max(
      this.config.minTickInterval,
      Math.min(this.config.maxTickInterval, agentInterval)
    );
  }
}

/**
 * Factory function for creating an event loop.
 */
export function createEventLoop(
  agent: Agent,
  eventQueue: EventQueue,
  eventBus: EventBus,
  layerProcessor: LayerProcessor,
  ruleEngine: RuleEngine,
  logger: Logger,
  metrics: Metrics,
  config?: Partial<EventLoopConfig>,
  deps?: EventLoopDeps
): EventLoop {
  return new EventLoop(
    agent,
    eventQueue,
    eventBus,
    layerProcessor,
    ruleEngine,
    logger,
    metrics,
    config,
    deps
  );
}
