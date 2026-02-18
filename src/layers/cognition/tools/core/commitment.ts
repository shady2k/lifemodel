/**
 * Core Commitment Tool
 *
 * Manages commitments (promises) the agent makes to the user.
 * Actions: create, mark_kept, mark_repaired, cancel, list_active.
 *
 * The LLM explicitly calls `create` when making a promise — no brittle
 * regex detection. This enables the "it actually cares" moment:
 * - Agent tracks what it promised
 * - Agent follows up or repairs if it misses
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type {
  CommitmentAction,
  CommitmentSource,
  CommitmentToolResult,
} from '../../../../types/agent/commitment.js';

/**
 * Valid sources for commitment creation.
 */
const COMMITMENT_SOURCES = ['explicit', 'implicit'] as const;

/**
 * Create the core.commitment tool.
 */
export function createCommitmentTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      required: true,
      enum: ['create', 'mark_kept', 'mark_repaired', 'cancel', 'list_active'],
      description: 'Action: create, mark_kept, mark_repaired, cancel, list_active',
    },
    {
      name: 'text',
      type: 'string',
      required: false,
      description: 'What you promise to do (required for create)',
    },
    {
      name: 'dueAt',
      type: 'string',
      required: false,
      description: 'ISO date when commitment is due (required for create)',
    },
    {
      name: 'source',
      type: 'string',
      enum: COMMITMENT_SOURCES,
      required: false,
      description: 'explicit (you said it) or implicit (implied from context). Default: explicit',
    },
    {
      name: 'confidence',
      type: 'number',
      required: false,
      description: 'Confidence this is a real commitment (0-1). Default: 0.9',
    },
    {
      name: 'commitmentId',
      type: 'string',
      required: false,
      description: 'Commitment ID (required for mark_kept, mark_repaired, cancel)',
    },
    {
      name: 'repairNote',
      type: 'string',
      required: false,
      description: 'How you repaired the breach (for mark_repaired)',
    },
  ];

  return {
    name: 'core.commitment',
    maxCallsPerTurn: 3,
    description: `Track commitments (promises) you make to the user.
Call create when you explicitly promise something: "I'll check in tomorrow", "I'll remember that".
Call mark_kept when you fulfill a commitment.
Call mark_repaired if you missed one but made it right.
Call cancel if circumstances changed.
Call list_active to see current commitments.
This enables follow-up and repair — the "it actually cares" moment.`,
    tags: ['commitments', 'promises', 'trust', 'follow-up'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args): Promise<CommitmentToolResult> => {
      const action = args['action'] as CommitmentAction | undefined;

      if (!action) {
        return Promise.resolve({
          success: false,
          action: 'create',
          error: 'Missing required field: action',
        });
      }

      switch (action) {
        case 'create':
          return Promise.resolve(handleCreate(args));
        case 'mark_kept':
          return Promise.resolve(handleMarkKept(args));
        case 'mark_repaired':
          return Promise.resolve(handleMarkRepaired(args));
        case 'cancel':
          return Promise.resolve(handleCancel(args));
        case 'list_active':
          return Promise.resolve(handleListActive(args));
      }

      // Exhaustive check - should never reach here
      return Promise.resolve({
        success: false,
        action: action as CommitmentAction,
        error: `Unknown action: ${action as string}`,
      });
    },
  };
}

/**
 * Handle create action.
 */
function handleCreate(args: Record<string, unknown>): CommitmentToolResult {
  const text = args['text'] as string | undefined;
  const dueAtStr = args['dueAt'] as string | undefined;
  const sourceRaw = args['source'] as string | null | undefined;
  const confidenceRaw = args['confidence'] as number | null | undefined;

  if (!text) {
    return {
      success: false,
      action: 'create',
      error: 'Missing required field: text',
    };
  }

  if (!dueAtStr) {
    return {
      success: false,
      action: 'create',
      error: 'Missing required field: dueAt',
    };
  }

  // Parse dueAt
  const dueAt = new Date(dueAtStr);
  if (Number.isNaN(dueAt.getTime())) {
    return {
      success: false,
      action: 'create',
      error: `Invalid dueAt date: ${dueAtStr}`,
    };
  }

  // Validate source
  const source: CommitmentSource =
    sourceRaw && COMMITMENT_SOURCES.includes(sourceRaw as (typeof COMMITMENT_SOURCES)[number])
      ? (sourceRaw as CommitmentSource)
      : 'explicit';

  // Validate confidence
  const confidence = confidenceRaw ?? 0.9;
  if (confidence < 0 || confidence > 1) {
    return {
      success: false,
      action: 'create',
      error: 'Confidence must be between 0 and 1',
    };
  }

  // Generate commitment ID
  const commitmentId = `cmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    success: true,
    action: 'create',
    commitmentId,
    commitments: [
      {
        id: commitmentId,
        text,
        dueAt,
        isOverdue: false,
        source,
        confidence,
      },
    ],
    total: 1,
  };
}

/**
 * Handle mark_kept action.
 */
function handleMarkKept(args: Record<string, unknown>): CommitmentToolResult {
  const commitmentId = args['commitmentId'] as string | undefined;

  if (!commitmentId) {
    return {
      success: false,
      action: 'mark_kept',
      error: 'Missing required field: commitmentId',
    };
  }

  return {
    success: true,
    action: 'mark_kept',
    commitmentId,
  };
}

/**
 * Handle mark_repaired action.
 */
function handleMarkRepaired(args: Record<string, unknown>): CommitmentToolResult {
  const commitmentId = args['commitmentId'] as string | undefined;
  const repairNote = args['repairNote'] as string | undefined;

  if (!commitmentId) {
    return {
      success: false,
      action: 'mark_repaired',
      error: 'Missing required field: commitmentId',
    };
  }

  if (!repairNote) {
    return {
      success: false,
      action: 'mark_repaired',
      error: 'Missing required field: repairNote (explain how you made it right)',
    };
  }

  return {
    success: true,
    action: 'mark_repaired',
    commitmentId,
  };
}

/**
 * Handle cancel action.
 */
function handleCancel(args: Record<string, unknown>): CommitmentToolResult {
  const commitmentId = args['commitmentId'] as string | undefined;

  if (!commitmentId) {
    return {
      success: false,
      action: 'cancel',
      error: 'Missing required field: commitmentId',
    };
  }

  return {
    success: true,
    action: 'cancel',
    commitmentId,
  };
}

/**
 * Handle list_active action.
 * Returns success with empty list - actual data comes from CoreLoop.
 */
function handleListActive(_args: Record<string, unknown>): CommitmentToolResult {
  return {
    success: true,
    action: 'list_active',
    commitments: [], // Will be populated by CoreLoop from memory
    total: 0,
  };
}
