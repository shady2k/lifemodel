/**
 * Tool Argument Validation
 *
 * Validates tool arguments against ToolParameter[] schemas at runtime.
 * Uses the existing parameter definitions - no Zod needed.
 *
 * Purpose: Catch invalid LLM outputs before execution, enabling
 * graceful retry instead of runtime errors.
 */

import type { ToolParameter } from './types.js';

/**
 * Patterns that indicate placeholder values from LLM output.
 * Some LLMs (e.g., Haiku) fill optional parameters with placeholders instead of omitting them.
 */
const PLACEHOLDER_PATTERNS = ['<UNKNOWN>', '<VALUE>', '<TODO>', '<MISSING>', '<N/A>'];

/**
 * Check if a value looks like a placeholder that should be omitted.
 */
function looksLikePlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const upper = value.toUpperCase();
  return PLACEHOLDER_PATTERNS.some((p) => upper.includes(p));
}

/**
 * Result of validating tool arguments.
 */
export type ValidationResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Validate args against ToolParameter[] schema.
 *
 * Checks:
 * - Required fields are present
 * - Types match (string, number, boolean, object, array)
 * - Enum values are valid (for string params with enum)
 *
 * @param args - Arguments from the LLM
 * @param parameters - Tool parameter definitions
 * @returns ValidationResult with data or error
 */
export function validateAgainstParameters(
  args: Record<string, unknown>,
  parameters: ToolParameter[]
): ValidationResult<Record<string, unknown>> {
  const errors: string[] = [];

  for (const param of parameters) {
    const value = args[param.name];

    // Check required
    if (param.required && (value === undefined || value === null)) {
      errors.push(`${param.name}: required`);
      continue;
    }

    // Skip validation if not provided (optional field)
    if (value === undefined || value === null) continue;

    // Detect placeholder values (e.g., "<UNKNOWN>" from some LLMs)
    // These should be treated as if the parameter wasn't provided
    if (looksLikePlaceholder(value)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      errors.push(
        `${param.name}: received placeholder "${valueStr}" - omit optional parameters you don't need`
      );
      continue;
    }

    // Check type
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    const expectedType = param.type;

    if (expectedType === 'string' && actualType !== 'string') {
      errors.push(`${param.name}: expected string, got ${actualType}`);
    } else if (expectedType === 'number' && actualType !== 'number') {
      errors.push(`${param.name}: expected number, got ${actualType}`);
    } else if (expectedType === 'boolean' && actualType !== 'boolean') {
      errors.push(`${param.name}: expected boolean, got ${actualType}`);
    } else if (expectedType === 'array' && actualType !== 'array') {
      errors.push(`${param.name}: expected array, got ${actualType}`);
    } else if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(value))) {
      errors.push(`${param.name}: expected object, got ${actualType}`);
    }

    // Check enum (for strings with enum constraint)
    if (param.enum && param.enum.length > 0 && actualType === 'string') {
      const strValue = value as string;
      if (!param.enum.includes(strValue)) {
        errors.push(`${param.name}: must be one of [${param.enum.join(', ')}], got "${strValue}"`);
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, error: errors.join('; ') };
  }

  return { success: true, data: args };
}
