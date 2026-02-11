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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSchemaType(type: string): 'string' | 'number' | 'boolean' | 'object' | 'array' {
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  if (type === 'boolean') return 'boolean';
  return 'string';
}

function getTypeListFromSchema(
  value: unknown
): ('string' | 'number' | 'boolean' | 'object' | 'array')[] {
  if (typeof value === 'string') {
    return [normalizeSchemaType(value)];
  }
  if (Array.isArray(value)) {
    const out: ('string' | 'number' | 'boolean' | 'object' | 'array')[] = [];
    for (const item of value) {
      if (typeof item === 'string') out.push(normalizeSchemaType(item));
    }
    return out;
  }
  return [];
}

function levenshtein(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  const prev: number[] = [];
  const curr: number[] = [];

  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      const prevVal = prev[j] ?? 0;
      const currPrev = curr[j - 1] ?? 0;
      const prevPrev = prev[j - 1] ?? 0;
      curr[j] = Math.min(prevVal + 1, currPrev + 1, prevPrev + cost);
    }
    for (let j = 0; j <= bLen; j++) prev[j] = curr[j] ?? 0;
  }

  return prev[bLen] ?? 0;
}

function suggestClosestKey(key: string, candidates: string[]): string | null {
  const keyLower = key.toLowerCase();

  let bestMatch: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();

    if (keyLower.length >= 2) {
      if (
        candidateLower === keyLower ||
        candidateLower.startsWith(keyLower) ||
        candidateLower.endsWith(keyLower) ||
        candidateLower.includes(`_${keyLower}`) ||
        candidateLower.includes(`${keyLower}_`)
      ) {
        return candidate;
      }
    }

    const distance = levenshtein(keyLower, candidateLower);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }

  if (bestMatch === null) return null;
  const threshold = Math.min(3, Math.max(1, Math.floor(keyLower.length * 0.4)));
  if (bestDistance <= threshold) return bestMatch;
  return null;
}

/**
 * Result of validating tool arguments.
 */
export type ValidationResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Pre-validate args against raw JSON Schema properties or ToolParameter[].
 * Focuses on:
 * - Unknown/misnamed parameters
 * - Basic type checks (with light coercion for common LLM mistakes)
 */
export function prevalidateToolArgs(
  args: unknown,
  parameters: ToolParameter[],
  rawParameterSchema?: Record<string, unknown>
): ValidationResult<Record<string, unknown>> {
  if (!isPlainObject(args)) {
    return { success: false, error: 'Tool arguments must be a JSON object.' };
  }

  const errors: string[] = [];
  const knownKeys: string[] = [];
  const schemaProperties =
    rawParameterSchema &&
    isPlainObject(rawParameterSchema) &&
    rawParameterSchema['type'] === 'object' &&
    isPlainObject(rawParameterSchema['properties'])
      ? rawParameterSchema['properties']
      : null;

  if (schemaProperties) {
    knownKeys.push(...Object.keys(schemaProperties));
  } else {
    knownKeys.push(...parameters.map((p) => p.name));
  }

  const providedKeys = Object.keys(args);
  const knownKeySet = new Set(knownKeys);
  // Skip _-prefixed internal keys (used for cross-phase data like _validatedEntries)
  const unknownKeys = providedKeys.filter((k) => !k.startsWith('_') && !knownKeySet.has(k));

  for (const unknownKey of unknownKeys) {
    const suggestion = suggestClosestKey(unknownKey, knownKeys);
    if (suggestion) {
      errors.push(`Unknown parameter "${unknownKey}". Did you mean "${suggestion}"?`);
    } else {
      errors.push(`Unknown parameter "${unknownKey}".`);
    }
  }

  for (const key of providedKeys) {
    if (!knownKeySet.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;

    // Skip placeholder values; downstream validateAgainstParameters will handle these.
    if (looksLikePlaceholder(value)) continue;

    let expectedTypes: ('string' | 'number' | 'boolean' | 'object' | 'array')[] = [];
    let enumValues: readonly string[] | undefined;

    if (schemaProperties) {
      const propSchema = schemaProperties[key];
      if (isPlainObject(propSchema)) {
        expectedTypes = getTypeListFromSchema(propSchema['type']);
        if (Array.isArray(propSchema['enum'])) {
          enumValues = propSchema['enum'].filter((v) => typeof v === 'string');
        }
      }
    } else {
      const param = parameters.find((p) => p.name === key);
      if (param) {
        expectedTypes = [param.type];
        enumValues = param.enum;
      }
    }

    if (expectedTypes.length === 0) continue;

    let coerced = value;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    // Auto-coerce: string → array (JSON string)
    if (expectedTypes.includes('array') && actualType === 'string') {
      try {
        const parsed: unknown = JSON.parse(value as string);
        if (Array.isArray(parsed)) {
          coerced = parsed;
          args[key] = parsed;
        }
      } catch {
        // fall through to type check error
      }
    }

    // Auto-coerce: string → number
    if (expectedTypes.includes('number') && actualType === 'string') {
      const num = Number(value);
      if (!isNaN(num)) {
        coerced = num;
        args[key] = num;
      }
    }

    const coercedType: 'string' | 'number' | 'boolean' | 'object' | 'array' = Array.isArray(coerced)
      ? 'array'
      : typeof coerced === 'object'
        ? 'object'
        : typeof coerced === 'boolean'
          ? 'boolean'
          : typeof coerced === 'number'
            ? 'number'
            : 'string';
    const isTypeOk = expectedTypes.some((t) => {
      if (t === 'array') return coercedType === 'array';
      if (t === 'object') return coercedType === 'object' && !Array.isArray(coerced);
      return coercedType === t;
    });

    if (!isTypeOk) {
      const preview = truncatePreview(value);
      const expectedLabel =
        expectedTypes.length === 1 ? (expectedTypes[0] ?? 'unknown') : expectedTypes.join(' | ');
      errors.push(buildTypeMismatchError(key, expectedLabel, coercedType, preview));
    }

    if (enumValues && enumValues.length > 0 && typeof value === 'string') {
      if (!enumValues.includes(value)) {
        errors.push(`${key}: must be one of [${enumValues.join(', ')}], got "${value}"`);
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, error: errors.join('; ') };
  }

  return { success: true, data: args };
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
