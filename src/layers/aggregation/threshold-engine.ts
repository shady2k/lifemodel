/**
 * Threshold Engine
 *
 * Decides when to wake COGNITION based on signal aggregates.
 * Uses Weber-Fechner relative thresholds and state-adaptive sensitivity.
 *
 * Wake triggers:
 * - User message (always wake)
 * - Contact pressure crossed threshold (conversation-aware)
 * - Pattern break detected
 * - Channel error
 * - Scheduled event
 *
 * Conversation-aware proactive contact:
 * - awaiting_answer: short wait, then gentle follow-up
 * - active/idle: normal threshold applies
 * - closed: much longer wait before initiating
 */

import type {
  Signal,
  SignalAggregate,
  ContactUrgeData,
  PluginEventData,
  Fact,
  FactBatchData,
} from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import { Priority } from '../../types/priority.js';
import type { AgentState } from '../../types/agent/state.js';
import type { WakeTrigger, WakeThresholdConfig } from '../../types/layers.js';
import { DEFAULT_WAKE_THRESHOLDS } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';
import type { SignalAckRegistry } from './ack-registry.js';
import { createAckRegistry } from './ack-registry.js';
import type { MemoryProvider, MemoryEntry } from '../cognition/tools/core/memory.js';

/**
 * Conversation status for proactive contact decisions.
 */
export type ConversationStatus = 'active' | 'awaiting_answer' | 'closed' | 'idle' | 'unknown';

/**
 * Configuration for conversation-aware contact timing.
 */
export interface ContactTimingConfig {
  /** Time to wait before follow-up when awaiting answer (ms) - default 3 min */
  awaitingAnswerDelayMs: number;
  /** Time to wait before contact when conversation is idle (ms) - default 30 min */
  idleDelayMs: number;
  /** Time to wait before contact when conversation is closed (ms) - default 4 hours */
  closedDelayMs: number;
  /** Minimum cooldown between any proactive contacts (ms) - default 30 min (safety minimum) */
  cooldownMs: number;
  /** User availability threshold below which we don't contact (0-1) */
  lowAvailabilityThreshold: number;
  /** How long to defer when user availability is low (ms) - default 15 min */
  lowAvailabilityDeferMs: number;
}

const DEFAULT_CONTACT_TIMING: ContactTimingConfig = {
  awaitingAnswerDelayMs: 3 * 60 * 1000, // 3 minutes
  idleDelayMs: 30 * 60 * 1000, // 30 minutes
  closedDelayMs: 4 * 60 * 60 * 1000, // 4 hours
  cooldownMs: 30 * 60 * 1000, // 30 minutes (safety minimum)
  lowAvailabilityThreshold: 0.25,
  lowAvailabilityDeferMs: 15 * 60 * 1000, // 15 minutes
};

/**
 * Result of wake decision.
 */
export interface WakeDecision {
  /** Whether to wake COGNITION */
  shouldWake: boolean;

  /** What triggered the wake (if shouldWake) */
  trigger?: WakeTrigger;

  /** Why we're waking */
  reason?: string;

  /** Signals that triggered the wake */
  triggerSignals: Signal[];

  /** Threshold that was crossed (if applicable) */
  threshold?: number;

  /** Value that crossed the threshold */
  value?: number;

  /** Proactive contact type (if applicable) */
  proactiveType?: 'follow_up' | 'initiate';

  /** Whether this wake is overriding a deferral */
  deferralOverride?: boolean;
}

/**
 * Plugin event validator function type.
 */
export type PluginEventValidator = (data: PluginEventData) => { valid: boolean; error?: string };

/**
 * Dependencies for ThresholdEngine.
 */
export interface ThresholdEngineDeps {
  conversationManager?: ConversationManager;
  userModel?: UserModel;
  primaryRecipientId?: string;
  ackRegistry?: SignalAckRegistry;
  pluginEventValidator?: PluginEventValidator;
  memoryProvider?: MemoryProvider;
}

