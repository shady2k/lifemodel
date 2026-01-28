/**
 * Action Decider
 *
 * Decides what action to take based on the synthesized understanding.
 * Uses fast LLM for classification when needed, or heuristics for simple cases.
 *
 * This is the "what should I do?" part of cognition:
 * - Decides if we should respond
 * - Decides if we need to escalate to SMART
 * - Generates simple responses for trivial messages
 */

import type { AgentState } from '../../types/agent/state.js';
import type { Intent } from '../../types/intent.js';
import type { SmartContext, CognitionContext } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';
import type { MessageComposer, ClassificationResult } from '../../llm/composer.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';
import type { SynthesisResult } from './thought-synthesizer.js';

/**
 * Configuration for action decider.
 */
export interface ActionDeciderConfig {
  /** Confidence threshold to use fast model response (default: 0.8) */
  fastModelThreshold: number;

  /** Confidence threshold to escalate to SMART (default: 0.5) */
  escalationThreshold: number;

  /** Maximum complexity score for fast model (default: 0.4) */
  maxFastModelComplexity: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: ActionDeciderConfig = {
  fastModelThreshold: 0.8,
  escalationThreshold: 0.5,
  maxFastModelComplexity: 0.4,
};

/**
 * Action type - what kind of action to take.
 */
export type ActionType =
  | 'respond' // Respond to user
  | 'initiate' // Initiate contact
  | 'escalate' // Escalate to SMART
  | 'none'; // No action needed

/**
 * Result of action decision.
 */
export interface ActionDecision {
  /** What action to take */
  action: ActionType;

  /** Should escalate to SMART layer? */
  escalateToSmart: boolean;

  /** Reason for escalation (if any) */
  escalationReason?: string | undefined;

  /** Confidence in the decision (0-1) */
  confidence: number;

  /** Generated response (if confident enough) */
  response?: string | undefined;

  /** Intents to execute */
  intents: Intent[];

  /** Context to pass to SMART (if escalating) */
  smartContext?: SmartContext | undefined;

  /** Chat ID to respond to (if responding) */
  chatId?: string | undefined;

  /** Channel to respond on */
  channel?: string | undefined;
}

/**
 * Dependencies for ActionDecider.
 */
export interface ActionDeciderDeps {
  composer?: MessageComposer | undefined;
  conversationManager?: ConversationManager | undefined;
  userModel?: UserModel | undefined;
}

/**
 * Action Decider implementation.
 */
export class ActionDecider {
  private readonly config: ActionDeciderConfig;
  private readonly logger: Logger;

  private composer: MessageComposer | undefined;
  private conversationManager: ConversationManager | undefined;
  private userModel: UserModel | undefined;

  constructor(logger: Logger, config: Partial<ActionDeciderConfig> = {}, deps?: ActionDeciderDeps) {
    this.logger = logger.child({ component: 'action-decider' });
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.composer = deps?.composer;
    this.conversationManager = deps?.conversationManager;
    this.userModel = deps?.userModel;
  }

  /**
   * Set dependencies after construction.
   */
  setDependencies(deps: ActionDeciderDeps): void {
    if (deps.composer) this.composer = deps.composer;
    if (deps.conversationManager) this.conversationManager = deps.conversationManager;
    if (deps.userModel) this.userModel = deps.userModel;
    this.logger.debug('ActionDecider dependencies updated');
  }

  /**
   * Decide what action to take based on synthesis.
   *
   * @param synthesis Result from thought synthesizer
   * @param context Original cognition context
   * @returns Action decision
   */
  async decide(synthesis: SynthesisResult, context: CognitionContext): Promise<ActionDecision> {
    const { situation } = synthesis;

    switch (situation) {
      case 'user_message':
        return this.decideUserMessageResponse(synthesis, context);

      case 'proactive_contact':
        return this.decideProactiveContact(synthesis, context);

      case 'pattern_anomaly':
        return this.decidePatternAnomaly(synthesis, context);

      case 'channel_issue':
        return this.decideChannelIssue(synthesis, context);

      case 'time_event':
        return this.decideTimeEvent(synthesis, context);

      default:
        return {
          action: 'none',
          escalateToSmart: false,
          confidence: 0.5,
          intents: [],
        };
    }
  }

