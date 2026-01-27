/**
 * COGNITION Layer Processor
 *
 * Processes aggregated signals using fast LLM.
 * Decides actions or escalates to SMART when uncertain.
 *
 * Like the prefrontal cortex:
 * - Conscious processing
 * - Decision making
 * - Only activated when AGGREGATION layer determines it's needed
 *
 * Uses fast LLM for classification. Escalates to SMART for complex reasoning.
 */

import type { CognitionLayer, CognitionContext, CognitionResult } from '../../types/layers.js';
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
  ThoughtSynthesizer,
  createThoughtSynthesizer,
  type ThoughtSynthesizerConfig,
} from './thought-synthesizer.js';
import {
  ActionDecider,
  createActionDecider,
  type ActionDeciderConfig,
} from './action-decider.js';

/**
 * Configuration for COGNITION processor.
 */
export interface CognitionProcessorConfig {
  /** Thought synthesizer config */
  synthesizer: Partial<ThoughtSynthesizerConfig>;

  /** Action decider config */
  decider: Partial<ActionDeciderConfig>;

  /** Emit typing indicator before LLM calls */
  emitTypingIndicator: boolean;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: CognitionProcessorConfig = {
  synthesizer: {},
  decider: {},
  emitTypingIndicator: true,
};

/**
 * Dependencies for COGNITION processor.
 */
export interface CognitionProcessorDeps {
  composer?: MessageComposer | undefined;
  conversationManager?: ConversationManager | undefined;
  userModel?: UserModel | undefined;
  eventBus?: EventBus | undefined;
}

/**
 * COGNITION layer processor implementation.
 */
export class CognitionProcessor implements CognitionLayer {
  readonly name = 'cognition' as const;

  private readonly synthesizer: ThoughtSynthesizer;
  private readonly decider: ActionDecider;
  private readonly config: CognitionProcessorConfig;
  private readonly logger: Logger;

  private eventBus: EventBus | undefined;

  constructor(
    logger: Logger,
    config: Partial<CognitionProcessorConfig> = {},
    deps?: CognitionProcessorDeps
  ) {
    this.logger = logger.child({ layer: 'cognition' });
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      synthesizer: { ...DEFAULT_CONFIG.synthesizer, ...config.synthesizer },
      decider: { ...DEFAULT_CONFIG.decider, ...config.decider },
    };

    this.synthesizer = createThoughtSynthesizer(this.logger, this.config.synthesizer);
    this.decider = createActionDecider(this.logger, this.config.decider, {
      composer: deps?.composer,
      conversationManager: deps?.conversationManager,
      userModel: deps?.userModel,
    });

    this.eventBus = deps?.eventBus;
  }

  /**
   * Set dependencies after construction.
   */
  setDependencies(deps: CognitionProcessorDeps): void {
    this.decider.setDependencies({
      composer: deps.composer,
      conversationManager: deps.conversationManager,
      userModel: deps.userModel,
    });

    if (deps.eventBus) {
      this.eventBus = deps.eventBus;
    }

    this.logger.debug('COGNITION processor dependencies updated');
  }

  /**
   * Process aggregated context and decide on action.
   *
   * @param context Context from AGGREGATION layer
   * @returns Cognition result with response or escalation
   */
  async process(context: CognitionContext): Promise<CognitionResult> {
    const startTime = Date.now();

    // 1. Synthesize understanding
    const synthesis = this.synthesizer.synthesize(context);

    this.logger.debug(
      {
        situation: synthesis.situation,
        requiresResponse: synthesis.requiresResponse,
        initiateContact: synthesis.initiateContact,
        summary: synthesis.summary,
      },
      'Thought synthesis complete'
    );

    // 2. Emit typing indicator if responding to user message
    if (
      this.config.emitTypingIndicator &&
      synthesis.situation === 'user_message' &&
      synthesis.chatId &&
      synthesis.channel
    ) {
      await this.emitTypingIndicator(synthesis.chatId, synthesis.channel);
    }

    // 3. Decide action
    const decision = await this.decider.decide(synthesis, context);

    const duration = Date.now() - startTime;

    this.logger.debug(
      {
        action: decision.action,
        escalateToSmart: decision.escalateToSmart,
        confidence: decision.confidence,
        hasResponse: !!decision.response,
        duration,
      },
      'COGNITION tick complete'
    );

    // 4. Build result
    const result: CognitionResult = {
      escalateToSmart: decision.escalateToSmart,
      confidence: decision.confidence,
      intents: decision.intents,
    };

    if (decision.escalationReason) {
      result.escalationReason = decision.escalationReason;
    }

    if (decision.response) {
      result.response = decision.response;
    }

    if (decision.smartContext) {
      result.smartContext = decision.smartContext;
    }

    // Add send_message intent if we have a response
    if (decision.response && decision.chatId && decision.channel) {
      result.intents.push(this.buildSendMessageIntent(
        decision.response,
        decision.chatId,
        decision.channel
      ));
    }

    return result;
  }

  /**
   * Build a send_message intent.
   */
  private buildSendMessageIntent(
    message: string,
    chatId: string,
    channel: string
  ): Intent {
    return {
      type: 'SEND_MESSAGE',
      payload: {
        text: message,
        target: chatId,
        channel,
      },
    };
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
    this.logger.debug('COGNITION processor reset');
  }
}

/**
 * Create a COGNITION processor.
 */
export function createCognitionProcessor(
  logger: Logger,
  config?: Partial<CognitionProcessorConfig>,
  deps?: CognitionProcessorDeps
): CognitionProcessor {
  return new CognitionProcessor(logger, config, deps);
}
