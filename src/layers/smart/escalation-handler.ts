/**
 * Escalation Handler
 *
 * Handles escalated requests from COGNITION layer.
 * Uses smart (expensive) LLM for complex reasoning.
 *
 * This is the deep thinking part:
 * - Complex question answering
 * - Nuanced message composition
 * - Reasoning about ambiguous situations
 */

import type { SmartContext } from '../../types/layers.js';
import type { Intent } from '../../types/intent.js';
import type { Logger } from '../../types/logger.js';
import type { MessageComposer } from '../../llm/composer.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';

/**
 * Configuration for escalation handler.
 */
export interface EscalationHandlerConfig {
  /** Minimum confidence for a response (default: 0.6) */
  minConfidence: number;

  /** Maximum retries on failure (default: 1) */
  maxRetries: number;
}

// Config is currently not used but interface is exported for future use

/**
 * Result from escalation handling.
 */
export interface EscalationResult {
  /** Generated response */
  response?: string;

  /** Confidence in the response (0-1) */
  confidence: number;

  /** Whether handling was successful */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Intents to execute */
  intents: Intent[];

  /** Chat ID to respond to */
  chatId?: string;

  /** Channel to respond on */
  channel?: string;
}

/**
 * Dependencies for EscalationHandler.
 */
export interface EscalationHandlerDeps {
  composer?: MessageComposer | undefined;
  conversationManager?: ConversationManager | undefined;
  userModel?: UserModel | undefined;
}

/**
 * Escalation Handler implementation.
 */
export class EscalationHandler {
  private readonly logger: Logger;

  private composer: MessageComposer | undefined;
  private conversationManager: ConversationManager | undefined;

  constructor(
    logger: Logger,
    _config: Partial<EscalationHandlerConfig> = {},
    deps?: EscalationHandlerDeps
  ) {
    this.logger = logger.child({ component: 'escalation-handler' });
    this.composer = deps?.composer;
    this.conversationManager = deps?.conversationManager;
  }

  /**
   * Set dependencies after construction.
   */
  setDependencies(deps: EscalationHandlerDeps): void {
    if (deps.composer) this.composer = deps.composer;
    if (deps.conversationManager) this.conversationManager = deps.conversationManager;
    this.logger.debug('EscalationHandler dependencies updated');
  }

  /**
   * Handle an escalated request from COGNITION.
   *
   * @param context Smart context from COGNITION
   * @returns Escalation result
   */
  async handle(context: SmartContext): Promise<EscalationResult> {
    const startTime = Date.now();

    this.logger.debug(
      {
        escalationReason: context.escalationReason,
        hasQuestion: !!context.question,
        hasPartialAnalysis: !!context.partialAnalysis,
      },
      'Handling escalation'
    );

    if (!this.composer) {
      return {
        success: false,
        confidence: 0,
        error: 'No composer available',
        intents: [],
      };
    }

    // Determine what type of response to compose
    const isProactive = this.isProactiveContact(context);
    const isUserMessage = this.isUserMessageResponse(context);

    try {
      let result: EscalationResult;

      if (isUserMessage) {
        result = await this.handleUserMessageResponse(context);
      } else if (isProactive) {
        result = await this.handleProactiveMessage(context);
      } else {
        result = await this.handleGenericEscalation(context);
      }

      const duration = Date.now() - startTime;
      this.logger.debug(
        {
          success: result.success,
          confidence: result.confidence,
          hasResponse: !!result.response,
          duration,
        },
        'Escalation handled'
      );

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          duration,
        },
        'Escalation handling failed'
      );

