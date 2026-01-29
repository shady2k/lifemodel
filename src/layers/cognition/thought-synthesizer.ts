/**
 * Thought Synthesizer
 *
 * Analyzes the aggregated context and synthesizes understanding.
 * Determines what's happening and what might need to happen.
 *
 * This is the "what's going on?" part of cognition:
 * - Interprets trigger signals
 * - Understands the situation
 * - Prepares context for decision-making
 */

import type { Signal, SignalAggregate, UserMessageData } from '../../types/signal.js';
import type { CognitionContext } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';

/**
 * Configuration for thought synthesizer.
 */
export interface ThoughtSynthesizerConfig {
  /** Confidence threshold for simple responses (default: 0.8) */
  simpleResponseThreshold: number;
}

// Config is currently not used but interface is exported for future use

/**
 * Situation type - what kind of situation we're in.
 */
export type SituationType =
  | 'user_message' // User sent a message - need to respond
  | 'proactive_contact' // Pressure threshold crossed - consider reaching out
  | 'pattern_anomaly' // Something unusual detected
  | 'channel_issue' // Channel problem
  | 'time_event' // Time-based trigger (morning, etc.)
  | 'unknown'; // Couldn't determine

/**
 * Message complexity assessment.
 */
export interface MessageComplexity {
  /** Is this a simple message? */
  isSimple: boolean;

  /** Complexity score (0-1) */
  score: number;

  /** Reasons for complexity assessment */
  reasons: string[];
}

/**
 * Result of thought synthesis.
 */
export interface SynthesisResult {
  /** What type of situation is this? */
  situation: SituationType;

  /** Should we respond to the user? */
  requiresResponse: boolean;

  /** Should we initiate contact? */
  initiateContact: boolean;

  /** Message text (if user_message) */
  messageText?: string;

  /** Recipient ID (if user_message) */
  recipientId?: string;

  /** User ID (if available) */
  userId?: string;

  /** Message complexity (if user_message) */
  complexity?: MessageComplexity;

  /** Contact pressure value (if proactive) */
  contactPressure?: number;

  /** Social debt value (if proactive) */
  socialDebt?: number;

  /** Summary of what's happening */
  summary: string;

  /** Any anomalies detected */
  anomalies: string[];
}

/**
 * Thought Synthesizer implementation.
 */
export class ThoughtSynthesizer {
  private readonly logger: Logger;

  constructor(logger: Logger, _config: Partial<ThoughtSynthesizerConfig> = {}) {
    this.logger = logger.child({ component: 'thought-synthesizer' });
  }

  /**
   * Synthesize understanding from the cognition context.
   *
   * @param context Context from AGGREGATION layer
   * @returns Synthesis result with situation understanding
   */
  synthesize(context: CognitionContext): SynthesisResult {
    const { triggerSignals, wakeReason, aggregates } = context;

    // Check for user message first (highest priority)
    const userMessageSignal = triggerSignals.find((s) => s.type === 'user_message');
    if (userMessageSignal) {
      return this.synthesizeUserMessage(userMessageSignal, aggregates);
    }

    // Check for proactive contact triggers
    if (
      wakeReason === 'threshold_crossed' ||
      triggerSignals.some((s) => s.type === 'contact_pressure' || s.type === 'social_debt')
    ) {
      return this.synthesizeProactiveContact(triggerSignals, aggregates);
    }

    // Check for pattern anomalies
    if (wakeReason === 'pattern_break' || triggerSignals.some((s) => s.type === 'pattern_break')) {
      return this.synthesizePatternAnomaly(triggerSignals);
    }

    // Check for channel issues
    if (wakeReason === 'channel_error' || triggerSignals.some((s) => s.type === 'channel_error')) {
      return this.synthesizeChannelIssue(triggerSignals);
    }

    // Check for time events
    if (triggerSignals.some((s) => s.type === 'time_of_day' || s.type === 'hour_changed')) {
      return this.synthesizeTimeEvent(triggerSignals);
    }

    // Unknown situation
    this.logger.warn(
      { wakeReason, triggerCount: triggerSignals.length },
      'Could not determine situation type'
    );

    return {
      situation: 'unknown',
      requiresResponse: false,
      initiateContact: false,
      summary: `Unknown wake reason: ${wakeReason}`,
      anomalies: [],
    };
  }

  /**
   * Synthesize understanding for user message.
   */
  private synthesizeUserMessage(signal: Signal, _aggregates: SignalAggregate[]): SynthesisResult {
    const data = signal.data as UserMessageData | undefined;

    if (data?.kind !== 'user_message') {
      this.logger.error({ signal }, 'User message signal missing data');
      return {
        situation: 'user_message',
        requiresResponse: true,
        initiateContact: false,
        summary: 'User message received but data missing',
        anomalies: ['missing_message_data'],
      };
    }

    const complexity = this.assessMessageComplexity(data.text);

    this.logger.debug(
      {
        messageLength: data.text.length,
        complexity: complexity.score,
        isSimple: complexity.isSimple,
      },
      'User message synthesized'
    );

    return {
      situation: 'user_message',
      requiresResponse: true,
      initiateContact: false,
      messageText: data.text,
      recipientId: data.recipientId,
      userId: data.userId ?? data.recipientId,
      complexity,
      summary: `User message: "${data.text.slice(0, 50)}${data.text.length > 50 ? '...' : ''}"`,
      anomalies: [],
    };
  }

