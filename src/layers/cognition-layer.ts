import type { LayerResult, Logger, Thought } from '../types/index.js';
import { Priority } from '../types/index.js';
import { randomUUID } from 'node:crypto';
import type { ProcessingContext, CognitionOutput, BeliefUpdate } from './context.js';
import { BaseLayer } from './base-layer.js';
import type { MessageComposer } from '../llm/composer.js';
import type { ConversationManager } from '../storage/conversation-manager.js';
import type { UserModel } from '../models/user-model.js';

/**
 * Dependencies for CognitionLayer.
 */
export interface CognitionLayerDeps {
  /** Message composer for fast model classification */
  composer?: MessageComposer | undefined;
  /** Conversation manager for history */
  conversationManager?: ConversationManager | undefined;
  /** User model for user state */
  userModel?: UserModel | undefined;
}

/**
 * Layer 3: COGNITION
 *
 * Updates beliefs, recalls memories, generates thoughts.
 * "How does this affect my understanding?"
 *
 * Handles:
 * - Belief updates about user state
 * - Memory association (simplified for MVP)
 * - Internal thought generation
 * - Fast model classification for simple responses
 * - Determines if deeper reasoning needed
 *
 * Cost: Medium (uses fast LLM for classification, heuristics as fallback)
 */
export class CognitionLayer extends BaseLayer {
  readonly name = 'cognition';
  readonly confidenceThreshold = 0.5;

  private composer: MessageComposer | undefined;
  private conversationManager: ConversationManager | undefined;
  private userModel: UserModel | undefined;

  constructor(logger: Logger, deps?: CognitionLayerDeps) {
    super(logger, 'cognition');
    this.composer = deps?.composer;
    this.conversationManager = deps?.conversationManager;
    this.userModel = deps?.userModel;
  }

  /**
   * Set dependencies after construction.
   */
  setDependencies(deps: CognitionLayerDeps): void {
    if (deps.composer) this.composer = deps.composer;
    if (deps.conversationManager) this.conversationManager = deps.conversationManager;
    if (deps.userModel) this.userModel = deps.userModel;
    this.logger.debug('CognitionLayer dependencies updated');
  }

  protected async processImpl(context: ProcessingContext): Promise<LayerResult> {
    context.stage = 'cognition';

    const beliefUpdates: BeliefUpdate[] = [];
    const thoughts: Thought[] = [];
    let needsReasoning = false;
    let fastModelResponse: string | undefined;
    let fastModelConfidence: number | undefined;

    // Process based on interpretation
    if (context.interpretation) {
      // Update user beliefs based on signals
      const userUpdates = this.processUserSignals(context);
      beliefUpdates.push(...userUpdates);

      // Generate thoughts based on content
      const generatedThoughts = this.generateThoughts(context);
      thoughts.push(...generatedThoughts);

      // Use fast model classification if available, otherwise fall back to heuristics
      const classification = await this.classifyWithFastModel(context);
      needsReasoning = classification.needsReasoning;
      fastModelResponse = classification.suggestedResponse;
      fastModelConfidence = classification.confidence;
    }

    const cognition: CognitionOutput = {
      updateBeliefs: beliefUpdates.length > 0,
      needsReasoning,
    };

    // Only add optional properties if they have values
    if (beliefUpdates.length > 0) {
      cognition.beliefUpdates = beliefUpdates;
    }
    if (thoughts.length > 0) {
      cognition.thoughts = thoughts.map((t) => t.content);
    }
    if (fastModelResponse) {
      cognition.fastModelResponse = fastModelResponse;
    }
    if (fastModelConfidence !== undefined) {
      cognition.fastModelConfidence = fastModelConfidence;
    }

    context.cognition = cognition;

    // Confidence depends on whether we need reasoning
    const confidence = needsReasoning ? 0.4 : 0.8;

    this.logger.debug(
      {
        eventId: context.event.id,
        beliefUpdates: beliefUpdates.length,
        thoughtsGenerated: thoughts.length,
        needsReasoning,
        fastModelConfidence,
        hasFastModelResponse: !!fastModelResponse,
        thoughts: thoughts.map((t) => t.content.slice(0, 50)),
      },
      'Cognition complete'
    );

    // Build extras object conditionally
    const extras: Partial<LayerResult> = {};
    if (thoughts.length > 0) {
      extras.thoughts = thoughts;
    }

    return this.success(context, confidence, extras);
  }