      return {
        success: false,
        confidence: 0,
        error: error instanceof Error ? error.message : String(error),
        intents: [],
      };
    }
  }

  /**
   * Check if this is a proactive contact escalation.
   */
  private isProactiveContact(context: SmartContext): boolean {
    const { escalationReason, question } = context;
    return (
      escalationReason.includes('Proactive contact') ||
      question?.includes('proactive') ||
      false
    );
  }

  /**
   * Check if this is a user message response escalation.
   */
  private isUserMessageResponse(context: SmartContext): boolean {
    const { question, cognitionContext } = context;
    const hasUserMessage = cognitionContext.triggerSignals.some(
      (s) => s.type === 'user_message'
    );
    return hasUserMessage || (question?.startsWith('Respond to:') ?? false);
  }

  /**
   * Handle responding to a user message.
   */
  private async handleUserMessageResponse(context: SmartContext): Promise<EscalationResult> {
    // Extract user message from context
    const userMessageSignal = context.cognitionContext.triggerSignals.find(
      (s) => s.type === 'user_message'
    );

    const messageData = userMessageSignal?.data as {
      kind: string;
      text: string;
      chatId: string;
      channel: string;
      userId?: string;
    } | undefined;

    if (!messageData || messageData.kind !== 'user_message') {
      return {
        success: false,
        confidence: 0,
        error: 'No user message found in context',
        intents: [],
      };
    }

    const userId = messageData.userId ?? messageData.chatId;

    // Get conversation history
    let history;
    if (this.conversationManager && userId) {
      history = await this.conversationManager.getHistory(userId, {
        maxRecent: 5,
        includeCompacted: true,
      });
    }

    // Get user's preferred language (reserved for future use)
    // const language = this.userModel?.getLanguage();

    // Compose response using smart model
    const result = await this.composer!.composeResponse(
      messageData.text,
      history
    );

    if (!result.success || !result.message) {
      return {
        success: false,
        confidence: 0,
        error: result.error ?? 'Composition failed',
        intents: [],
      };
    }

    // Build intents
    const intents: Intent[] = [
      // Social debt relief
      {
        type: 'UPDATE_STATE',
        payload: {
          key: 'socialDebt',
          value: -0.2,
          delta: true,
        },
      },
    ];

    return {
      success: true,
      confidence: 0.8, // Smart model generally confident
      response: result.message,
      intents,
      chatId: messageData.chatId,
      channel: messageData.channel,
    };
  }

  /**
   * Handle composing a proactive message.
   */
  private async handleProactiveMessage(context: SmartContext): Promise<EscalationResult> {
    // Get user's preferred language (reserved for future use)
    // const language = this.userModel?.getLanguage();

    // Build reason from context
    const reason = context.escalationReason.replace('Proactive contact: ', '');

    // Compose proactive message
    const result = await this.composer!.composeProactive(reason);

    if (!result.success || !result.message) {
      return {
        success: false,
        confidence: 0,
        error: result.error ?? 'Proactive composition failed',
        intents: [],
      };
    }

    // Build intents for proactive message
    const intents: Intent[] = [
      // Reset contact pressure since we're initiating
      {
        type: 'UPDATE_STATE',
        payload: {
          key: 'contactPressure',
          value: 0,
          delta: false,
        },
      },
      // Partial social debt relief
      {
        type: 'UPDATE_STATE',
        payload: {
          key: 'socialDebt',
          value: -0.1,
          delta: true,
        },
      },
    ];

    // Note: chatId and channel need to come from agent config
    // They're not in the escalation context for proactive messages
    return {
      success: true,
      confidence: 0.7,
      response: result.message,
      intents,
      // chatId and channel will be filled by the caller
    };
  }

  /**
   * Handle generic escalation (catch-all).
   */
  private async handleGenericEscalation(context: SmartContext): Promise<EscalationResult> {
    this.logger.warn(
      { escalationReason: context.escalationReason },
      'Generic escalation - not sure how to handle'
    );

    // For now, just acknowledge we received it
    return {
      success: false,
      confidence: 0.3,
      error: `Unhandled escalation type: ${context.escalationReason}`,
      intents: [],
    };
  }
}

/**
 * Create an escalation handler.
 */
export function createEscalationHandler(
  logger: Logger,
  config?: Partial<EscalationHandlerConfig>,
  deps?: EscalationHandlerDeps
): EscalationHandler {
  return new EscalationHandler(logger, config, deps);
}
