/**
 * Core Set Interest Tool
 *
 * Dedicated tool for tracking user topic interests.
 * Uses semantic enum for intensity instead of free-form delta strings.
 *
 * This design follows the "digital human" philosophy - interests are
 * a distinct cognitive function, not just another fact attribute.
 *
 * Replaces the awkward `interest_<topic>` attribute pattern which
 * forced LLMs to use underscore-joined identifiers instead of natural language.
 */

import type { EvidenceSource } from '../../../../types/cognition.js';
import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Intensity levels for interest changes.
 * Maps to numeric deltas in CoreLoop.
 */
export type InterestIntensity =
  | 'strong_positive'
  | 'weak_positive'
  | 'weak_negative'
  | 'strong_negative';

/**
 * Valid intensity values for the tool schema.
 */
const INTENSITY_VALUES = [
  'strong_positive',
  'weak_positive',
  'weak_negative',
  'strong_negative',
] as const;

/**
 * Valid evidence sources for the tool schema.
 */
const EVIDENCE_SOURCES = ['user_explicit', 'user_implicit', 'inferred'] as const;

/**
 * Result from core.setInterest tool execution.
 */
export interface SetInterestResult {
  success: boolean;
  error?: string | undefined;
  action?: 'setInterest' | undefined;
  topic?: string | undefined;
  intensity?: InterestIntensity | undefined;
  urgent?: boolean | undefined;
  source?: EvidenceSource | undefined;
}

/**
 * Create the core.setInterest tool.
 */
export function createInterestTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'topic',
      type: 'string',
      required: true,
      description:
        'Topic keyword(s) for matching. Use 1-3 short terms, comma-separated if multiple. ' +
        'Examples: "crypto", "outages,electricity", "AI,LLM", "отключения". ' +
        'Extract ALL relevant keywords from user request - location names, street names, specific terms. ' +
        'Call this tool MULTIPLE TIMES if user mentions several distinct topics. ' +
        'DO NOT write full sentences - only keywords.',
    },
    {
      name: 'intensity',
      type: 'string',
      enum: INTENSITY_VALUES,
      required: true,
      description:
        'Interest level: strong_positive (+0.5), weak_positive (+0.2), weak_negative (-0.2), strong_negative (-0.5)',
    },
    {
      name: 'urgent',
      type: 'boolean',
      required: false,
      description: 'Set true if user wants immediate alerts on this topic',
    },
    {
      name: 'source',
      type: 'string',
      enum: EVIDENCE_SOURCES,
      required: true,
      description:
        'How we learned this: user_explicit (clearly stated), user_implicit (behavioral signal), inferred (deduced)',
    },
  ];

  return {
    name: 'core.setInterest',
    description:
      'Record user interest in a topic. Use when user says "warn me about", "interested in", "notify me about", "don\'t care about". Do NOT use for one-time questions or mid-conversation clarifications.',
    tags: ['preferences', 'user-model', 'interests'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args): Promise<SetInterestResult> => {
      const topic = args['topic'] as string | undefined;
      const intensity = args['intensity'] as string | undefined;
      // Handle both undefined and null (strict mode sends null for optional fields)
      const urgent = (args['urgent'] as boolean | null | undefined) ?? false;
      const source = args['source'] as string | undefined;

      // Validate required fields
      if (!topic || !intensity || !source) {
        return Promise.resolve({
          success: false,
          error: 'Missing required fields: topic, intensity, source',
        });
      }

      // Validate intensity enum
      if (!INTENSITY_VALUES.includes(intensity as (typeof INTENSITY_VALUES)[number])) {
        return Promise.resolve({
          success: false,
          error: `Invalid intensity: ${intensity}. Must be one of: ${INTENSITY_VALUES.join(', ')}`,
        });
      }

      // Validate source enum
      if (!EVIDENCE_SOURCES.includes(source as (typeof EVIDENCE_SOURCES)[number])) {
        return Promise.resolve({
          success: false,
          error: `Invalid source: ${source}. Must be one of: ${EVIDENCE_SOURCES.join(', ')}`,
        });
      }

      return Promise.resolve({
        success: true,
        action: 'setInterest',
        topic,
        intensity: intensity as InterestIntensity,
        urgent,
        source: source as EvidenceSource,
      });
    },
  };
}
