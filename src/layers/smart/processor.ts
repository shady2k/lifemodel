/**
 * SMART Layer Processor
 *
 * Complex reasoning using expensive LLM.
 * Only called when COGNITION layer is uncertain.
 *
 * Like deep deliberate thinking:
 * - Takes more time
 * - Uses more resources
 * - Produces higher quality results
 * - Only engaged when necessary
 */

import type { SmartLayer, SmartContext, SmartResult } from '../../types/layers.js';
import type { Intent } from '../../types/intent.js';
import type { Logger } from '../../types/logger.js';
import type { MessageComposer } from '../../llm/composer.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';
import type { EventBus } from '../../core/event-bus.js';
import type { Event } from '../../types/index.js';
import { Priority } from '../../types/index.js';
import { randomUUID } from 'node:crypto';

import {
  EscalationHandler,
  createEscalationHandler,
  type EscalationHandlerConfig,
} from './escalation-handler.js';

/**
 * Configuration for SMART processor.
 */
export interface SmartProcessorConfig {
  /** Escalation handler config */
  escalation: Partial<EscalationHandlerConfig>;

  /** Emit typing indicator before LLM calls */
  emitTypingIndicator: boolean;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: SmartProcessorConfig = {
  escalation: {},
  emitTypingIndicator: true,
};

/**
 * Dependencies for SMART processor.
 */
export interface SmartProcessorDeps {
  composer?: MessageComposer | undefined;
  conversationManager?: ConversationManager | undefined;
  userModel?: UserModel | undefined;
  eventBus?: EventBus | undefined;
}

/**
 * SMART layer processor implementation.
 */
export class SmartProcessor implements SmartLayer {
  readonly name = 'smart' as const;

  private readonly escalationHandler: EscalationHandler;
  private readonly config: SmartProcessorConfig;
  private readonly logger: Logger;

  private eventBus: EventBus | undefined;

  constructor(
    logger: Logger,
    config: Partial<SmartProcessorConfig> = {},
    deps?: SmartProcessorDeps
  ) {
    this.logger = logger.child({ layer: 'smart' });
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      escalation: { ...DEFAULT_CONFIG.escalation, ...config.escalation },
    };

    this.escalationHandler = createEscalationHandler(this.logger, this.config.escalation, {
      composer: deps?.composer,
      conversationManager: deps?.conversationManager,
      userModel: deps?.userModel,
    });

    this.eventBus = deps?.eventBus;
  }

  /**
   * Set dependencies after construction.
   */
  setDependencies(deps: SmartProcessorDeps): void {
    this.escalationHandler.setDependencies({
      composer: deps.composer,
      conversationManager: deps.conversationManager,
      userModel: deps.userModel,
    });

    if (deps.eventBus) {
      this.eventBus = deps.eventBus;
    }

    this.logger.debug('SMART processor dependencies updated');
  }

  /**
   * Process escalated context with full reasoning.
   *
   * @param context Context from COGNITION layer
   * @returns Smart result with response
   */
  async process(context: SmartContext): Promise<SmartResult> {
    const startTime = Date.now();

    this.logger.debug(
      {
        escalationReason: context.escalationReason,
        hasPartialAnalysis: !!context.partialAnalysis,
        hasQuestion: !!context.question,
      },
      'SMART processing started'
    );

    // Extract chat info for typing indicator
    const userMessageSignal = context.cognitionContext.triggerSignals.find(
      (s) => s.type === 'user_message'
    );
    const messageData = userMessageSignal?.data as {
      chatId?: string;
      channel?: string;
    } | undefined;

    // Emit typing indicator if we have chat info
    if (
      this.config.emitTypingIndicator &&
      messageData?.chatId &&
      messageData?.channel
    ) {
      await this.emitTypingIndicator(messageData.chatId, messageData.channel);
    }

    // Handle the escalation
    const escalationResult = await this.escalationHandler.handle(context);

    const duration = Date.now() - startTime;

    this.logger.debug(
      {
        success: escalationResult.success,
        confidence: escalationResult.confidence,
        hasResponse: !!escalationResult.response,
        duration,
      },
      'SMART tick complete'
    );

    // Build result
    const intents: Intent[] = [...escalationResult.intents];

    // Add send_message intent if we have a response
    if (escalationResult.response) {
      const chatId = escalationResult.chatId ?? messageData?.chatId;
      const channel = escalationResult.channel ?? messageData?.channel;

      if (chatId && channel) {
        intents.push({
          type: 'SEND_MESSAGE',
          payload: {
            text: escalationResult.response,
            target: chatId,
            channel,
          },
        });
      }
    }

    const result: SmartResult = {
      confidence: escalationResult.confidence,
      intents,
    };

    if (escalationResult.response) {
      result.response = escalationResult.response;
    }

    return result;
  }

  /**
   * Emit typing indicator event.
   */
  private async emitTypingIndicator(chatId: string, channel: string): Promise<void> {
    if (!this.eventBus) return;

    const typingEvent: Event = {
      id: randomUUID(),
      source: 'internal',
      channel,
      type: 'typing_start',
      priority: Priority.HIGH,
      timestamp: new Date(),
      payload: { chatId },
    };

    await this.eventBus.publish(typingEvent);
    this.logger.debug({ chatId, channel }, 'Typing indicator emitted');
  }

  /**
   * Reset the processor state.
   */
  reset(): void {
    this.logger.debug('SMART processor reset');
  }
}

/**
 * Create a SMART processor.
 */
export function createSmartProcessor(
  logger: Logger,
  config?: Partial<SmartProcessorConfig>,
  deps?: SmartProcessorDeps
): SmartProcessor {
  return new SmartProcessor(logger, config, deps);
}
