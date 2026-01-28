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

import type { Signal, SignalAggregate } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import { Priority } from '../../types/priority.js';
import type { AgentState } from '../../types/agent/state.js';
import type { WakeTrigger, WakeThresholdConfig } from '../../types/layers.js';
import { DEFAULT_WAKE_THRESHOLDS } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';

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
  /** Minimum cooldown between any proactive contacts (ms) - default 5 min */
  cooldownMs: number;
  /** User availability threshold below which we don't contact (0-1) */
  lowAvailabilityThreshold: number;
}

const DEFAULT_CONTACT_TIMING: ContactTimingConfig = {
  awaitingAnswerDelayMs: 3 * 60 * 1000, // 3 minutes
  idleDelayMs: 30 * 60 * 1000, // 30 minutes
  closedDelayMs: 4 * 60 * 60 * 1000, // 4 hours
  cooldownMs: 5 * 60 * 1000, // 5 minutes
  lowAvailabilityThreshold: 0.25,
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
}

/**
 * Dependencies for ThresholdEngine.
 */
export interface ThresholdEngineDeps {
  conversationManager?: ConversationManager;
  userModel?: UserModel;
  primaryUserChatId?: string;
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
  private primaryUserChatId: string | undefined;

  // Cooldown tracking
  private lastProactiveContact: Date | null = null;

  constructor(
    logger: Logger,
    config: Partial<WakeThresholdConfig> = {},
    contactTiming: Partial<ContactTimingConfig> = {}
  ) {
    this.logger = logger.child({ component: 'threshold-engine' });
    this.config = { ...DEFAULT_WAKE_THRESHOLDS, ...config };
    this.contactTiming = { ...DEFAULT_CONTACT_TIMING, ...contactTiming };
  }

  /**
   * Update dependencies (called when they become available).
   */
  updateDeps(deps: ThresholdEngineDeps): void {
    if (deps.conversationManager) this.conversationManager = deps.conversationManager;
    if (deps.userModel) this.userModel = deps.userModel;
    if (deps.primaryUserChatId) this.primaryUserChatId = deps.primaryUserChatId;
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
      // Reset cooldown when user contacts us
      this.lastProactiveContact = null;
      return {
        shouldWake: true,
        trigger: 'user_message',
        reason: 'User sent a message',
        triggerSignals: userMessages,
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
   * This is conversation-status-aware.
   */
  private async checkProactiveContact(
    aggregates: SignalAggregate[],
    state: AgentState
  ): Promise<WakeDecision> {
    // Need primary user chat ID for proactive contact
    if (!this.primaryUserChatId) {
      this.logger.debug('Skipping proactive contact - no primary user chat ID configured');
      return { shouldWake: false, triggerSignals: [] };
    }

    // Check cooldown first
    if (this.isInCooldown()) {
      return { shouldWake: false, triggerSignals: [] };
    }

    // Check user availability
    const userAvailability = this.userModel?.getBeliefs().availability ?? 0.5;
    if (userAvailability < this.contactTiming.lowAvailabilityThreshold) {
      this.logger.debug(
        { availability: userAvailability.toFixed(2) },
        'Skipping proactive contact - user availability too low'
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
      },
      'Checking proactive contact conditions'
    );

    // Different logic based on conversation status
    switch (conversationStatus) {
      case 'awaiting_answer':
        return this.checkFollowUp(timeSinceLastMessage, state);

      case 'closed':
        return this.checkClosedConversationContact(aggregates, state, timeSinceLastMessage);

      case 'active':
      case 'idle':
      case 'unknown':
      default:
        return this.checkNormalProactiveContact(aggregates, state, timeSinceLastMessage);
    }
  }

  /**
   * Check if we should follow up when awaiting answer.
   * This is a gentle "are you still there?" after user went silent.
   */
  private checkFollowUp(timeSinceLastMessage: number | null, _state: AgentState): WakeDecision {
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

    // Record contact and create trigger
    this.recordProactiveContact();

    const triggerSignal = createSignal(
      'threshold_crossed',
      'meta.threshold_monitor',
      { value: 1.0, confidence: 1.0 },
      {
        priority: Priority.NORMAL,
        data: {
          kind: 'threshold',
          thresholdName: 'proactive_follow_up',
          value: 1.0,
          threshold: 0,
          direction: 'above',
          chatId: this.primaryUserChatId,
          channel: 'telegram',
        },
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
    timeSinceLastMessage: number | null
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

    const triggerSignal = createSignal(
      'threshold_crossed',
      'meta.threshold_monitor',
      { value: contactPressure.currentValue, confidence: 1.0 },
      {
        priority: Priority.NORMAL,
        data: {
          kind: 'threshold',
          thresholdName: 'proactive_initiate_closed',
          value: contactPressure.currentValue,
          threshold,
          direction: 'above',
          chatId: this.primaryUserChatId,
          channel: 'telegram',
        },
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
    timeSinceLastMessage: number | null
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

    const triggerSignal = createSignal(
      'threshold_crossed',
      'meta.threshold_monitor',
      { value: contactPressure.currentValue, confidence: 1.0 },
      {
        priority: Priority.NORMAL,
        data: {
          kind: 'threshold',
          thresholdName: 'proactive_initiate',
          value: contactPressure.currentValue,
          threshold,
          direction: 'above',
          chatId: this.primaryUserChatId,
          channel: 'telegram',
        },
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
    if (!this.conversationManager || !this.primaryUserChatId) {
      return 'unknown';
    }

    try {
      const statusInfo = await this.conversationManager.getStatus(this.primaryUserChatId);
      return statusInfo.status as ConversationStatus;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get time since last message in conversation.
   */
  private async getTimeSinceLastMessage(): Promise<number | null> {
    if (!this.conversationManager || !this.primaryUserChatId) {
      return null;
    }

    try {
      const statusInfo = await this.conversationManager.getStatus(this.primaryUserChatId);
      if (statusInfo.lastMessageAt) {
        return Date.now() - statusInfo.lastMessageAt.getTime();
      }
      return null;
    } catch {
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