  /**
   * Decide how to respond to a user message.
   */
  private async decideUserMessageResponse(
    synthesis: SynthesisResult,
    context: CognitionContext
  ): Promise<ActionDecision> {
    const { messageText, chatId, channel, userId, complexity } = synthesis;

    if (!messageText) {
      return {
        action: 'none',
        escalateToSmart: false,
        confidence: 0.5,
        intents: [],
      };
    }

    // Check complexity - if too complex, escalate immediately
    if (complexity && complexity.score > this.config.maxFastModelComplexity) {
      this.logger.debug(
        { complexity: complexity.score, reasons: complexity.reasons },
        'Message too complex for fast model, escalating'
      );

      return this.buildEscalation(
        synthesis,
        context,
        `Complex message (score: ${complexity.score.toFixed(2)}): ${complexity.reasons.join(', ')}`
      );
    }

    // Try fast model classification
    if (this.composer) {
      const classification = await this.classifyWithFastModel(
        messageText,
        userId,
        context.agentState
      );

      // Fast model confident - use its response
      if (
        classification.canHandle &&
        classification.confidence >= this.config.fastModelThreshold &&
        classification.suggestedResponse
      ) {
        this.logger.debug(
          { confidence: classification.confidence },
          'Fast model confident, using response'
        );

        // Generate intents for state updates
        const intents = this.generateResponseIntents(classification, userId);

        return {
          action: 'respond',
          escalateToSmart: false,
          confidence: classification.confidence,
          response: classification.suggestedResponse,
          intents,
          chatId,
          channel,
        };
      }

      // Fast model not confident enough - escalate
      if (classification.confidence < this.config.escalationThreshold) {
        return this.buildEscalation(
          synthesis,
          context,
          classification.reasoning ?? 'Fast model not confident'
        );
      }

      // In between - try to handle but note uncertainty
      this.logger.debug(
        { confidence: classification.confidence },
        'Fast model moderately confident'
      );

      if (classification.suggestedResponse) {
        const intents = this.generateResponseIntents(classification, userId);

        return {
          action: 'respond',
          escalateToSmart: false,
          confidence: classification.confidence,
          response: classification.suggestedResponse,
          intents,
          chatId,
          channel,
        };
      }
    }

    // No composer or no response - escalate
    return this.buildEscalation(
      synthesis,
      context,
      'No fast model available or no response generated'
    );
  }

