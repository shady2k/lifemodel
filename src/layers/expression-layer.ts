import type { LayerResult, Logger, Intent } from '../types/index.js';
import type { ProcessingContext, ActionType } from './context.js';
import { BaseLayer } from './base-layer.js';

/**
 * Layer 5: EXPRESSION
 *
 * Composes output messages and actions.
 * "What should I say/do?"
 *
 * Handles:
 * - Message composition
 * - Action execution preparation
 * - Intent generation for side effects
 *
 * Cost: High (needs LLM for natural responses, templates for MVP)
 */
export class ExpressionLayer extends BaseLayer {
  readonly name = 'expression';
  readonly confidenceThreshold = 0.9; // Final layer, high threshold

  // Template responses for MVP (will use LLM later)
  private readonly templates: Record<string, string[]> = {
    greeting_en: ['Hi!', 'Hello!', 'Hey there!', 'Hi, how are you?'],
    greeting_ru: ['Привет!', 'Здравствуй!', 'Привет, как дела?'],
    farewell_en: ['Bye!', 'See you!', 'Take care!', 'Goodbye!'],
    farewell_ru: ['Пока!', 'До свидания!', 'Увидимся!'],
    ack_en: ['Got it!', 'Okay!', 'Sure!', 'Understood.', 'Alright!'],
    ack_ru: ['Понял!', 'Хорошо!', 'Ладно!', 'Окей!'],
    positive_en: ["That's great to hear!", 'Awesome!', 'Glad to help!'],
    positive_ru: ['Это здорово!', 'Отлично!', 'Рад помочь!'],
    negative_en: ["I'm sorry to hear that.", 'I understand.', "That's unfortunate."],
    negative_ru: ['Мне жаль это слышать.', 'Понимаю.', 'Это печально.'],
    thinking_en: [
      'Let me think about that...',
      "I'm not sure, let me consider...",
      "That's an interesting question...",
    ],
    thinking_ru: ['Дай подумать...', 'Не уверен, дай обдумаю...', 'Интересный вопрос...'],
  };

  constructor(logger: Logger) {
    super(logger, 'expression');
  }

  protected processImpl(context: ProcessingContext): LayerResult {
    context.stage = 'expression';

    const { decision } = context;
    const intents: Intent[] = [];

    // If no decision or shouldn't act, nothing to express
    if (!decision?.shouldAct) {
      return this.stop(context);
    }

    // Generate appropriate response based on action type
    const response = this.generateResponse(context, decision.actionType);

    if (response) {
      // Create send message intent
      const payload: { channel: string; text: string; target?: string } = {
        channel: context.event.channel ?? 'default',
        text: response,
      };

      const target = this.extractTarget(context);
      if (target) {
        payload.target = target;
      }

      intents.push({
        type: 'SEND_MESSAGE',
        payload,
      });

      this.logger.debug(
        { response: response.substring(0, 50), actionType: decision.actionType },
        'Response generated'
      );
    }

    // Log the decision
    intents.push({
      type: 'LOG',
      payload: {
        level: 'info',
        message: `Action: ${decision.actionType} - ${decision.reason}`,
        context: {
          eventId: context.event.id,
          hasResponse: !!response,
        },
      },
    });

    return this.stop(context, { intents });
  }

  private generateResponse(context: ProcessingContext, actionType: ActionType): string | null {
    const { perception } = context;

    if (actionType === 'ignore' || actionType === 'remember') {
      return null;
    }

    if (actionType === 'defer') {
      // Acknowledge but indicate we'll respond later
      return this.getTemplate('ack', perception?.language ?? 'en');
    }

    // Determine language
    const lang = perception?.language ?? 'en';

    // Handle by action type and intent
    if (actionType === 'acknowledge') {
      return this.generateAcknowledgment(context, lang);
    }

    if (actionType === 'respond') {
      return this.generateFullResponse(context, lang);
    }

    // Default acknowledgment
    return this.getTemplate('ack', lang);
  }

  private generateAcknowledgment(context: ProcessingContext, lang: string): string {
    const { interpretation } = context;

    if (!interpretation) {
      return this.getTemplate('ack', lang);
    }

    switch (interpretation.intent) {
      case 'greeting':
        return this.getTemplate('greeting', lang);

      case 'farewell':
        return this.getTemplate('farewell', lang);

      case 'feedback_positive':
        return this.getTemplate('positive', lang);

      case 'feedback_negative':
        return this.getTemplate('negative', lang);

      default:
        return this.getTemplate('ack', lang);
    }
  }

  private generateFullResponse(context: ProcessingContext, lang: string): string {
    const { interpretation, cognition, decision } = context;

    // For complex responses that need LLM, return a placeholder
    // In production, this would call the LLM
    if (cognition?.needsReasoning) {
      return this.getTemplate('thinking', lang);
    }

    // Handle specific intents
    if (interpretation) {
      switch (interpretation.intent) {
        case 'greeting':
          return this.getTemplate('greeting', lang);

        case 'farewell':
          return this.getTemplate('farewell', lang);

        case 'question':
          // MVP: indicate we're thinking (would use LLM in production)
          return this.getTemplate('thinking', lang);

        case 'request':
          // MVP: acknowledge the request
          return this.getTemplate('ack', lang);

        case 'emotional_expression':
          if (interpretation.sentiment === 'negative') {
            return this.getTemplate('negative', lang);
          }
          return this.getTemplate('positive', lang);
      }
    }

    // Apply tone constraint if present
    if (decision?.constraints?.tone === 'empathetic') {
      return this.getTemplate('negative', lang);
    }

    // Default response
    return this.getTemplate('ack', lang);
  }

  private getTemplate(type: string, lang: string): string {
    const key = `${type}_${lang}`;
    const fallbackKey = `${type}_en`;

    const templates = this.templates[key] ?? this.templates[fallbackKey] ?? ['...'];
    const randomIndex = Math.floor(Math.random() * templates.length);
    return templates[randomIndex] ?? '...';
  }

  private extractTarget(context: ProcessingContext): string | undefined {
    const { payload } = context.event;

    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (typeof p['userId'] === 'string') return p['userId'];
      if (typeof p['chatId'] === 'string') return p['chatId'];
      if (typeof p['from'] === 'string') return p['from'];
    }

    return undefined;
  }
}

/**
 * Factory function.
 */
export function createExpressionLayer(logger: Logger): ExpressionLayer {
  return new ExpressionLayer(logger);
}
