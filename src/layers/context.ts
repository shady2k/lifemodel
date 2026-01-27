import type { Event, Priority } from '../types/index.js';

/**
 * Processing context passed through layers.
 *
 * Each layer enriches the context with its analysis.
 * Like a nerve signal that gains meaning as it travels up the brain.
 */
export interface ProcessingContext {
  /** Original event being processed */
  event: Event;

  /** Current processing stage */
  stage: ProcessingStage;

  /** Extracted structure from PERCEPTION */
  perception?: PerceptionOutput;

  /** Interpreted meaning from INTERPRETATION */
  interpretation?: InterpretationOutput;

  /** Cognitive analysis from COGNITION */
  cognition?: CognitionOutput;

  /** Decision from DECISION layer */
  decision?: DecisionOutput;

  /** Accumulated confidence through layers */
  confidence: number;

  /** Processing metadata */
  meta: ProcessingMeta;
}

/**
 * Processing stages matching the 6 layers.
 */
export type ProcessingStage =
  | 'reflex'
  | 'perception'
  | 'interpretation'
  | 'cognition'
  | 'decision'
  | 'expression';

/**
 * Processing metadata for tracing and debugging.
 */
export interface ProcessingMeta {
  /** When processing started */
  startedAt: Date;

  /** Layers that have processed this context */
  processedLayers: string[];

  /** Was processing hoisted at any point? */
  hoisted: boolean;

  /** Layer where hoisting occurred */
  hoistedFrom?: string;

  /** Pattern that triggered processing (if any) */
  triggerPattern?: string;
}

/**
 * Output from PERCEPTION layer.
 */
export interface PerceptionOutput {
  /** Detected content type */
  contentType: ContentType;

  /** Extracted text content (if any) */
  text?: string;

  /** Detected language */
  language?: string;

  /** Is this a question? */
  isQuestion: boolean;

  /** Is this a command/request? */
  isCommand: boolean;

  /** Extracted entities (names, dates, etc.) */
  entities: string[];

  /** Keywords/topics detected */
  keywords: string[];
}

/**
 * Content types that can be detected.
 */
export type ContentType =
  | 'text'
  | 'greeting'
  | 'farewell'
  | 'question'
  | 'command'
  | 'acknowledgment'
  | 'emotional'
  | 'informational'
  | 'system'
  | 'unknown';

/**
 * Output from INTERPRETATION layer.
 */
export interface InterpretationOutput {
  /** Detected user intent */
  intent: UserIntent;

  /** Confidence in intent detection (0-1) */
  intentConfidence: number;

  /** Detected sentiment */
  sentiment: Sentiment;

  /** Sentiment strength (-1 to 1) */
  sentimentStrength: number;

  /** Urgency level (0-1) */
  urgency: number;

  /** Does this require a response? */
  requiresResponse: boolean;

  /** Suggested response priority */
  responsePriority: Priority;
}

/**
 * Detected user intents.
 */
export type UserIntent =
  | 'greeting'
  | 'farewell'
  | 'question'
  | 'request'
  | 'information'
  | 'acknowledgment'
  | 'emotional_expression'
  | 'small_talk'
  | 'feedback_positive'
  | 'feedback_negative'
  | 'busy_signal'
  | 'availability_signal'
  | 'unknown';

/**
 * Sentiment categories.
 */
export type Sentiment = 'positive' | 'neutral' | 'negative' | 'mixed';

/**
 * Output from COGNITION layer.
 */
export interface CognitionOutput {
  /** Should beliefs about user be updated? */
  updateBeliefs: boolean;

  /** Belief updates to apply */
  beliefUpdates?: BeliefUpdate[];

  /** Memories triggered/recalled */
  recalledMemories?: string[];

  /** New associations made */
  associations?: string[];

  /** Internal thoughts generated */
  thoughts?: string[];

  /** Does this need deeper reasoning (LLM)? */
  needsReasoning: boolean;
}

/**
 * A belief update to apply.
 */
export interface BeliefUpdate {
  /** What to update (e.g., "user.mood", "user.availability") */
  target: string;

  /** New value or delta */
  value: unknown;

  /** Is this a delta (add to current) or absolute? */
  isDelta: boolean;

  /** Confidence in this update */
  confidence: number;
}

/**
 * Output from DECISION layer.
 */
export interface DecisionOutput {
  /** Should the agent respond/act? */
  shouldAct: boolean;

  /** Type of action to take */
  actionType: ActionType;

  /** Priority of the action */
  actionPriority: Priority;

  /** Reason for the decision (for logging/debugging) */
  reason: string;

  /** Constraints on the action */
  constraints?: ActionConstraints;
}

/**
 * Types of actions the agent can take.
 */
export type ActionType =
  | 'respond' // Send a message
  | 'acknowledge' // Simple acknowledgment
  | 'defer' // Wait before responding
  | 'ignore' // No action needed
  | 'escalate' // Needs human/deeper processing
  | 'remember'; // Just store, no response

/**
 * Constraints on actions.
 */
export interface ActionConstraints {
  /** Maximum response length */
  maxLength?: number;

  /** Required tone */
  tone?: string;

  /** Topics to avoid */
  avoidTopics?: string[];

  /** Delay before responding (ms) */
  delayMs?: number;
}

/**
 * Create initial processing context from an event.
 */
export function createProcessingContext(event: Event): ProcessingContext {
  return {
    event,
    stage: 'reflex',
    confidence: 1.0,
    meta: {
      startedAt: new Date(),
      processedLayers: [],
      hoisted: false,
    },
  };
}
