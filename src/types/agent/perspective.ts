/**
 * Perspective Types
 *
 * Perspectives are the agent's opinions and predictions about the world.
 * They enable the agent to have views, track them, and learn when wrong.
 *
 * This creates a richer inner life:
 * - Opinions: "I think X overstates the risk"
 * - Predictions: "They'll probably enjoy that restaurant"
 *
 * Repeatedly validated opinions can promote to case law precedent.
 */

/**
 * Status of an opinion.
 */
export type OpinionStatus = 'active' | 'revised' | 'dropped';

/**
 * Status of a prediction.
 */
export type PredictionStatus = 'pending' | 'confirmed' | 'missed' | 'mixed';

/**
 * A record of an opinion the agent holds.
 *
 * Stored as MemoryEntry with:
 * - type: 'fact'
 * - tags: ['opinion', `state:${status}`]
 * - metadata: { kind: 'opinion', ...fields }
 */
export interface OpinionRecord {
  /** Unique identifier (op_timestamp_random) */
  id: string;

  /** Topic the opinion is about */
  topic: string;

  /** The agent's stance/view on the topic */
  stance: string;

  /** Confidence in this opinion (0-1) */
  confidence: number;

  /** Why the agent holds this opinion */
  rationale: string;

  /** When this opinion expires (optional - for time-limited views) */
  expiresAt?: Date | undefined;

  /** Current status of the opinion */
  status: OpinionStatus;

  /** When the opinion was created */
  createdAt: Date;

  /** Tick ID when opinion was created (for batch grouping) */
  tickId?: string | undefined;

  /** Parent signal ID that triggered this opinion (causal chain) */
  parentSignalId?: string | undefined;
}

/**
 * A record of a prediction the agent has made.
 *
 * Stored as MemoryEntry with:
 * - type: 'fact'
 * - tags: ['prediction', `state:${status}`]
 * - metadata: { kind: 'prediction', ...fields }
 */
export interface PredictionRecord {
  /** Unique identifier (pred_timestamp_random) */
  id: string;

  /** The claim being predicted */
  claim: string;

  /** When the prediction should be resolved */
  horizonAt: Date;

  /** Confidence in this prediction (0-1) */
  confidence: number;

  /** Current status of the prediction */
  status: PredictionStatus;

  /** When the prediction was created */
  createdAt: Date;

  /** When the prediction was resolved */
  resolvedAt?: Date | undefined;

  /** Tick ID when prediction was created */
  tickId?: string | undefined;

  /** Parent signal ID that triggered this prediction */
  parentSignalId?: string | undefined;
}

/**
 * Summary of an opinion for display in prompts.
 */
export interface OpinionSummary {
  id: string;
  topic: string;
  stance: string;
  confidence: number;
}

/**
 * Summary of a prediction for display in prompts.
 */
export interface PredictionSummary {
  id: string;
  claim: string;
  horizonAt: Date;
  confidence: number;
  status: PredictionStatus;
  isOverdue: boolean;
}

/**
 * Actions available for the perspective tool.
 */
export type PerspectiveAction =
  | 'set_opinion'
  | 'predict'
  | 'resolve_prediction'
  | 'revise_opinion'
  | 'list';

/**
 * Result from the perspective tool.
 */
export interface PerspectiveToolResult {
  success: boolean;
  action: PerspectiveAction;
  opinionId?: string | undefined;
  predictionId?: string | undefined;
  opinions?: OpinionSummary[];
  predictions?: PredictionSummary[];
  total?: number | undefined;
  outcome?: PredictionStatus | undefined;
  newStance?: string | undefined;
  confidence?: number | undefined;
  error?: string | undefined;
}