  /**
   * Classify message using fast model.
   */
  private async classifyWithFastModel(
    messageText: string,
    userId: string | undefined,
    _agentState: AgentState
  ): Promise<ClassificationResult> {
    if (!this.composer) {
      return {
        canHandle: false,
        confidence: 0,
        reasoning: 'No composer available',
      };
    }

    try {
      // Get conversation history if available
      let history;
      let messagesToCompact;

      if (this.conversationManager && userId) {
        const needsCompaction = await this.conversationManager.needsCompaction(userId);
        if (needsCompaction) {
          messagesToCompact = await this.conversationManager.getMessagesToCompact(userId);
        }

        history = await this.conversationManager.getHistory(userId, {
          maxRecent: 3,
          includeCompacted: true,
        });
      }

      // Get user state if available
      let userState;
      if (this.userModel) {
        const user = this.userModel.getUser();
        userState = {
          name: user.name,
          energy: this.userModel.estimateEnergy(),
          availability: this.userModel.estimateAvailability(),
          mood: user.beliefs.mood.value,
          confidence: this.userModel.getAverageConfidence(),
          gender: this.userModel.getGender(),
        };
      }

      const result = await this.composer.classifyAndRespond({
        userMessage: messageText,
        conversationHistory: history,
        userState,
        messagesToCompact,
      });

      // Handle compaction if needed
      if (result.contextSummary && userId && this.conversationManager) {
        await this.conversationManager.compact(userId, result.contextSummary);
        this.logger.debug(
          { userId, summaryLength: result.contextSummary.length },
          'Conversation compacted'
        );
      }

      // Update user model if name/gender detected
      if (result.detectedUserName && this.userModel) {
        this.userModel.setName(result.detectedUserName);
        this.logger.info({ name: result.detectedUserName }, 'User name detected');
      }

      if (result.detectedGender && this.userModel) {
        this.userModel.setGender(result.detectedGender);
        this.logger.info({ gender: result.detectedGender }, 'User gender detected');
      }

      return result;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Fast model classification failed'
      );

      return {
        canHandle: false,
        confidence: 0,
        reasoning: `Classification failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Generate intents from classification result.
   */
  private generateResponseIntents(
    classification: ClassificationResult,
    _userId: string | undefined
  ): Intent[] {
    const intents: Intent[] = [];

    // Social debt relief from interaction
    intents.push({
      type: 'UPDATE_STATE',
      payload: {
        key: 'socialDebt',
        value: -0.2, // Reduce social debt
        delta: true,
      },
    });

    // Record user name if detected
    if (classification.detectedUserName) {
      intents.push({
        type: 'UPDATE_STATE',
        payload: {
          key: 'user.name',
          value: classification.detectedUserName,
        },
      });
    }

    // Record user gender if detected
    if (classification.detectedGender) {
      intents.push({
        type: 'UPDATE_STATE',
        payload: {
          key: 'user.gender',
          value: classification.detectedGender,
        },
      });
    }

    return intents;
  }

  /**
   * Decide about proactive contact.
   */
  private decideProactiveContact(
    synthesis: SynthesisResult,
    context: CognitionContext
  ): ActionDecision {
    const { contactPressure, socialDebt } = synthesis;
    const { agentState } = context;

    // Check if agent has enough energy
    if (agentState.energy < 0.3) {
      this.logger.debug({ energy: agentState.energy }, 'Energy too low for proactive contact');
      return {
        action: 'none',
        escalateToSmart: false,
        confidence: 0.7,
        intents: [],
      };
    }

    // Proactive messages should be composed by SMART model for quality
    return this.buildEscalation(
      synthesis,
      context,
      `Proactive contact: pressure=${contactPressure?.toFixed(2) ?? 'N/A'}, debt=${socialDebt?.toFixed(2) ?? 'N/A'}`
    );
  }

  /**
   * Decide about pattern anomaly.
   */
  private decidePatternAnomaly(
    synthesis: SynthesisResult,
    _context: CognitionContext
  ): ActionDecision {
    // Log the anomaly but don't take action (for now)
    this.logger.info({ anomalies: synthesis.anomalies }, 'Pattern anomaly detected');

    return {
      action: 'none',
      escalateToSmart: false,
      confidence: 0.5,
      intents: [],
    };
  }

  /**
   * Decide about channel issue.
   */
  private decideChannelIssue(
    synthesis: SynthesisResult,
    _context: CognitionContext
  ): ActionDecision {
    // Log the issue - channel recovery is handled elsewhere
    this.logger.warn({ anomalies: synthesis.anomalies }, 'Channel issue detected');

    return {
      action: 'none',
      escalateToSmart: false,
      confidence: 0.5,
      intents: [],
    };
  }

  /**
   * Decide about time event.
   */
  private decideTimeEvent(_synthesis: SynthesisResult, _context: CognitionContext): ActionDecision {
    // Time events don't require direct action
    // They affect state which is handled by neurons
    return {
      action: 'none',
      escalateToSmart: false,
      confidence: 0.8,
      intents: [],
    };
  }

  /**
   * Build an escalation decision.
   */
  private buildEscalation(
    synthesis: SynthesisResult,
    context: CognitionContext,
    reason: string
  ): ActionDecision {
    const smartContext: SmartContext = {
      cognitionContext: context,
      escalationReason: reason,
    };

    // Add message-specific context
    if (synthesis.messageText) {
      smartContext.question = `Respond to: "${synthesis.messageText}"`;
    } else if (synthesis.situation === 'proactive_contact') {
      smartContext.question = 'Compose a natural proactive message to the user';
    }

    return {
      action: 'escalate',
      escalateToSmart: true,
      escalationReason: reason,
      confidence: 0.3, // Low confidence since we're escalating
      intents: [],
      smartContext,
      chatId: synthesis.chatId,
      channel: synthesis.channel,
    };
  }
}

/**
 * Create an action decider.
 */
export function createActionDecider(
  logger: Logger,
  config?: Partial<ActionDeciderConfig>,
  deps?: ActionDeciderDeps
): ActionDecider {
  return new ActionDecider(logger, config, deps);
}
