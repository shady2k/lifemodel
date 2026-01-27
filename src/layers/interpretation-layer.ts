import type { LayerResult, Logger } from '../types/index.js';
import { Priority } from '../types/index.js';
import type {
  ProcessingContext,
  InterpretationOutput,
  UserIntent,
  Sentiment,
  PerceptionOutput,
} from './context.js';
import { BaseLayer } from './base-layer.js';

/**
 * Layer 2: INTERPRETATION
 *
 * Interprets meaning from perceived content.
 * "What does this mean in context?"
 *
 * Handles:
 * - Intent classification
 * - Sentiment analysis
 * - Urgency detection
 * - Response requirement detection
 *
 * Cost: Low (heuristics for MVP, could use small model later)
 */
export class InterpretationLayer extends BaseLayer {
  readonly name = 'interpretation';
  readonly confidenceThreshold = 0.6;

  // Positive sentiment indicators
  private readonly positivePatterns = [
    /\b(thanks?|thank\s*you|great|awesome|excellent|good|nice|love|happy|glad|wonderful|perfect|amazing)\b/i,
    /\b(спасибо|отлично|хорошо|прекрасно|замечательно|супер|класс|круто|люблю|рад)\b/i,
    /(?:😊|😄|😃|🙂|👍|❤️|🎉|✨|💯|🔥)/u,
  ];

  // Negative sentiment indicators
  private readonly negativePatterns = [
    /\b(bad|terrible|awful|horrible|hate|angry|upset|disappointed|frustrated|annoying|stupid)\b/i,
    /\b(плохо|ужасно|отвратительно|ненавижу|злой|расстроен|разочарован|бесит|тупой)\b/i,
    /[😢😞😠😡👎💔😤]/u,
  ];

  // Busy/unavailable signals
  private readonly busyPatterns = [
    /\b(busy|later|not\s*now|can't\s*talk|in\s*a\s*meeting|working)\b/i,
    /\b(занят|потом|не\s*сейчас|на\s*встрече|работаю)\b/i,
  ];

  // Availability signals
  private readonly availablePatterns = [
    /\b(free|available|ready|here|what's\s*up|bored)\b/i,
    /\b(свободен|доступен|готов|тут|скучно|что\s*делаешь)\b/i,
  ];

  constructor(logger: Logger) {
    super(logger, 'interpretation');
  }

  protected processImpl(context: ProcessingContext): LayerResult {
    context.stage = 'interpretation';

    // Need perception output to interpret
    if (!context.perception) {
      // No perception data - can't interpret well
      return this.success(context, 0.3);
    }

    const { perception } = context;

    // Determine intent
    const intent = this.detectIntent(context);
    const intentConfidence = this.calculateIntentConfidence(intent, perception);

    // Analyze sentiment
    const { sentiment, strength } = this.analyzeSentiment(perception.text ?? '');

    // Calculate urgency
    const urgency = this.calculateUrgency(context);

    // Does this require a response?
    const requiresResponse = this.checkRequiresResponse(intent, perception);

    // Determine response priority
    const responsePriority = this.determineResponsePriority(intent, urgency, sentiment);

    const interpretation: InterpretationOutput = {
      intent,
      intentConfidence,
      sentiment,
      sentimentStrength: strength,
      urgency,
      requiresResponse,
      responsePriority,
    };

    context.interpretation = interpretation;

    // Overall confidence based on intent confidence
    const confidence = intentConfidence;

    this.logger.debug(
      {
        eventId: context.event.id,
        intent,
        intentConfidence: intentConfidence.toFixed(2),
        sentiment,
        sentimentStrength: strength.toFixed(2),
        urgency: urgency.toFixed(2),
        requiresResponse,
        responsePriority,
      },
      'Interpretation complete'
    );

    return this.success(context, confidence);
  }

  private detectIntent(context: ProcessingContext): UserIntent {
    const { perception } = context;
    if (!perception) return 'unknown';

    const text = perception.text ?? '';

    // Map content type to intent
    switch (perception.contentType) {
      case 'greeting':
        return 'greeting';

      case 'farewell':
        return 'farewell';

      case 'acknowledgment':
        return 'acknowledgment';

      case 'question':
        return 'question';

      case 'command':
        return 'request';

      case 'emotional':
        return 'emotional_expression';
    }

    // Check for specific intents in text
    if (this.busyPatterns.some((p) => p.test(text))) {
      return 'busy_signal';
    }

    if (this.availablePatterns.some((p) => p.test(text))) {
      return 'availability_signal';
    }

    if (this.positivePatterns.some((p) => p.test(text))) {
      // Could be feedback or just positive expression
      if (text.length < 30) {
        return 'feedback_positive';
      }
      return 'emotional_expression';
    }

    if (this.negativePatterns.some((p) => p.test(text))) {
      if (text.length < 30) {
        return 'feedback_negative';
      }
      return 'emotional_expression';
    }

    // Default based on content
    if (perception.isQuestion) {
      return 'question';
    }

    if (perception.contentType === 'text') {
      return 'information';
    }

    return 'small_talk';
  }

  private calculateIntentConfidence(intent: UserIntent, perception: PerceptionOutput): number {
    // High confidence for clear content types
    if (perception.contentType !== 'unknown' && perception.contentType !== 'text') {
      return 0.85;
    }

    // Lower confidence for inferred intents
    switch (intent) {
      case 'greeting':
      case 'farewell':
      case 'acknowledgment':
        return 0.9;

      case 'question':
      case 'request':
        return 0.8;

      case 'feedback_positive':
      case 'feedback_negative':
        return 0.75;

      case 'busy_signal':
      case 'availability_signal':
        return 0.7;

      case 'information':
      case 'small_talk':
        return 0.6;

      case 'emotional_expression':
        return 0.65;

      default:
        return 0.4;
    }
  }

  private analyzeSentiment(text: string): { sentiment: Sentiment; strength: number } {
    let positiveScore = 0;
    let negativeScore = 0;

    // Count positive indicators
    for (const pattern of this.positivePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        positiveScore += matches.length;
      }
    }

    // Count negative indicators
    for (const pattern of this.negativePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        negativeScore += matches.length;
      }
    }

    // Determine sentiment
    const total = positiveScore + negativeScore;

    if (total === 0) {
      return { sentiment: 'neutral', strength: 0 };
    }

    if (positiveScore > 0 && negativeScore > 0) {
      const diff = Math.abs(positiveScore - negativeScore);
      if (diff < 2) {
        return { sentiment: 'mixed', strength: 0.3 };
      }
    }

    if (positiveScore > negativeScore) {
      const strength = Math.min(1, positiveScore / 3);
      return { sentiment: 'positive', strength };
    }

    if (negativeScore > positiveScore) {
      const strength = Math.min(1, negativeScore / 3);
      return { sentiment: 'negative', strength: -strength };
    }

    return { sentiment: 'neutral', strength: 0 };
  }

