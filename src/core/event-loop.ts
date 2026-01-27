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
import type { ContactDecider } from '../decision/contact-decider.js';

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
  /** Contact decider for gating proactive contact (cooldown, thresholds) */
  contactDecider?: ContactDecider | undefined;
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
  private readonly contactDecider: ContactDecider | undefined;

  /** Timestamp of last message sent by agent (for response timing) */
  private lastMessageSentAt: number | null = null;
  /** Chat ID of last message sent (to match responses) */
  private lastMessageChatId: string | null = null;
  /** Subscription ID for typing events */
  private typingSubscriptionId: string | null = null;

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
    this.contactDecider = deps.contactDecider;
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

    // Subscribe to typing events
    this.typingSubscriptionId = this.eventBus.subscribe(
      (event) => void this.handleTypingEvent(event),
      { source: 'internal', type: 'typing_start' }
    );

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

    // Unsubscribe from typing events
    if (this.typingSubscriptionId) {
      this.eventBus.unsubscribe(this.typingSubscriptionId);
      this.typingSubscriptionId = null;
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
        // Also update rule engine with current user beliefs
        this.ruleEngine.setUserBeliefs(this.userModel.getBeliefs());
      } else {
        this.ruleEngine.setUserBeliefs(undefined);
      }

      // 2c. Check if we should proactively contact user (via ContactDecider)
      await this.checkProactiveContact();

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

      // Special handling for acquaintance events (agent wants to introduce itself)
      if (event.type === 'acquaintance_threshold') {
        await this.handleAcquaintance(event);
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

        // Reset contact cooldown when user initiates contact
        if (this.contactDecider) {
          this.contactDecider.resetCooldown();
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
   * Check if we should proactively contact the user.
   * Uses ContactDecider to evaluate pressure, thresholds, and cooldown.
   */
  private async checkProactiveContact(): Promise<void> {
    // Skip if no contact decider configured
    if (!this.contactDecider) {
      return;
    }

    const chatId = this.config.primaryUserChatId;
    if (!chatId) {
      return;
    }

    // Get current state and user beliefs
    const state = this.agent.getState();
    const userBeliefs = this.userModel?.getBeliefs();
    const hour = new Date().getHours();

    // Evaluate contact decision
    const decision = this.contactDecider.evaluate(state, userBeliefs, hour);

    this.logger.debug(
      {
        shouldContact: decision.shouldContact,
        pressure: decision.pressure.toFixed(2),
        threshold: decision.threshold.toFixed(2),
        reason: decision.reason,
        availabilitySource: decision.factors.availabilitySource,
        userAvailability: decision.factors.userAvailability.toFixed(2),
      },
      'Contact decision evaluated'
    );

    if (!decision.shouldContact) {
      return;
    }

    // Create synthetic event for handleProactiveContact
    const contactEvent: Event = {
      id: `contact-${String(Date.now())}`,
      source: 'internal',
      type: 'contact_pressure_threshold',
      priority: Priority.NORMAL,
      timestamp: new Date(),
      payload: {
        pressure: decision.pressure,
        threshold: decision.threshold,
        reason: decision.reason,
        trace: decision.trace,
      },
    };

    // Handle the proactive contact
    await this.handleProactiveContact(contactEvent);

    // Record contact attempt for cooldown
    this.contactDecider.recordContactAttempt();
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

    // Note: User availability check is handled by ContactDecider before we get here.
    // This method focuses on composing and sending the message.

    // Extract reason from event payload
    const payload = event.payload as Record<string, unknown> | undefined;
    const pressure = payload?.['pressure'] as number | undefined;
    const reason = payload?.['reason'] as string | undefined;

    // Compose proactive message
    const userLanguage = this.userModel?.getLanguage() ?? undefined;

    // Get conversation history for context (so LLM knows the language)
    let conversationHistory: Awaited<ReturnType<ConversationManager['getHistory']>> | undefined;
    if (this.conversationManager) {
      conversationHistory = await this.conversationManager.getHistory(chatId, {
        maxRecent: 5,
        includeCompacted: true,
      });
    }

    this.logger.info(
      {
        pressure: pressure?.toFixed(2),
        reason,
        language: userLanguage,
        historyLength: conversationHistory?.length,
      },
      'Composing proactive message'
    );

    // Notify agent of LLM call (drains energy)
    this.agent.onLLMCall();

    // Calculate time since last message for context
    let timeSinceLastMessage = '';
    if (conversationHistory && conversationHistory.length > 0) {
      const lastMsg = conversationHistory[conversationHistory.length - 1];
      if (lastMsg && 'timestamp' in lastMsg && lastMsg.timestamp) {
        const lastTime = new Date(lastMsg.timestamp as string | Date).getTime();
        const diffMs = Date.now() - lastTime;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 60) {
          timeSinceLastMessage = `${String(diffMins)} minutes ago`;
        } else {
          const diffHours = Math.floor(diffMins / 60);
          timeSinceLastMessage = `${String(diffHours)} hour${diffHours > 1 ? 's' : ''} ago`;
        }
      }
    }

    const result = await this.messageComposer.compose({
      trigger: reason ?? 'social debt accumulated',
      mood: 'friendly',
      language: userLanguage,
      conversationHistory,
      constraints: [
        `Context: The last message was ${timeSinceLastMessage || 'some time ago'}. You are now reaching out to the user on your own initiative.`,
        'Keep it brief and natural',
        "Don't be intrusive",
        'Show genuine interest',
      ],
    });

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
   * Handle acquaintance events.
   * Agent naturally wants to introduce itself and learn user's name.
   */
  private async handleAcquaintance(_event: Event): Promise<void> {
    const chatId = this.config.primaryUserChatId;

    // Check prerequisites
    if (!chatId) {
      this.logger.debug('Skipping acquaintance: no primary user chat ID configured');
      return;
    }

    if (!this.messageComposer) {
      this.logger.debug('Skipping acquaintance: no message composer available');
      return;
    }

    const telegramChannel = this.channels.get('telegram');
    if (!telegramChannel) {
      this.logger.debug('Skipping acquaintance: telegram channel not available');
      return;
    }

    // Don't introduce if user is asleep or unavailable
    if (this.userModel) {
      if (this.userModel.isLikelyAsleep()) {
        this.logger.debug('Skipping acquaintance: user likely asleep');
        return;
      }

      // Skip if we already know the name
      if (this.userModel.isNameKnown()) {
        this.logger.debug('Skipping acquaintance: already know user name');
        return;
      }
    }

    // Compose introduction message asking for name
    const agentName = this.agent.getIdentity().name;
    const userLanguage = this.userModel?.getLanguage() ?? undefined;

    // Get conversation history for context (agent should remember what was discussed)
    let conversationHistory: Awaited<ReturnType<ConversationManager['getHistory']>> | undefined;
    if (this.conversationManager) {
      conversationHistory = await this.conversationManager.getHistory(chatId, {
        maxRecent: 5,
        includeCompacted: true,
      });
    }

    this.logger.info(
      { agentName, language: userLanguage, historyLength: conversationHistory?.length },
      'Composing acquaintance message'
    );

    // Notify agent of LLM call
    this.agent.onLLMCall();

    // Calculate time since last message for context
    let timeSinceLastMessage = '';
    if (conversationHistory && conversationHistory.length > 0) {
      const lastMsg = conversationHistory[conversationHistory.length - 1];
      if (lastMsg && 'timestamp' in lastMsg && lastMsg.timestamp) {
        const lastTime = new Date(lastMsg.timestamp as string | Date).getTime();
        const diffMs = Date.now() - lastTime;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 60) {
          timeSinceLastMessage = `${String(diffMins)} minutes ago`;
        } else {
          const diffHours = Math.floor(diffMins / 60);
          timeSinceLastMessage = `${String(diffHours)} hour${diffHours > 1 ? 's' : ''} ago`;
        }
      }
    }

    const result = await this.messageComposer.compose({
      trigger: 'want to get acquainted with user',
      mood: 'friendly',
      language: userLanguage,
      conversationHistory,
      constraints: [
        `Your name is ${agentName}`,
        `Context: The last message was ${timeSinceLastMessage || 'some time ago'}. You are now reaching out to the user on your own initiative.`,
        'You realized you never learned their name, so introduce yourself and ask for theirs.',
        'Keep it short, warm, and natural',
      ],
    });

    if (!result.success || !result.message) {
      this.logger.warn({ error: result.error }, 'Failed to compose acquaintance message');
      return;
    }

    // Send the message
    const sent = await telegramChannel.sendMessage(chatId, result.message);

    // Clear pending flag regardless of success/failure
    this.agent.applyIntent({
      type: 'UPDATE_STATE',
      payload: { key: 'acquaintancePending', value: false },
    });

    if (sent) {
      this.logger.info(
        { chatId, messageLength: result.message.length, tokensUsed: result.tokensUsed },
        '🤝 Acquaintance message sent'
      );
      this.metrics.counter('acquaintance_messages_sent');

      // Track for response timing
      this.lastMessageSentAt = Date.now();
      this.lastMessageChatId = chatId;

      // Save to conversation history
      await this.saveAgentMessage(chatId, result.message);

      // Reset acquaintance pressure after successful send
      this.agent.applyIntent({
        type: 'UPDATE_STATE',
        payload: { key: 'acquaintancePressure', value: 0 },
      });
    } else {
      this.logger.warn({ chatId }, 'Failed to send acquaintance message');
      // Pressure stays high, will retry on next threshold check
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
   * Save agent message to conversation history and classify conversation status.
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

      // Classify and store conversation status for follow-up timing
      if (this.messageComposer) {
        const classification = await this.messageComposer.classifyConversationStatus(text);
        await this.conversationManager.setStatus(chatId, classification.status);

        this.logger.debug(
          {
            chatId,
            status: classification.status,
            confidence: classification.confidence.toFixed(2),
            reasoning: classification.reasoning,
          },
          '📊 Conversation status classified'
        );
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), chatId },
        'Failed to save agent message to history'
      );
    }
  }

  /**
   * Handle typing_start event from layer processor.
   * Sends typing indicator to the appropriate channel.
   */
  private async handleTypingEvent(event: Event): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    const chatId = payload?.['chatId'] as string | undefined;
    const channelName = event.channel;

    if (!chatId || !channelName) {
      return;
    }

    const channel = this.channels.get(channelName);
    if (channel?.sendTyping) {
      await channel.sendTyping(chatId);
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

    // Check for conversation follow-up (every tick)
    await this.checkConversationFollowUp();
  }

  /**
   * Check if we should follow up on a conversation based on status and timing.
   */
  private async checkConversationFollowUp(): Promise<void> {
    const chatId = this.config.primaryUserChatId;

    if (!chatId || !this.conversationManager) {
      return;
    }

    // Don't send follow-ups if we don't know the user's name yet
    // Acquaintance takes priority - we should introduce ourselves first
    if (this.userModel && !this.userModel.isNameKnown()) {
      return;
    }

    try {
      const followUpCheck = await this.conversationManager.shouldFollowUp(chatId);

      if (!followUpCheck.shouldFollowUp) {
        return;
      }

      this.logger.info(
        {
          chatId,
          status: followUpCheck.status,
          reason: followUpCheck.reason,
          timeSinceLastMessage: Math.round(followUpCheck.timeSinceLastMessage / 60000),
        },
        '⏰ Conversation follow-up triggered'
      );

      // Create a follow-up event that will be handled like proactive contact
      const followUpEvent: Event = {
        id: `followup_${String(Date.now())}`,
        source: 'internal',
        type: 'conversation_followup',
        priority: Priority.NORMAL,
        timestamp: new Date(),
        payload: {
          chatId,
          status: followUpCheck.status,
          reason: followUpCheck.reason,
        },
      };

      await this.handleConversationFollowUp(followUpEvent);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to check conversation follow-up'
      );
    }
  }

  /**
   * Handle conversation follow-up by sending an appropriate message.
   */
  private async handleConversationFollowUp(event: Event): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const chatId = payload['chatId'] as string;
    const status = payload['status'] as string;

    if (!chatId || !this.messageComposer) {
      return;
    }

    const telegramChannel = this.channels.get('telegram');
    if (!telegramChannel) {
      return;
    }

    // Check if user is available
    if (this.userModel?.isLikelyAsleep()) {
      this.logger.debug('Skipping follow-up: user likely asleep');
      return;
    }

    // Determine follow-up message based on status
    let trigger: string;
    switch (status) {
      case 'awaiting_answer':
        trigger = 'following up on unanswered question';
        break;
      case 'active':
        trigger = 'continuing conversation after pause';
        break;
      case 'idle':
        trigger = 'reaching out after idle period';
        break;
      default:
        trigger = 'checking in';
    }

    const userLanguage = this.userModel?.getLanguage() ?? undefined;

    // Get conversation history for context (so LLM knows the language)
    let conversationHistory: Awaited<ReturnType<ConversationManager['getHistory']>> | undefined;
    if (this.conversationManager) {
      conversationHistory = await this.conversationManager.getHistory(chatId, {
        maxRecent: 5,
        includeCompacted: true,
      });
    }

    this.logger.info(
      { status, trigger, language: userLanguage, historyLength: conversationHistory?.length },
      'Composing follow-up message'
    );

    // Notify agent of LLM call
    this.agent.onLLMCall();

    // Calculate time since last message for context
    let timeSinceLastMessage = '';
    if (conversationHistory && conversationHistory.length > 0) {
      const lastMsg = conversationHistory[conversationHistory.length - 1];
      if (lastMsg && 'timestamp' in lastMsg && lastMsg.timestamp) {
        const lastTime = new Date(lastMsg.timestamp as string | Date).getTime();
        const diffMs = Date.now() - lastTime;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 60) {
          timeSinceLastMessage = `${String(diffMins)} minutes ago`;
        } else {
          const diffHours = Math.floor(diffMins / 60);
          timeSinceLastMessage = `${String(diffHours)} hour${diffHours > 1 ? 's' : ''} ago`;
        }
      }
    }

    const result = await this.messageComposer.compose({
      trigger,
      mood: 'friendly',
      language: userLanguage,
      conversationHistory,
      constraints: [
        `Context: The last message was ${timeSinceLastMessage || 'some time ago'} and the user hasn't responded. You are following up on your own initiative.`,
        'Keep it brief and natural',
        "Don't be intrusive",
      ],
    });

    if (!result.success || !result.message) {
      this.logger.warn({ error: result.error }, 'Failed to compose follow-up message');
      return;
    }

    const sent = await telegramChannel.sendMessage(chatId, result.message);

    if (sent) {
      this.logger.info({ chatId, messageLength: result.message.length }, 'Follow-up message sent');
      this.metrics.counter('followup_messages_sent');

      // Save and classify the new message
      await this.saveAgentMessage(chatId, result.message);
    }
  }

  /**
   * Calculate the next tick interval based on agent state.
   */
  private calculateNextInterval(): number {
    // If there are events in queue, process immediately
    if (this.eventQueue.size() > 0) {
      return this.config.minTickInterval;
    }

    // Get interval from agent state
    const agentInterval = this.agent.getState().tickInterval;

    // Clamp to configured bounds
    return Math.max(
      this.config.minTickInterval,
      Math.min(this.config.maxTickInterval, agentInterval)
    );
  }

  /**
   * Wake up the event loop immediately to process pending events.
   * Call this when urgent events are added to the queue.
   */
  wakeUp(): void {
    if (!this.running) return;

    // Cancel current scheduled tick
    if (this.tickTimeout) {
      clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }

    // Schedule immediate tick
    this.scheduleTick(0);
    this.logger.debug('Event loop woken up for immediate processing');
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
