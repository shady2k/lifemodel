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
import {
  validateToolArgs,
  looksLikePlaceholder,
  truncatePreview,
  buildTypeMismatchError,
  type ValidationResult,
} from '../../../utils/tool-validation.js';

export type { ValidationResult };

/**
 * Build a raw JSON Schema from ToolParameter[].
 * Used when rawParameterSchema is not provided.
 */
function buildSchemaFromParameters(parameters: ToolParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    const propSchema: Record<string, unknown> = { type: param.type };
    if (param.enum && param.enum.length > 0) {
      propSchema['enum'] = param.enum;
    }
    properties[param.name] = propSchema;
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

/**
 * Pre-validate args against raw JSON Schema or ToolParameter[].
 *
 * This is a thin wrapper around validateToolArgs that:
 * - Uses rawParameterSchema directly if provided
 * - Builds a raw JSON Schema from ToolParameter[] if not
 * - Delegates to validateToolArgs for actual validation
 *
 * Checks performed:
 * - Unknown/misnamed parameters with fuzzy suggestions
 * - Required fields are present
 * - Basic type checks (with auto-coercion for common LLM mistakes)
 * - Placeholder detection
 * - Enum validation
 */
export function prevalidateToolArgs(
  args: unknown,
  parameters: ToolParameter[],
  rawParameterSchema?: Record<string, unknown>
): ValidationResult<Record<string, unknown>> {
  // Use provided raw schema, or build one from ToolParameter[]
  const schema = rawParameterSchema ?? buildSchemaFromParameters(parameters);
  return validateToolArgs(args, schema);
}

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

  // Detect if LLM passed unknown parameter names (helpful hint for schema mismatch)
  const providedKeys = Object.keys(args);
  const knownKeys = new Set(parameters.map((p) => p.name));
  const unknownKeys = providedKeys.filter((k) => !knownKeys.has(k));

  for (const param of parameters) {
    const value = args[param.name];

    // Check required
    if (param.required && (value === undefined || value === null)) {
      let errorMsg = `Missing required parameter: "${param.name}"`;
      // Add hint about unknown parameter names that might be what the LLM intended
      if (unknownKeys.length > 0) {
        errorMsg += `. You passed: ${unknownKeys.map((k) => `"${k}"`).join(', ')}. Did you mean to use "${param.name}" instead?`;
      }
      errors.push(errorMsg);
      continue;
    }

    // Skip validation if not provided (optional field)
    if (value === undefined || value === null) continue;

    // Detect placeholder values (e.g., "<UNKNOWN>" from some LLMs)
    // These should be treated as if the parameter wasn't provided
    if (typeof value === 'string' && looksLikePlaceholder(value)) {
      errors.push(
        `${param.name}: received placeholder "${value}" - omit optional parameters you don't need`
      );
      continue;
    }

    // Check type (with auto-coercion for common LLM mistakes)
    let coerced = value;
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    const expectedType = param.type;

    // Auto-coerce: string → array (some models serialize arrays as JSON strings)
    if (expectedType === 'array' && actualType === 'string') {
      try {
        const parsed: unknown = JSON.parse(value as string);
        if (Array.isArray(parsed)) {
          coerced = parsed;
          args[param.name] = parsed; // Fix in-place so executor gets correct type
        }
      } catch {
        // Not valid JSON — fall through to error with actionable message
      }
    }

    // Auto-coerce: string → number
    if (expectedType === 'number' && actualType === 'string') {
      const num = Number(value);
      if (!isNaN(num)) {
        coerced = num;
        args[param.name] = num;
      }
    }

    const coercedType = Array.isArray(coerced) ? 'array' : typeof coerced;

    let typeMismatch = false;
    if (expectedType === 'string' && coercedType !== 'string') typeMismatch = true;
    else if (expectedType === 'number' && coercedType !== 'number') typeMismatch = true;
    else if (expectedType === 'boolean' && coercedType !== 'boolean') typeMismatch = true;
    else if (expectedType === 'array' && coercedType !== 'array') typeMismatch = true;
    else if (expectedType === 'object' && (coercedType !== 'object' || Array.isArray(coerced)))
      typeMismatch = true;

    if (typeMismatch) {
      const preview = truncatePreview(value as string | number | boolean | object | unknown[]);
      errors.push(buildTypeMismatchError(param.name, expectedType, coercedType, preview));
    }

    // Check enum (for strings with enum constraint)
    if (param.enum && param.enum.length > 0 && typeof value === 'string') {
      const strValue = value;
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
