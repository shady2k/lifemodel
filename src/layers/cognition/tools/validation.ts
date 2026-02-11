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

/** Max chars for value preview in error messages. */
const PREVIEW_MAX_LENGTH = 80;

/**
 * Truncate a value for error message preview.
 * Shows enough for the model to recognize what it sent.
 */
function truncatePreview(value: unknown): string {
  const str = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  if (str.length <= PREVIEW_MAX_LENGTH) return str;
  return str.slice(0, PREVIEW_MAX_LENGTH) + '…';
}

/**
 * Build an actionable type mismatch error with what was received and how to fix it.
 */
function buildTypeMismatchError(
  paramName: string,
  expected: string,
  actual: string,
  preview: string
): string {
  let msg = `${paramName}: expected ${expected}, got ${actual} (received: ${preview})`;

  // Add specific fix hints for common model mistakes
  if (expected === 'array' && actual === 'string') {
    msg += '. Pass a JSON array directly, not a stringified JSON string.';
  } else if (expected === 'number' && actual === 'string') {
    msg += '. Pass a number without quotes.';
  } else if (expected === 'object' && actual === 'string') {
    msg += '. Pass a JSON object directly, not a stringified JSON string.';
  }

  return msg;
}

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
    if (looksLikePlaceholder(value)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      errors.push(
        `${param.name}: received placeholder "${valueStr}" - omit optional parameters you don't need`
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
      const preview = truncatePreview(value);
      errors.push(buildTypeMismatchError(param.name, expectedType, coercedType, preview));
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
