/**
 * Core User Tool
 *
 * Update beliefs about the user with policy enforcement.
 */

import type { EvidenceSource } from '../../../../types/cognition.js';
import { getFieldPolicy } from '../../../../types/cognition.js';
import type { Tool } from '../types.js';

/**
 * Create the core.user tool.
 */
export function createUserTool(): Tool {
  return {
    name: 'core.user',
    description:
      'Update beliefs about the user. Subject to field policies (confidence thresholds, required sources). Returns validation result for self-correction.',
    tags: ['update', 'user-model', 'beliefs'],
    hasSideEffects: true,
    parameters: [
      { name: 'action', type: 'string', description: 'Action: update', required: true },
      {
        name: 'field',
        type: 'string',
        description: 'Field to update (e.g., mood, name)',
        required: true,
      },
      {
        name: 'value',
        type: 'string',
        description: 'New value for the field (string, number, or other JSON value)',
        required: true,
      },
      {
        name: 'confidence',
        type: 'number',
        description: 'Confidence 0-1 in this update',
        required: true,
      },
      {
        name: 'source',
        type: 'string',
        description: 'Evidence source: user_quote, user_explicit, user_implicit, inferred, system',
        required: true,
      },
      {
        name: 'evidence',
        type: 'string',
        description: 'Supporting quote or observation',
        required: false,
      },
    ],
    execute: (args) => {
      const action = args['action'] as string;

      if (action !== 'update') {
        return Promise.resolve({
          success: false,
          action,
          error: `Unknown action: ${action}. Use "update".`,
        });
      }

      const field = args['field'] as string | undefined;
      const value = args['value'];
      const confidence = args['confidence'] as number | undefined;
      const source = args['source'] as EvidenceSource | undefined;
      const evidence = args['evidence'] as string | undefined;

      // Validate required parameters
      if (!field) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: field',
        });
      }
      if (value === undefined) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: value',
        });
      }
      if (confidence === undefined || typeof confidence !== 'number') {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: confidence (number 0-1)',
        });
      }
      if (!source) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: source',
        });
      }

      // Check field policy
      const policy = getFieldPolicy(`user.${field}`);

      // Check confidence threshold
      if (confidence < policy.minConfidence) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: `Policy violation: user.${field} requires confidence >= ${String(policy.minConfidence)}, got ${String(confidence)}`,
          policy,
          suggestion: 'Increase confidence or gather more evidence for this field',
        });
      }

      // Check required sources if specified
      if (policy.requireSource && !policy.requireSource.includes(source)) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: `Policy violation: user.${field} requires source to be one of: ${policy.requireSource.join(', ')}`,
          policy,
          suggestion: 'Use a stronger evidence source for this field',
        });
      }

      // Return validated payload for compileIntents()
      return Promise.resolve({
        success: true,
        action: 'update',
        field,
        value,
        confidence,
        source,
        evidence,
      });
    },
  };
}
