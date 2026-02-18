/**
 * Core Perspective Tool
 *
 * Manages opinions and predictions the agent has.
 * Actions: set_opinion, predict, resolve_prediction, revise_opinion, list.
 *
 * Perspectives enable the agent to have views, track them, and learn when wrong:
 * - Opinions: "I think X overstates the risk"
 * - Predictions: "They'll probably enjoy that restaurant"
 *
 * Repeatedly validated opinions can promote to case law precedent.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type {
  PerspectiveAction,
  PredictionStatus,
  PerspectiveToolResult,
} from '../../../../types/agent/perspective.js';

/**
 * Valid statuses for prediction resolution.
 */
const PREDICTION_STATUSES = ['confirmed', 'missed', 'mixed'] as const;

/**
 * Create the core.perspective tool.
 */
export function createPerspectiveTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      required: true,
      enum: ['set_opinion', 'predict', 'resolve_prediction', 'revise_opinion', 'list'],
      description: 'Action: set_opinion, predict, resolve_prediction, revise_opinion, list',
    },
    // set_opinion parameters
    {
      name: 'topic',
      type: 'string',
      required: false,
      description: 'Topic the opinion is about (for set_opinion)',
    },
    {
      name: 'stance',
      type: 'string',
      required: false,
      description: 'Your view/position on the topic (for set_opinion)',
    },
    {
      name: 'rationale',
      type: 'string',
      required: false,
      description: 'Why you hold this opinion (for set_opinion)',
    },
    {
      name: 'confidence',
      type: 'number',
      required: false,
      description: 'Confidence 0-1 (default: 0.7)',
    },
    // predict parameters
    {
      name: 'claim',
      type: 'string',
      required: false,
      description: 'The prediction claim (for predict)',
    },
    {
      name: 'horizonAt',
      type: 'string',
      required: false,
      description: 'ISO date when prediction should be resolved (for predict)',
    },
    // resolve_prediction/revise_opinion parameters
    {
      name: 'predictionId',
      type: 'string',
      required: false,
      description: 'Prediction ID (for resolve_prediction)',
    },
    {
      name: 'opinionId',
      type: 'string',
      required: false,
      description: 'Opinion ID (for revise_opinion)',
    },
    {
      name: 'outcome',
      type: 'string',
      enum: PREDICTION_STATUSES,
      required: false,
      description: 'Outcome: confirmed, missed, mixed (for resolve_prediction)',
    },
    {
      name: 'newStance',
      type: 'string',
      required: false,
      description: 'New stance on the topic (for revise_opinion)',
    },
  ];

  return {
    name: 'core.perspective',
    maxCallsPerTurn: 3,
    description: `Track your opinions and predictions.
Opinions: views you hold about topics. Use set_opinion to record, revise_opinion to update.
Predictions: claims about future outcomes with resolution dates. Use predict to record, resolve_prediction to mark outcome.
Call list to see current perspectives.
Validated opinions can become stronger; missed predictions trigger reflection.`,
    tags: ['perspectives', 'opinions', 'predictions', 'inner-life'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args): Promise<PerspectiveToolResult> => {
      const action = args['action'] as PerspectiveAction | undefined;

      if (!action) {
        return Promise.resolve({
          success: false,
          action: 'list',
          error: 'Missing required field: action',
        });
      }

      switch (action) {
        case 'set_opinion':
          return Promise.resolve(handleSetOpinion(args));
        case 'predict':
          return Promise.resolve(handlePredict(args));
        case 'resolve_prediction':
          return Promise.resolve(handleResolvePrediction(args));
        case 'revise_opinion':
          return Promise.resolve(handleReviseOpinion(args));
        case 'list':
          return Promise.resolve(handleList(args));
      }

      // Exhaustive check - should never reach here
      return Promise.resolve({
        success: false,
        action: action as PerspectiveAction,
        error: `Unknown action: ${action as string}`,
      });
    },
  };
}

/**
 * Handle set_opinion action.
 */