/**
 * Threshold Engine - decides when to wake COGNITION.
 */
export class ThresholdEngine {
  private readonly config: WakeThresholdConfig;
  private readonly contactTiming: ContactTimingConfig;
  private readonly logger: Logger;

  // Dependencies (optional - for conversation-aware contact)
  private conversationManager: ConversationManager | undefined;
  private userModel: UserModel | undefined;
  private primaryRecipientId: string | undefined;

  // Acknowledgment registry for deferrals (unified mechanism)
  private ackRegistry: SignalAckRegistry;

  // Plugin event validator (optional)
  private pluginEventValidator: PluginEventValidator | undefined;

  // Memory provider for saving facts
  private memoryProvider: MemoryProvider | undefined;

  // Cooldown tracking
  private lastProactiveContact: Date | null = null;

  // Follow-up attempt tracking
  private followUpAttempts = 0;

  constructor(
    logger: Logger,
    config: Partial<WakeThresholdConfig> = {},
    contactTiming: Partial<ContactTimingConfig> = {}
  ) {
    this.logger = logger.child({ component: 'threshold-engine' });
    this.config = { ...DEFAULT_WAKE_THRESHOLDS, ...config };
    this.contactTiming = { ...DEFAULT_CONTACT_TIMING, ...contactTiming };
    this.ackRegistry = createAckRegistry(logger);
  }

  /**
   * Update dependencies (called when they become available).
   */
  updateDeps(deps: ThresholdEngineDeps): void {
    if (deps.conversationManager) this.conversationManager = deps.conversationManager;
    if (deps.userModel) this.userModel = deps.userModel;
    if (deps.primaryRecipientId) this.primaryRecipientId = deps.primaryRecipientId;
    if (deps.ackRegistry) this.ackRegistry = deps.ackRegistry;
    if (deps.pluginEventValidator) this.pluginEventValidator = deps.pluginEventValidator;
    if (deps.memoryProvider) this.memoryProvider = deps.memoryProvider;
  }

  /**
   * Get the ack registry (for external access, e.g., from CoreLoop).
   */
  getAckRegistry(): SignalAckRegistry {
    return this.ackRegistry;
  }