  /**
   * Classify using fast model with full context.
   * Falls back to heuristics if fast model not available.
   */
  private async classifyWithFastModel(context: ProcessingContext): Promise<{
    needsReasoning: boolean;
    suggestedResponse?: string;
    confidence: number;
  }> {
    const { perception } = context;

    // If no composer or no text, fall back to heuristics
    if (!this.composer || !perception?.text) {
      return {
        needsReasoning: this.checkNeedsReasoningHeuristic(context),
        confidence: 0,
      };
    }

    try {
      // Get conversation history if available
      let history: Awaited<ReturnType<ConversationManager['getHistory']>> | undefined;
      if (this.conversationManager) {
        // Extract user ID from event payload
        const payload = context.event.payload as Record<string, unknown> | undefined;
        const chatId = payload?.['chatId'];
        const odlUserId = payload?.['userId'];
        const userId =
          (typeof chatId === 'string' ? chatId : undefined) ??
          (typeof odlUserId === 'string' ? odlUserId : undefined);

        if (userId) {
          history = await this.conversationManager.getHistory(userId, {
            maxRecent: 3,
            includeCompacted: true,
          });
        }
      }

      // Get user state if available
      let userState;
      if (this.userModel) {
        const user = this.userModel.getUser();
        userState = {
          name: user.name,
          energy: this.userModel.estimateEnergy(),
          availability: this.userModel.estimateAvailability(),
          mood: user.mood,
          confidence: user.confidence,
        };
      }

      // Call fast model for classification
      const result = await this.composer.classifyAndRespond({
        userMessage: perception.text,
        conversationHistory: history,
        userState,
      });

      this.logger.debug(
        {
          userMessage: perception.text.slice(0, 50),
          canHandle: result.canHandle,
          confidence: result.confidence,
          reasoning: result.reasoning,
          hasUserState: !!userState,
          historyLength: history?.length ?? 0,
        },
        '🧠 Fast model classification'
      );

      // If fast model is confident, use its response
      if (result.canHandle && result.confidence >= 0.8 && result.suggestedResponse) {
        return {
          needsReasoning: false,
          suggestedResponse: result.suggestedResponse,
          confidence: result.confidence,
        };
      }

      // Fast model not confident enough, need smart model
      return {
        needsReasoning: true,
        confidence: result.confidence,
      };
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Fast model classification failed, falling back to heuristics'
      );

      return {
        needsReasoning: this.checkNeedsReasoningHeuristic(context),
        confidence: 0,
      };
    }
  }

  /**
   * Heuristic-based check for reasoning needs (fallback).
   */
  private checkNeedsReasoningHeuristic(context: ProcessingContext): boolean {
    const { interpretation, perception } = context;

    // Questions often need reasoning
    if (interpretation?.intent === 'question') {
      // Simple questions don't need LLM
      if (perception?.text && perception.text.length < 50) {
        return false;
      }
      return true;
    }

    // Complex or long messages might need reasoning
    if (perception?.text && perception.text.length > 300) {
      return true;
    }

    // Low intent confidence means we don't understand well
    if (interpretation && interpretation.intentConfidence < 0.5) {
      return true;
    }

    return false;
  }

  private processUserSignals(context: ProcessingContext): BeliefUpdate[] {
    const updates: BeliefUpdate[] = [];
    const { interpretation } = context;

    if (!interpretation) return updates;

    // Update mood based on sentiment
    if (interpretation.sentiment !== 'neutral') {
      updates.push({
        target: 'user.mood',
        value: interpretation.sentiment,
        isDelta: false,
        confidence: Math.abs(interpretation.sentimentStrength),
      });
    }

    // Update availability based on signals
    switch (interpretation.intent) {
      case 'busy_signal':
        updates.push({
          target: 'user.availability',
          value: -0.4,
          isDelta: true,
          confidence: 0.8,
        });
        break;

      case 'availability_signal':
        updates.push({
          target: 'user.availability',
          value: 0.3,
          isDelta: true,
          confidence: 0.7,
        });
        break;

      case 'greeting':
        // Greeting suggests user is available
        updates.push({
          target: 'user.availability',
          value: 0.2,
          isDelta: true,
          confidence: 0.6,
        });
        break;

      case 'farewell':
        // Farewell suggests conversation ending
        updates.push({
          target: 'user.availability',
          value: -0.2,
          isDelta: true,
          confidence: 0.5,
        });
        break;
    }

    // Positive feedback boosts agent confidence
    if (interpretation.intent === 'feedback_positive') {
      updates.push({
        target: 'agent.confidence',
        value: 0.1,
        isDelta: true,
        confidence: 0.7,
      });
    }

    // Negative feedback decreases confidence
    if (interpretation.intent === 'feedback_negative') {
      updates.push({
        target: 'agent.confidence',
        value: -0.1,
        isDelta: true,
        confidence: 0.7,
      });
    }

    return updates;
  }

  private generateThoughts(context: ProcessingContext): Thought[] {
    const thoughts: Thought[] = [];
    const { interpretation, perception } = context;

    if (!interpretation) return thoughts;

    this.logger.debug(
      { eventId: context.event.id, intent: interpretation.intent },
      'Generating thoughts based on interpretation'
    );

    // Generate thought based on interaction type
    if (interpretation.intent === 'question' && interpretation.intentConfidence < 0.7) {
      thoughts.push(
        this.createThought(
          "I'm not entirely sure what they're asking. Should I clarify?",
          context.event.id,
          Priority.NORMAL,
          true
        )
      );
    }

    if (interpretation.sentiment === 'negative' && interpretation.sentimentStrength < -0.5) {
      thoughts.push(
        this.createThought(
          'They seem upset. I should be careful in my response.',
          context.event.id,
          Priority.HIGH,
          false
        )
      );
    }

    if (interpretation.intent === 'feedback_positive') {
      thoughts.push(
        this.createThought(
          'Positive feedback! What I did worked well.',
          context.event.id,
          Priority.LOW,
          false
        )
      );
    }

    // Long, complex messages might need more processing
    if (perception?.text && perception.text.length > 200) {
      thoughts.push(
        this.createThought(
          'This is a detailed message. I should take time to understand it fully.',
          context.event.id,
          Priority.NORMAL,
          true
        )
      );
    }

    return thoughts;
  }

  private createThought(
    content: string,
    source: string,
    priority: Priority,
    requiresProcessing: boolean
  ): Thought {
    const thought: Thought = {
      id: randomUUID(),
      content,
      source,
      priority,
      requiresProcessing,
      createdAt: new Date(),
    };

    this.logger.debug(
      { thoughtId: thought.id, content, priority, requiresProcessing },
      '💭 Thought generated'
    );

    return thought;
  }
}

/**
 * Factory function.
 */
export function createCognitionLayer(logger: Logger, deps?: CognitionLayerDeps): CognitionLayer {
  return new CognitionLayer(logger, deps);
}