  private calculateUrgency(context: ProcessingContext): number {
    const { event, perception } = context;

    // Base urgency from event priority
    let urgency = 0;
    switch (event.priority) {
      case Priority.CRITICAL:
        urgency = 1.0;
        break;
      case Priority.HIGH:
        urgency = 0.7;
        break;
      case Priority.NORMAL:
        urgency = 0.4;
        break;
      default:
        urgency = 0.2;
    }

    // Adjust based on content
    if (perception) {
      // Questions increase urgency slightly
      if (perception.isQuestion) {
        urgency = Math.min(1, urgency + 0.1);
      }

      // Commands increase urgency
      if (perception.isCommand) {
        urgency = Math.min(1, urgency + 0.15);
      }

      // Short messages often expect quick response
      if (perception.text && perception.text.length < 20) {
        urgency = Math.min(1, urgency + 0.05);
      }
    }

    return urgency;
  }

  private checkRequiresResponse(intent: UserIntent, perception: PerceptionOutput): boolean {
    // These intents typically require a response
    const responseRequired: UserIntent[] = [
      'greeting',
      'question',
      'request',
      'emotional_expression',
    ];

    if (responseRequired.includes(intent)) {
      return true;
    }

    // Questions always need response
    if (perception.isQuestion) {
      return true;
    }

    // Commands/requests need response
    if (perception.isCommand) {
      return true;
    }

    // These don't need a response
    const noResponse: UserIntent[] = ['farewell', 'acknowledgment', 'busy_signal'];

    if (noResponse.includes(intent)) {
      return false;
    }

    // Default: informational content doesn't require response
    return false;
  }

  private determineResponsePriority(
    intent: UserIntent,
    urgency: number,
    sentiment: Sentiment
  ): Priority {
    // Critical: negative sentiment with high urgency
    if (sentiment === 'negative' && urgency > 0.7) {
      return Priority.HIGH;
    }

    // High: questions, requests
    if (intent === 'question' || intent === 'request') {
      return Priority.HIGH;
    }

    // Normal: greetings, general conversation
    if (intent === 'greeting' || intent === 'small_talk') {
      return Priority.NORMAL;
    }

    // Low: acknowledgments, info
    if (intent === 'acknowledgment' || intent === 'information') {
      return Priority.LOW;
    }

    // Based on urgency
    if (urgency > 0.6) {
      return Priority.HIGH;
    }
    if (urgency > 0.3) {
      return Priority.NORMAL;
    }

    return Priority.LOW;
  }
}

/**
 * Factory function.
 */
export function createInterpretationLayer(logger: Logger): InterpretationLayer {
  return new InterpretationLayer(logger);
}