function handleSetOpinion(args: Record<string, unknown>): PerspectiveToolResult {
  const topic = args['topic'] as string | undefined;
  const stance = args['stance'] as string | undefined;
  const confidenceRaw = args['confidence'] as number | null | undefined;

  if (!topic) {
    return {
      success: false,
      action: 'set_opinion',
      error: 'Missing required field: topic',
    };
  }

  if (!stance) {
    return {
      success: false,
      action: 'set_opinion',
      error: 'Missing required field: stance',
    };
  }

  // Validate confidence
  const confidence = confidenceRaw ?? 0.7;
  if (confidence < 0 || confidence > 1) {
    return {
      success: false,
      action: 'set_opinion',
      error: 'Confidence must be between 0 and 1',
    };
  }

  // Generate opinion ID
  const opinionId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    success: true,
    action: 'set_opinion',
    opinionId,
    opinions: [
      {
        id: opinionId,
        topic,
        stance,
        confidence,
      },
    ],
    total: 1,
  };
}

/**
 * Handle predict action.
 */
function handlePredict(args: Record<string, unknown>): PerspectiveToolResult {
  const claim = args['claim'] as string | undefined;
  const horizonAtStr = args['horizonAt'] as string | undefined;
  const confidenceRaw = args['confidence'] as number | null | undefined;

  if (!claim) {
    return {
      success: false,
      action: 'predict',
      error: 'Missing required field: claim',
    };
  }

  if (!horizonAtStr) {
    return {
      success: false,
      action: 'predict',
      error: 'Missing required field: horizonAt',
    };
  }

  // Parse horizonAt
  const horizonAt = new Date(horizonAtStr);
  if (Number.isNaN(horizonAt.getTime())) {
    return {
      success: false,
      action: 'predict',
      error: `Invalid horizonAt date: ${horizonAtStr}`,
    };
  }

  // Validate confidence
  const confidence = confidenceRaw ?? 0.6;
  if (confidence < 0 || confidence > 1) {
    return {
      success: false,
      action: 'predict',
      error: 'Confidence must be between 0 and 1',
    };
  }

  // Generate prediction ID
  const predictionId = `pred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    success: true,
    action: 'predict',
    predictionId,
    predictions: [
      {
        id: predictionId,
        claim,
        horizonAt,
        confidence,
        status: 'pending',
        isOverdue: false,
      },
    ],
    total: 1,
  };
}

/**
 * Handle resolve_prediction action.
 */
function handleResolvePrediction(args: Record<string, unknown>): PerspectiveToolResult {
  const predictionId = args['predictionId'] as string | undefined;
  const outcome = args['outcome'] as PredictionStatus | undefined;

  if (!predictionId) {
    return {
      success: false,
      action: 'resolve_prediction',
      error: 'Missing required field: predictionId',
    };
  }

  if (!outcome || !PREDICTION_STATUSES.includes(outcome as (typeof PREDICTION_STATUSES)[number])) {
    return {
      success: false,
      action: 'resolve_prediction',
      error: `Missing or invalid outcome. Must be one of: ${PREDICTION_STATUSES.join(', ')}`,
    };
  }

  return {
    success: true,
    action: 'resolve_prediction',
    predictionId,
    outcome,
  };
}

/**
 * Handle revise_opinion action.
 */
function handleReviseOpinion(args: Record<string, unknown>): PerspectiveToolResult {
  const opinionId = args['opinionId'] as string | undefined;
  const newStance = args['newStance'] as string | undefined;
  const confidenceRaw = args['confidence'] as number | undefined;

  if (!opinionId) {
    return {
      success: false,
      action: 'revise_opinion',
      error: 'Missing required field: opinionId',
    };
  }

  if (!newStance) {
    return {
      success: false,
      action: 'revise_opinion',
      error: 'Missing required field: newStance',
    };
  }

  // Validate confidence if provided
  if (confidenceRaw !== undefined && (confidenceRaw < 0 || confidenceRaw > 1)) {
    return {
      success: false,
      action: 'revise_opinion',
      error: 'Confidence must be between 0 and 1',
    };
  }

  return {
    success: true,
    action: 'revise_opinion',
    opinionId,
    newStance: newStance,
    confidence: confidenceRaw,
  };
}

/**
 * Handle list action.
 * Returns success with empty lists - actual data comes from CoreLoop.
 */
function handleList(_args: Record<string, unknown>): PerspectiveToolResult {
  return {
    success: true,
    action: 'list',
    opinions: [], // Will be populated by CoreLoop from memory
    predictions: [], // Will be populated by CoreLoop from memory
    total: 0,
  };
}