  /**
   * Evaluate whether to wake COGNITION.
   *
   * @param signals All signals from this tick
   * @param aggregates Current aggregates
   * @param state Agent state (for threshold adjustment)
   */
  async evaluate(
    signals: Signal[],
    aggregates: SignalAggregate[],
    state: AgentState
  ): Promise<WakeDecision> {
    // Check for high-priority triggers first (always wake for user messages)
    const userMessages = signals.filter((s) => s.type === 'user_message');
    if (userMessages.length > 0) {
      // Reset cooldown and follow-up tracking when user contacts us
      this.lastProactiveContact = null;
      this.followUpAttempts = 0;
      // Clear all acks when user initiates contact (unified mechanism)
      this.ackRegistry.clearAll();
      return {
        shouldWake: true,
        trigger: 'user_message',
        reason: 'User sent a message',
        triggerSignals: userMessages,
      };
    }

    // Check for thought signals - bypass energy gate like user_message
    // Thoughts are internal processing that needs prompt handling
    // Filter out thoughts that have already been handled (ACKed)
    const thoughtSignals = signals.filter((s) => {
      if (s.type !== 'thought') return false;
      // Check if this specific thought was already handled
      const isHandled = this.ackRegistry.isHandled(s.id);
      if (isHandled) {
        this.logger.debug({ thoughtId: s.id }, 'Skipping already-handled thought');
      }
      return !isHandled;
    });
    if (thoughtSignals.length > 0) {
      return {
        shouldWake: true,
        trigger: 'thought',
        reason: 'Internal thought requires processing',
        triggerSignals: thoughtSignals,
      };
    }

    // Energy gate: if energy is critically low, don't wake for anything else
    if (state.energy < this.config.lowEnergy) {
      this.logger.debug(
        { energy: state.energy.toFixed(2), threshold: this.config.lowEnergy },
        'Skipping COGNITION wake - energy too low'
      );
      return {
        shouldWake: false,
        triggerSignals: [],
      };
    }

    // Check for channel errors
    const channelErrors = signals.filter((s) => s.type === 'channel_error');
    if (channelErrors.length > 0) {
      return {
        shouldWake: true,
        trigger: 'channel_error',
        reason: 'Channel reported an error',
        triggerSignals: channelErrors,
      };
    }

    // Check for pattern breaks - only wake for user-related patterns
    const patternBreaks = signals.filter((s) => {
      if (s.type !== 'pattern_break') return false;
      const data = s.data as { patternName?: string } | undefined;
      return data?.patternName === 'sudden_silence';
    });
    if (patternBreaks.length > 0) {
      return {
        shouldWake: true,
        trigger: 'pattern_break',
        reason: 'User behavior pattern detected',
        triggerSignals: patternBreaks,
      };
    }

    // Check for plugin events (scheduled reminders, etc.)
    const pluginEvents = signals.filter((s) => s.type === 'plugin_event');
    if (pluginEvents.length > 0) {
      // Validate plugin events if validator is available
      const validEvents: Signal[] = [];
      for (const event of pluginEvents) {
        const pluginData = event.data as PluginEventData | undefined;
        if (!pluginData) continue;

        if (this.pluginEventValidator) {
          const validation = this.pluginEventValidator(pluginData);
          if (!validation.valid) {
            // Soft validation: warn but accept if no schema registered
            // This allows plugins to work before registering schemas
            if (validation.error?.includes('No schema registered')) {
              this.logger.debug(
                { eventKind: pluginData.eventKind },
                'Plugin event has no schema registered, accepting'
              );
            } else {
              // Hard validation failure - schema exists but data invalid
              this.logger.warn(
                { eventKind: pluginData.eventKind, error: validation.error },
                'Plugin event failed schema validation, dropping'
              );
              continue;
            }
          }
        }
        validEvents.push(event);
      }

      if (validEvents.length > 0) {
        // Separate by signal kind:
        // - fact_batch: facts to save to memory (urgent=true also wakes COGNITION)
        // - other plugin events: wake COGNITION (reminders, etc.)
        const urgentFactBatches: Signal[] = [];
        const normalFactBatches: Signal[] = [];
        const otherEvents: Signal[] = [];

        for (const event of validEvents) {
          const data = event.data;
          if (!data) {
            otherEvents.push(event);
            continue;
          }

          // Check for fact_batch signals
          if (data.kind === 'fact_batch') {
            const factData = data;
            if (factData.urgent) {
              urgentFactBatches.push(event);
            } else {
              normalFactBatches.push(event);
            }
          } else if (data.kind === 'plugin_event') {
            otherEvents.push(event);
          } else {
            otherEvents.push(event);
          }
        }

        // Save all fact batches to memory (both urgent and normal)
        const allFactBatches = [...urgentFactBatches, ...normalFactBatches];
        if (allFactBatches.length > 0) {
          await this.saveFactsToMemory(allFactBatches);
        }

        // Urgent facts wake COGNITION immediately after saving
        // Note: fetch interval (~2h) serves as natural rate limit
        if (urgentFactBatches.length > 0) {
          const totalFacts = urgentFactBatches.reduce((sum, sig) => {
            const data = sig.data as FactBatchData;
            return sum + data.facts.length;
          }, 0);
          return {
            shouldWake: true,
            trigger: 'scheduled',
            reason: `Urgent facts: ${String(totalFacts)} fact(s)`,
            triggerSignals: urgentFactBatches,
          };
        }

        // Other plugin events (reminders, etc.) wake COGNITION
        if (otherEvents.length > 0) {
          const firstEvent = otherEvents[0]?.data as PluginEventData | undefined;
          return {
            shouldWake: true,
            trigger: 'scheduled',
            reason: `Plugin event: ${firstEvent?.eventKind ?? 'unknown'}`,
            triggerSignals: otherEvents,
          };
        }
      }
    }

    // Check for proactive contact (conversation-aware)
    const proactiveResult = await this.checkProactiveContact(aggregates, state);
    if (proactiveResult.shouldWake) {
      return proactiveResult;
    }

    // No wake needed
    return {
      shouldWake: false,
      triggerSignals: [],
    };
  }

