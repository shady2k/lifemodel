import type { LayerResult, Logger } from '../types/index.js';
import { Priority } from '../types/index.js';
import type {
  ProcessingContext,
  DecisionOutput,
  ActionType,
  ActionConstraints,
} from './context.js';
import { BaseLayer } from './base-layer.js';

/**
 * Layer 4: DECISION
 *
 * Decides whether and how to act.
 * "Should I respond? What kind of response?"
 *
 * Handles:
 * - Action/no-action decision
 * - Action type selection
 * - Constraint definition
 *
 * Cost: Low (threshold checks, no LLM)
 */
export class DecisionLayer extends BaseLayer {
  readonly name = 'decision';
  readonly confidenceThreshold = 0.8;

  constructor(logger: Logger) {
    super(logger, 'decision');
  }

  protected processImpl(context: ProcessingContext): LayerResult {
    context.stage = 'decision';

    const { interpretation } = context;

    // If no interpretation, can't make good decision
    if (!interpretation) {
      context.decision = {
        shouldAct: false,
        actionType: 'ignore',
        actionPriority: Priority.LOW,
        reason: 'No interpretation available',
      };
      return this.success(context, 0.3);
    }

    // Determine if we should act
    const shouldAct = this.shouldTakeAction(context);

    // Determine action type
    const actionType = this.determineActionType(context, shouldAct);

    // Determine priority
    const actionPriority = this.determineActionPriority(context, actionType);

    // Generate constraints
    const constraints = this.generateConstraints(context, actionType);

    // Generate reason
    const reason = this.generateReason(context, shouldAct, actionType);

    const decision: DecisionOutput = {
      shouldAct,
      actionType,
      actionPriority,
      reason,
    };

    // Only add optional constraints if they exist
    if (constraints) {
      decision.constraints = constraints;
    }

    context.decision = decision;

    // High confidence in decision layer (it's deterministic)
    return this.success(context, 0.9);
  }

  private shouldTakeAction(context: ProcessingContext): boolean {
    const { interpretation, cognition } = context;

    if (!interpretation) return false;

    // Response required by interpretation
    if (interpretation.requiresResponse) {
      return true;
    }

    // High urgency warrants action
    if (interpretation.urgency > 0.7) {
      return true;
    }

    // Positive feedback might warrant acknowledgment
    if (interpretation.intent === 'feedback_positive') {
      return true;
    }

    // Negative sentiment might need response
    if (interpretation.sentiment === 'negative' && interpretation.sentimentStrength < -0.5) {
      return true;
    }

    // Cognition layer identified need for reasoning
    if (cognition?.needsReasoning) {
      return true;
    }

    // Default: don't act unless necessary
    return false;
  }

  private determineActionType(context: ProcessingContext, shouldAct: boolean): ActionType {
    if (!shouldAct) {
      // Even if not acting, might need to remember
      if (context.cognition?.updateBeliefs) {
        return 'remember';
      }
      return 'ignore';
    }

    const { interpretation, cognition } = context;

    if (!interpretation) return 'ignore';

    // Need deeper reasoning - escalate
    if (cognition?.needsReasoning) {
      return 'respond'; // Will use LLM in expression layer
    }

    // Simple acknowledgments
    if (
      interpretation.intent === 'greeting' ||
      interpretation.intent === 'farewell' ||
      interpretation.intent === 'acknowledgment'
    ) {
      return 'acknowledge';
    }

    // Questions and requests need full response
    if (interpretation.intent === 'question' || interpretation.intent === 'request') {
      return 'respond';
    }

    // Busy signals - defer
    if (interpretation.intent === 'busy_signal') {
      return 'defer';
    }

    // Feedback - acknowledge
    if (
      interpretation.intent === 'feedback_positive' ||
      interpretation.intent === 'feedback_negative'
    ) {
      return 'acknowledge';
    }

    // Default to respond for communication events
    if (context.event.source === 'communication') {
      return 'respond';
    }

    return 'ignore';
  }

  private determineActionPriority(context: ProcessingContext, actionType: ActionType): Priority {
    const { interpretation } = context;

    // Non-actions are low priority
    if (actionType === 'ignore' || actionType === 'remember') {
      return Priority.IDLE;
    }

    // Deferred actions are low priority
    if (actionType === 'defer') {
      return Priority.LOW;
    }

    // Use interpretation's response priority if available
    if (interpretation?.responsePriority !== undefined) {
      return interpretation.responsePriority;
    }

    // Acknowledge is usually normal priority
    if (actionType === 'acknowledge') {
      return Priority.NORMAL;
    }

    // Default to normal
    return Priority.NORMAL;
  }

  private generateConstraints(
    context: ProcessingContext,
    actionType: ActionType
  ): ActionConstraints | undefined {
    const { interpretation, perception } = context;

    if (actionType === 'ignore' || actionType === 'remember') {
      return undefined;
    }

    const constraints: ActionConstraints = {};

    // Set tone based on sentiment
    if (interpretation) {
      if (interpretation.sentiment === 'negative') {
        constraints.tone = 'empathetic';
      } else if (interpretation.sentiment === 'positive') {
        constraints.tone = 'friendly';
      } else {
        constraints.tone = 'neutral';
      }
    }

    // Acknowledgments should be brief
    if (actionType === 'acknowledge') {
      constraints.maxLength = 50;
    }

    // Match response length to input (roughly)
    if (perception?.text) {
      if (perception.text.length < 20) {
        constraints.maxLength = constraints.maxLength ?? 100;
      } else if (perception.text.length < 100) {
        constraints.maxLength = constraints.maxLength ?? 200;
      }
    }

    // Defer means add delay
    if (actionType === 'defer') {
      constraints.delayMs = 60_000; // 1 minute delay
    }

    return Object.keys(constraints).length > 0 ? constraints : undefined;
  }

  private generateReason(
    context: ProcessingContext,
    shouldAct: boolean,
    actionType: ActionType
  ): string {
    const { interpretation } = context;

    if (!shouldAct) {
      if (actionType === 'remember') {
        return 'Storing information for future reference';
      }
      return 'No response required';
    }

    if (!interpretation) {
      return 'Acting due to event priority';
    }

    switch (actionType) {
      case 'respond':
        if (interpretation.intent === 'question') {
          return 'Responding to user question';
        }
        if (interpretation.intent === 'request') {
          return 'Responding to user request';
        }
        return `Responding to ${interpretation.intent}`;

      case 'acknowledge':
        return `Acknowledging ${interpretation.intent}`;

      case 'defer':
        return 'User indicated busy, deferring response';

      case 'escalate':
        return 'Complex query requires deeper processing';

      default:
        return 'Processing event';
    }
  }
}

/**
 * Factory function.
 */
export function createDecisionLayer(logger: Logger): DecisionLayer {
  return new DecisionLayer(logger);
}