  /**
   * Synthesize understanding for proactive contact trigger.
   */
  private synthesizeProactiveContact(
    signals: Signal[],
    aggregates: SignalAggregate[]
  ): SynthesisResult {
    // Find contact pressure and social debt values
    const contactPressureSignal = signals.find((s) => s.type === 'contact_pressure');
    const socialDebtSignal = signals.find((s) => s.type === 'social_debt');

    // Also check aggregates for current values
    const contactPressureAgg = aggregates.find(
      (a) => a.type === 'contact_pressure' && a.source === 'neuron.contact_pressure'
    );
    const socialDebtAgg = aggregates.find(
      (a) => a.type === 'social_debt' && a.source === 'neuron.social_debt'
    );

    const contactPressure =
      contactPressureSignal?.metrics.value ?? contactPressureAgg?.currentValue ?? 0;
    const socialDebt = socialDebtSignal?.metrics.value ?? socialDebtAgg?.currentValue ?? 0;

    this.logger.debug({ contactPressure, socialDebt }, 'Proactive contact synthesized');

    return {
      situation: 'proactive_contact',
      requiresResponse: false,
      initiateContact: true,
      contactPressure,
      socialDebt,
      summary: `Proactive contact trigger: pressure=${contactPressure.toFixed(2)}, debt=${socialDebt.toFixed(2)}`,
      anomalies: [],
    };
  }

  /**
   * Synthesize understanding for pattern anomaly.
   */
  private synthesizePatternAnomaly(signals: Signal[]): SynthesisResult {
    const anomalies = signals
      .filter((s) => s.type === 'pattern_break')
      .map((s) => {
        const data = s.data as { description?: string } | undefined;
        return data?.description ?? 'Unknown pattern break';
      });

    return {
      situation: 'pattern_anomaly',
      requiresResponse: false,
      initiateContact: false,
      summary: `Pattern anomaly detected: ${anomalies.join(', ')}`,
      anomalies,
    };
  }

  /**
   * Synthesize understanding for channel issue.
   */
  private synthesizeChannelIssue(signals: Signal[]): SynthesisResult {
    const issues = signals
      .filter((s) => s.type === 'channel_error')
      .map((s) => {
        const data = s.data as { error?: string; channel?: string } | undefined;
        return `${data?.channel ?? 'unknown'}: ${data?.error ?? 'unknown error'}`;
      });

    return {
      situation: 'channel_issue',
      requiresResponse: false,
      initiateContact: false,
      summary: `Channel issue: ${issues.join(', ')}`,
      anomalies: issues,
    };
  }

  /**
   * Synthesize understanding for time event.
   */
  private synthesizeTimeEvent(signals: Signal[]): SynthesisResult {
    const timeSignal = signals.find((s) => s.type === 'time_of_day' || s.type === 'hour_changed');
    const data = timeSignal?.data as { timeOfDay?: string } | undefined;

    return {
      situation: 'time_event',
      requiresResponse: false,
      initiateContact: false,
      summary: `Time event: ${data?.timeOfDay ?? 'unknown'}`,
      anomalies: [],
    };
  }

  /**
   * Assess the complexity of a user message.
   *
   * Determines if the fast model can likely handle this or if
   * we need the smart model.
   */
  private assessMessageComplexity(text: string): MessageComplexity {
    const reasons: string[] = [];
    let score = 0;

    const length = text.length;
    const hasQuestion = text.includes('?');
    const questionCount = (text.match(/\?/g) ?? []).length;
    const hasMultipleSentences = (text.match(/[.!?]+/g) ?? []).length > 2;
    const hasCodeIndicators = /```|`[^`]+`|function|const |let |var |=>/.test(text);
    const hasComplexVocabulary =
      /\b(explain|analyze|compare|evaluate|synthesize|hypothesize)\b/i.test(text);
    const hasNumbersOrMath = /\d+\s*[+\-*/=]\s*\d+/.test(text);

    // Simple greetings and acknowledgments
    const isSimpleGreeting =
      /^(hi|hello|hey|привет|здравствуй|good morning|good evening|доброе утро|добрый день|добрый вечер)[!.,]?\s*$/i.test(
        text.trim()
      );
    const isSimpleAcknowledgment =
      /^(ok|okay|thanks|thank you|спасибо|ок|хорошо|понял|ясно)[!.,]?\s*$/i.test(text.trim());
    const isSimpleFarewell = /^(bye|goodbye|пока|до свидания|спокойной ночи)[!.,]?\s*$/i.test(
      text.trim()
    );

    if (isSimpleGreeting || isSimpleAcknowledgment || isSimpleFarewell) {
      return {
        isSimple: true,
        score: 0.1,
        reasons: ['simple_social_interaction'],
      };
    }

    // Length factor
    if (length > 500) {
      score += 0.3;
      reasons.push('long_message');
    } else if (length > 200) {
      score += 0.15;
      reasons.push('moderate_length');
    } else if (length < 50) {
      score -= 0.1;
      reasons.push('short_message');
    }

    // Question complexity
    if (questionCount > 2) {
      score += 0.2;
      reasons.push('multiple_questions');
    } else if (hasQuestion) {
      score += 0.1;
      reasons.push('has_question');
    }

    // Structure
    if (hasMultipleSentences) {
      score += 0.1;
      reasons.push('multiple_sentences');
    }

    // Technical content
    if (hasCodeIndicators) {
      score += 0.3;
      reasons.push('code_content');
    }

    // Complex vocabulary
    if (hasComplexVocabulary) {
      score += 0.2;
      reasons.push('complex_vocabulary');
    }

    // Math
    if (hasNumbersOrMath) {
      score += 0.15;
      reasons.push('math_content');
    }

    // Normalize score to 0-1
    score = Math.max(0, Math.min(1, score));

    const isSimple = score < 0.3;

    return {
      isSimple,
      score,
      reasons,
    };
  }
}

/**
 * Create a thought synthesizer.
 */
export function createThoughtSynthesizer(
  logger: Logger,
  config?: Partial<ThoughtSynthesizerConfig>
): ThoughtSynthesizer {
  return new ThoughtSynthesizer(logger, config);
}
