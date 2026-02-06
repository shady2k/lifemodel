/**
 * Core Agent Tool
 *
 * Update agent internal state with policy enforcement.
 */

import { getFieldPolicy } from '../../../../types/cognition.js';
import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Create the core.agent tool.
 */
export function createAgentTool(): Tool {
  const parameters: ToolParameter[] = [
    { name: 'action', type: 'string', description: 'Action: update', required: true },
    {
      name: 'field',
      type: 'string',
      description:
        'Field to update (e.g., curiosity, taskPressure). NOTE: socialDebt and energy are managed automatically — do not update them.',
      required: true,
    },
    {
      name: 'operation',
      type: 'string',
      description: 'Operation: set (absolute) or delta (relative change)',
      required: true,
    },
    {
      name: 'value',
      type: 'number',
      description: 'Value to set or delta to apply',
      required: true,
    },
    {
      name: 'confidence',
      type: 'number',
      description: 'Confidence 0-1 in this update',
      required: true,
    },
    { name: 'reason', type: 'string', description: 'Why this update is needed', required: true },
  ];

  return {
    name: 'core.agent',
    maxCallsPerTurn: 1,
    description:
      'Update agent internal state (curiosity, taskPressure). socialDebt and energy are automatic — do NOT update them. Subject to field policies (confidence thresholds, maxDelta). Values may be clamped.',
    tags: ['update', 'agent-state', 'internal'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
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
      const operationRaw = args['operation'] as string | undefined;
      const value = args['value'] as number | undefined;
      const confidence = args['confidence'] as number | undefined;
      const reason = args['reason'] as string | undefined;

      // Validate required parameters
      if (!field) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: field',
        });
      }

      // Block automatic fields — these are managed by the autonomic layer
      const AUTOMATIC_FIELDS = ['socialDebt', 'energy'];
      if (AUTOMATIC_FIELDS.includes(field)) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: `Field "${field}" is managed automatically and cannot be updated via core.agent. Do not retry.`,
        });
      }
      if (!operationRaw || (operationRaw !== 'set' && operationRaw !== 'delta')) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing or invalid parameter: operation (must be "set" or "delta")',
        });
      }
      // TypeScript narrows operationRaw to 'set' | 'delta' after the check above
      const operation = operationRaw;
      if (value === undefined || typeof value !== 'number') {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: value (number)',
        });
      }
      if (confidence === undefined || typeof confidence !== 'number') {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: confidence (number 0-1)',
        });
      }
      if (!reason) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: 'Missing required parameter: reason',
        });
      }

      // Check field policy
      const policy = getFieldPolicy(`agent.${field}`);

      // Check confidence threshold
      if (confidence < policy.minConfidence) {
        return Promise.resolve({
          success: false,
          action: 'update',
          error: `Policy violation: agent.${field} requires confidence >= ${String(policy.minConfidence)}, got ${String(confidence)}`,
          policy,
          suggestion: 'Increase confidence for this field',
        });
      }

      // Clamp delta if needed
      let finalValue = value;
      let clamped = false;
      if (operation === 'delta' && policy.maxDelta) {
        const absValue = Math.abs(value);
        if (absValue > policy.maxDelta) {
          finalValue = Math.sign(value) * policy.maxDelta;
          clamped = true;
        }
      } else if (operation === 'set') {
        // Clamp set values to valid range [0, 1]
        finalValue = Math.max(0, Math.min(1, value));
        clamped = finalValue !== value;
      }

      // Return validated payload for compileIntents()
      return Promise.resolve({
        success: true,
        action: 'update',
        field,
        operation,
        value: finalValue,
        confidence,
        reason,
        clamped,
        originalValue: clamped ? value : undefined,
      });
    },
  };
}
