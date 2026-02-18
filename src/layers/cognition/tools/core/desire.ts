/**
 * Core Desire Tool
 *
 * Manages desires (wants) the agent has about the user.
 * Actions: create, adjust, resolve, list_active.
 *
 * Desires drive proactive behavior through wanting, not guilt.
 * They create positive motivation: "I want to learn about their new job"
 * instead of "I should message them because it's been too long."
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type {
  DesireAction,
  DesireSource,
  DesireToolResult,
} from '../../../../types/agent/desire.js';

/**
 * Valid sources for desire creation.
 */
const DESIRE_SOURCES = ['user_signal', 'self_inference', 'commitment_followup'] as const;

/**
 * Create the core.desire tool.
 */
export function createDesireTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      required: true,
      enum: ['create', 'adjust', 'resolve', 'list_active'],
      description: 'Action: create, adjust, resolve, list_active',
    },
    {
      name: 'want',
      type: 'string',
      required: false,
      description: 'What you want to do/learn (required for create)',
    },
    {
      name: 'intensity',
      type: 'number',
      required: false,
      description: 'Desire intensity 0-1 (default: 0.5). Higher = more urgent want.',
    },
    {
      name: 'source',
      type: 'string',
      enum: DESIRE_SOURCES,
      required: false,
      description:
        'user_signal (they mentioned it), self_inference (you noticed), commitment_followup (from promise). Default: self_inference',
    },
    {
      name: 'evidence',
      type: 'string',
      required: false,
      description: 'Why you have this desire (e.g., "They mentioned it Tuesday")',
    },
    {
      name: 'desireId',
      type: 'string',
      required: false,
      description: 'Desire ID (required for adjust, resolve)',
    },
  ];

  return {
    name: 'core.desire',
    maxCallsPerTurn: 3,
    description: `Track what you WANT to do or learn about the user.
Creates positive motivation for proactive contact.
Call create when you genuinely want to learn/do something about them.
Call adjust to change intensity (stronger/weaker want).
Call resolve when satisfied or no longer relevant.
Call list_active to see current desires.
This drives proactive behavior through wanting, not guilt.`,
    tags: ['desires', 'wants', 'motivation', 'proactive'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args): Promise<DesireToolResult> => {
      const action = args['action'] as DesireAction | undefined;

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
        case 'adjust':
          return Promise.resolve(handleAdjust(args));
        case 'resolve':
          return Promise.resolve(handleResolve(args));
        case 'list_active':
          return Promise.resolve(handleListActive(args));
      }

      // Exhaustive check - should never reach here
      return Promise.resolve({
        success: false,
        action: action as DesireAction,
        error: `Unknown action: ${action as string}`,
      });
    },
  };
}

/**
 * Handle create action.
 */
function handleCreate(args: Record<string, unknown>): DesireToolResult {
  const want = args['want'] as string | undefined;
  const intensityRaw = args['intensity'] as number | null | undefined;
  const sourceRaw = args['source'] as string | null | undefined;
  const evidence = args['evidence'] as string | undefined;

  if (!want) {
    return {
      success: false,
      action: 'create',
      error: 'Missing required field: want',
    };
  }

  // Validate intensity
  const intensity = intensityRaw ?? 0.5;
  if (intensity < 0 || intensity > 1) {
    return {
      success: false,
      action: 'create',
      error: 'Intensity must be between 0 and 1',
    };
  }

  // Validate source
  const source: DesireSource =
    sourceRaw && DESIRE_SOURCES.includes(sourceRaw as (typeof DESIRE_SOURCES)[number])
      ? (sourceRaw as DesireSource)
      : 'self_inference';

  // Generate desire ID
  const desireId = `des_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    success: true,
    action: 'create',
    desireId,
    desires: [
      {
        id: desireId,
        want,
        intensity,
        source,
        evidence: evidence ?? '',
      },
    ],
    total: 1,
  };
}

/**
 * Handle adjust action.
 */
function handleAdjust(args: Record<string, unknown>): DesireToolResult {
  const desireId = args['desireId'] as string | undefined;
  const intensityRaw = args['intensity'] as number | undefined;

  if (!desireId) {
    return {
      success: false,
      action: 'adjust',
      error: 'Missing required field: desireId',
    };
  }

  // Validate intensity if provided
  if (intensityRaw !== undefined && (intensityRaw < 0 || intensityRaw > 1)) {
    return {
      success: false,
      action: 'adjust',
      error: 'Intensity must be between 0 and 1',
    };
  }

  return {
    success: true,
    action: 'adjust',
    desireId,
    intensity: intensityRaw,
  };
}

/**
 * Handle resolve action.
 */
function handleResolve(args: Record<string, unknown>): DesireToolResult {
  const desireId = args['desireId'] as string | undefined;

  if (!desireId) {
    return {
      success: false,
      action: 'resolve',
      error: 'Missing required field: desireId',
    };
  }

  return {
    success: true,
    action: 'resolve',
    desireId,
  };
}

/**
 * Handle list_active action.
 * Returns success with empty list - actual data comes from CoreLoop.
 */
function handleListActive(_args: Record<string, unknown>): DesireToolResult {
  return {
    success: true,
    action: 'list_active',
    desires: [], // Will be populated by CoreLoop from memory
    total: 0,
  };
}