  /**
   * Check if we should initiate proactive contact.
   * This is conversation-status-aware and respects deferrals via AckRegistry.
   */
  private async checkProactiveContact(
    aggregates: SignalAggregate[],
    state: AgentState
  ): Promise<WakeDecision> {
    // Need primaryRecipientId for proactive contact
    if (!this.primaryRecipientId) {
      this.logger.debug('Skipping proactive contact - no primaryRecipientId configured');
      return { shouldWake: false, triggerSignals: [] };
    }

    // Check cooldown first (safety minimum)
    if (this.isInCooldown()) {
      return { shouldWake: false, triggerSignals: [] };
    }

    // Get current pressure
    const contactPressure = aggregates.find((a) => a.type === 'contact_pressure');
    const currentPressure = contactPressure?.currentValue ?? 0;

    // Check ack registry for deferrals (unified mechanism)
    const ackResult = this.ackRegistry.checkBlocked('contact_urge', undefined, currentPressure);

    if (ackResult.blocked) {
      this.logger.trace(
        {
          reason: ackResult.reason,
          currentPressure: currentPressure.toFixed(2),
        },
        'Proactive contact blocked by ack registry'
      );
      return { shouldWake: false, triggerSignals: [] };
    }

    // Check user availability - if too low, defer instead of checking every tick
    const userAvailability = this.userModel?.getBeliefs().availability ?? 0.5;
    if (userAvailability < this.contactTiming.lowAvailabilityThreshold) {
      // Create a time-based deferral - will be checked again after deferral expires
      const deferMs = this.contactTiming.lowAvailabilityDeferMs;
      this.ackRegistry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + deferMs),
        reason: `User availability too low (${userAvailability.toFixed(2)})`,
        // No valueAtAck/overrideDelta - pure time-based deferral
      });

      this.logger.debug(
        { availability: userAvailability.toFixed(2), deferMinutes: Math.round(deferMs / 60000) },
        'Deferring proactive contact - user availability too low'
      );
      return { shouldWake: false, triggerSignals: [] };
    }

    // Get conversation status
    const conversationStatus = await this.getConversationStatus();
    const timeSinceLastMessage = await this.getTimeSinceLastMessage();

    this.logger.trace(
      {
        conversationStatus,
        timeSinceLastMessageSec: timeSinceLastMessage
          ? Math.round(timeSinceLastMessage / 1000)
          : null,
        userAvailability: userAvailability.toFixed(2),
        deferralOverride: ackResult.isOverride,
      },
      'Checking proactive contact conditions'
    );

    // Different logic based on conversation status
    // primaryRecipientId is guaranteed to exist (checked at start of this method)
    const recipientId = this.primaryRecipientId;

    let result: WakeDecision;
    switch (conversationStatus) {
      case 'awaiting_answer':
        result = this.checkFollowUp(
          timeSinceLastMessage,
          state,
          currentPressure,
          conversationStatus,
          recipientId
        );
        break;

      case 'closed':
        result = this.checkClosedConversationContact(
          aggregates,
          state,
          timeSinceLastMessage,
          conversationStatus,
          recipientId
        );
        break;

      case 'active':
      case 'idle':
      case 'unknown':
      default:
        result = this.checkNormalProactiveContact(
          aggregates,
          state,
          timeSinceLastMessage,
          conversationStatus,
          recipientId
        );
    }

    // Add deferral override flag if applicable
    if (result.shouldWake && ackResult.isOverride) {
      result.deferralOverride = true;
    }

    return result;
  }

  /**
   * Check if we should follow up when awaiting answer.
   * This is a gentle "are you still there?" after user went silent.
   */
  private checkFollowUp(
    timeSinceLastMessage: number | null,
    _state: AgentState,
    currentPressure: number,
    conversationStatus: string,
    recipientId: string
  ): WakeDecision {
    if (timeSinceLastMessage === null) {
      return { shouldWake: false, triggerSignals: [] };
    }

    // Only follow up after the configured delay
    if (timeSinceLastMessage < this.contactTiming.awaitingAnswerDelayMs) {
      return { shouldWake: false, triggerSignals: [] };
    }

    this.logger.info(
      { timeSinceLastMessageMin: Math.round(timeSinceLastMessage / 60000) },
      'Triggering follow-up - user has not responded'
    );

    // Record contact and increment follow-up counter
    this.recordProactiveContact();
    this.followUpAttempts++;

    const urgeData: ContactUrgeData = {
      kind: 'contact_urge',
      pressure: currentPressure,
      pressureDelta: 0,
      timeSinceLastContactMs: timeSinceLastMessage,
      conversationStatus,
      followUpAttempts: this.followUpAttempts,
      deferralOverride: false,
      recipientId,
    };

    const triggerSignal = createSignal(
      'contact_urge',
      'meta.threshold_monitor',
      { value: currentPressure, confidence: 1.0 },
      {
        priority: Priority.NORMAL,
        data: urgeData,
      }
    );

    return {
      shouldWake: true,
      trigger: 'threshold_crossed',
      reason: 'Follow-up: user has not responded',
      triggerSignals: [triggerSignal],
      proactiveType: 'follow_up',
    };
  }

  /**
   * Check if we should contact when conversation was closed.
   * Requires much longer wait and higher pressure.
   */
  private checkClosedConversationContact(
    aggregates: SignalAggregate[],
    state: AgentState,
    timeSinceLastMessage: number | null,
    conversationStatus: string,
    recipientId: string
  ): WakeDecision {
    // Must wait at least closedDelayMs before contacting after closed conversation
    if (timeSinceLastMessage === null || timeSinceLastMessage < this.contactTiming.closedDelayMs) {
      return { shouldWake: false, triggerSignals: [] };
    }

    // Use higher threshold for closed conversations
    const contactPressure = aggregates.find((a) => a.type === 'contact_pressure');
    if (!contactPressure) {
      return { shouldWake: false, triggerSignals: [] };
    }

    // Threshold is higher for closed conversations (1.5x normal)
    const threshold = this.calculateAdaptiveThreshold(state) * 1.5;

    if (contactPressure.currentValue < threshold) {
      return { shouldWake: false, triggerSignals: [] };
    }

    this.logger.info(
      {
        pressure: contactPressure.currentValue.toFixed(2),
        threshold: threshold.toFixed(2),
        timeSinceLastMessageHours: Math.round(timeSinceLastMessage / 3600000),
      },
      'Triggering proactive contact after closed conversation'
    );

    this.recordProactiveContact();
    // Reset follow-up attempts on new initiation
    this.followUpAttempts = 0;

    const urgeData: ContactUrgeData = {
      kind: 'contact_urge',
      pressure: contactPressure.currentValue,
      pressureDelta: contactPressure.currentValue - contactPressure.minValue,
      timeSinceLastContactMs: timeSinceLastMessage,
      conversationStatus,
      followUpAttempts: 0,
      deferralOverride: false,
      recipientId,
    };

    const triggerSignal = createSignal(
      'contact_urge',
      'meta.threshold_monitor',
      { value: contactPressure.currentValue, confidence: 1.0 },
      {
        priority: Priority.NORMAL,
        data: urgeData,
      }
    );

    return {
      shouldWake: true,
      trigger: 'threshold_crossed',
      reason: `Initiating contact after closed conversation (pressure ${(contactPressure.currentValue * 100).toFixed(0)}%)`,
      triggerSignals: [triggerSignal],
      threshold,
      value: contactPressure.currentValue,
      proactiveType: 'initiate',
    };
  }

  /**
   * Check normal proactive contact (idle or active conversation).
   */
  private checkNormalProactiveContact(
    aggregates: SignalAggregate[],
    state: AgentState,
    timeSinceLastMessage: number | null,
    conversationStatus: string,
    recipientId: string
  ): WakeDecision {
    // Must wait at least idleDelayMs before contacting
    if (timeSinceLastMessage !== null && timeSinceLastMessage < this.contactTiming.idleDelayMs) {
      return { shouldWake: false, triggerSignals: [] };
    }

    // Check contact pressure against adaptive threshold
    const contactPressure = aggregates.find((a) => a.type === 'contact_pressure');
    if (!contactPressure) {
      return { shouldWake: false, triggerSignals: [] };
    }

    const threshold = this.calculateAdaptiveThreshold(state);

    if (contactPressure.currentValue < threshold) {
      return { shouldWake: false, triggerSignals: [] };
    }

    this.logger.info(
      {
        pressure: contactPressure.currentValue.toFixed(2),
        threshold: threshold.toFixed(2),
      },
      'Triggering proactive contact - pressure threshold crossed'
    );

    this.recordProactiveContact();
    // Reset follow-up attempts on new initiation
    this.followUpAttempts = 0;

    const urgeData: ContactUrgeData = {
      kind: 'contact_urge',
      pressure: contactPressure.currentValue,
      pressureDelta: contactPressure.currentValue - contactPressure.minValue,
      timeSinceLastContactMs: timeSinceLastMessage ?? 0,
      conversationStatus,
      followUpAttempts: 0,
      deferralOverride: false,
      recipientId,
    };

    const triggerSignal = createSignal(
      'contact_urge',
      'meta.threshold_monitor',
      { value: contactPressure.currentValue, confidence: 1.0 },
      {
        priority: Priority.NORMAL,
        data: urgeData,
      }
    );

    return {
      shouldWake: true,
      trigger: 'threshold_crossed',
      reason: `Contact pressure ${(contactPressure.currentValue * 100).toFixed(0)}% >= threshold ${(threshold * 100).toFixed(0)}%`,
      triggerSignals: [triggerSignal],
      threshold,
      value: contactPressure.currentValue,
      proactiveType: 'initiate',
    };
  }

  /**
   * Get conversation status from conversation manager.
   */
  private async getConversationStatus(): Promise<ConversationStatus> {
    if (!this.conversationManager || !this.primaryRecipientId) {
      return 'unknown';
    }

    try {
      const statusInfo = await this.conversationManager.getStatus(this.primaryRecipientId);
      return statusInfo.status as ConversationStatus;
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get conversation status'
      );
      return 'unknown';
    }
  }

  /**
   * Get time since last message in conversation.
   */
  private async getTimeSinceLastMessage(): Promise<number | null> {
    if (!this.conversationManager || !this.primaryRecipientId) {
      return null;
    }

    try {
      const statusInfo = await this.conversationManager.getStatus(this.primaryRecipientId);
      if (statusInfo.lastMessageAt) {
        return Date.now() - statusInfo.lastMessageAt.getTime();
      }
      return null;
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get time since last message'
      );
      return null;
    }
  }

  /**
   * Check if we're in cooldown period.
   */
  private isInCooldown(): boolean {
    if (!this.lastProactiveContact) {
      return false;
    }
    const elapsed = Date.now() - this.lastProactiveContact.getTime();
    return elapsed < this.contactTiming.cooldownMs;
  }

  /**
   * Record that we made a proactive contact attempt.
   */
  private recordProactiveContact(): void {
    this.lastProactiveContact = new Date();
  }

  /**
   * Reset cooldown (e.g., when user contacts us).
   */
  resetCooldown(): void {
    this.lastProactiveContact = null;
    this.followUpAttempts = 0;
    this.ackRegistry.clearAll();
  }

  /**
   * Calculate adaptive threshold based on agent state.
   */
  private calculateAdaptiveThreshold(state: AgentState): number {
    let threshold = this.config.contactPressure;

    // Low energy makes it harder to contact
    if (state.energy < this.config.lowEnergy) {
      threshold *= this.config.lowEnergyMultiplier;
    }

    // Cap at reasonable maximum
    return Math.min(threshold, 0.95);
  }

  /**
   * Get current thresholds (for debugging).
   */
  getThresholds(): WakeThresholdConfig {
    return { ...this.config };
  }

  /**
   * Get contact timing config (for debugging).
   */
  getContactTiming(): ContactTimingConfig {
    return { ...this.contactTiming };
  }

  /**
   * Save facts from fact_batch signals to memory.
   *
   * Facts are stored with type='fact' and can be queried later by COGNITION.
   * This happens silently without waking COGNITION - like forming memories
   * in the background while the conscious mind is occupied elsewhere.
   */
  private async saveFactsToMemory(factBatchSignals: Signal[]): Promise<void> {
    if (!this.memoryProvider) {
      this.logger.debug(
        { count: factBatchSignals.length },
        'Fact batches received but no memoryProvider configured, skipping'
      );
      return;
    }

    let savedCount = 0;
    let errorCount = 0;

    for (const signal of factBatchSignals) {
      const data = signal.data as FactBatchData | undefined;
      if (!data) {
        continue;
      }

      for (const fact of data.facts) {
        try {
          const entry = this.factToMemoryEntry(fact, signal, data);
          await this.memoryProvider.save(entry);
          savedCount++;
        } catch (error) {
          errorCount++;
          this.logger.warn(
            {
              factContent: fact.content.slice(0, 50),
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to save fact to memory'
          );
        }
      }
    }

    this.logger.debug(
      { saved: savedCount, errors: errorCount, batches: factBatchSignals.length },
      'Facts saved to memory'
    );
  }

  /**
   * Convert a generic Fact to a MemoryEntry.
   *
   * Maps plugin-agnostic Fact fields to memory storage format:
   * - content → content (the fact itself)
   * - confidence → confidence (relevance score)
   * - tags → tags (for search/retrieval)
   * - provenance → metadata (origin information)
   */
  private factToMemoryEntry(fact: Fact, signal: Signal, batchData: FactBatchData): MemoryEntry {
    // Generate deterministic ID for deduplication
    // Priority: originalId (most stable) -> url (unique per article) -> content hash (last resort)
    const uniqueKey =
      fact.provenance.originalId ?? fact.provenance.url ?? this.hashContent(fact.content);

    // Hash the full key instead of base64-truncating (truncation causes collisions for same-domain URLs)
    const id = `fact-${batchData.pluginId}-${this.hashContent(uniqueKey)}`;

    return {
      id,
      type: 'fact',
      content: fact.content,
      timestamp: fact.provenance.timestamp ?? new Date(),
      tags: fact.tags,
      confidence: fact.confidence,
      metadata: {
        pluginId: batchData.pluginId,
        eventKind: batchData.eventKind,
        ...fact.provenance,
      },
      parentSignalId: signal.id,
    };
  }

  /**
   * Hash content for deterministic ID generation.
   * Normalizes content to handle minor variations (whitespace, case).
   */
  private hashContent(content: string): string {
    // Normalize: lowercase, collapse whitespace
    const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
    // Simple hash - just need determinism, not cryptographic security
    let hash = 0;
    for (const char of normalized) {
      hash = (hash << 5) - hash + char.charCodeAt(0);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }
}

/**
 * Create a threshold engine.
 */
export function createThresholdEngine(
  logger: Logger,
  config?: Partial<WakeThresholdConfig>,
  contactTiming?: Partial<ContactTimingConfig>
): ThresholdEngine {
  return new ThresholdEngine(logger, config, contactTiming);
}
