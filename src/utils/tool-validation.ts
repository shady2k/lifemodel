/**
 * Tool Argument Validation Utility
 *
 * Shared validation logic for tool arguments against raw JSON Schema.
 * Used by both Cognition (via prevalidateToolArgs) and Motor Cortex.
 *
 * Zero project imports - pure validation logic.
 */

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
export function truncatePreview(value: unknown): string {
  const str = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  if (str.length <= PREVIEW_MAX_LENGTH) return str;
  return str.slice(0, PREVIEW_MAX_LENGTH) + '…';
}

/**
 * Build an actionable type mismatch error with what was received and how to fix it.
 */
export function buildTypeMismatchError(
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
export function looksLikePlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const upper = value.toUpperCase();
  return PLACEHOLDER_PATTERNS.some((p) => upper.includes(p));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSchemaType(
  type: string
): 'string' | 'number' | 'boolean' | 'object' | 'array' {
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  if (type === 'boolean') return 'boolean';
  return 'string';
}

export function getTypeListFromSchema(
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
 * Validate tool arguments against a raw JSON Schema.
 *
 * Checks (in order):
 * 1. `args` is a plain object — if not, early return error
 * 2. `schema.properties` exists and is object — if not, early return success (no schema to validate against)
 * 3. Skip `_`-prefixed internal keys (e.g. `_validatedEntries`)
 * 4. Unknown/misnamed parameters with fuzzy suggestions (Levenshtein)
 * 5. Placeholder detection (`<UNKNOWN>`, `<MISSING>`, etc.) — before required, so placeholders get specific error
 * 6. `required` fields are present and non-null (cross-references unknown keys for suggestions)
 * 7. Type checking with auto-coercion (string→number, string→array)
 * 8. Enum validation
 *
 * @param args - Arguments to validate
 * @param schema - Raw JSON Schema { type:'object', properties:{...}, required:[...] }
 * @returns ValidationResult with coerced args or error
 */
export function validateToolArgs(
  args: unknown,
  schema: Record<string, unknown>
): ValidationResult<Record<string, unknown>> {
  // Check 1: args must be a plain object
  if (!isPlainObject(args)) {
    return { success: false, error: 'Tool arguments must be a JSON object.' };
  }

  // Check 2: schema must have properties
  if (!isPlainObject(schema['properties'])) {
    return { success: true, data: args };
  }

  const errors: string[] = [];
  const properties = schema['properties'];
  const knownKeys = Object.keys(properties);
  const providedKeys = Object.keys(args);
  const knownKeySet = new Set(knownKeys);

  // Check 3: Skip _-prefixed internal keys (used for cross-phase data like _validatedEntries)
  const unknownKeys = providedKeys.filter((k) => !k.startsWith('_') && !knownKeySet.has(k));

  // Check 4: Unknown/misnamed parameters with fuzzy suggestions (skip if no known keys - allow any)
  if (knownKeys.length > 0) {
    for (const unknownKey of unknownKeys) {
      const suggestion = suggestClosestKey(unknownKey, knownKeys);
      if (suggestion) {
        errors.push(`Unknown parameter "${unknownKey}". Did you mean "${suggestion}"?`);
      } else {
        errors.push(`Unknown parameter "${unknownKey}".`);
      }
    }
  }

  // Collect unknown keys for cross-reference with required errors
  const unknownKeysForHint = unknownKeys.filter((k) => !k.startsWith('_'));

  // Check 6: Required fields must be present (check ALL required fields, not just provided ones)
  // OpenAI strict mode pattern: required + type:['string','null'] means "must be in JSON, can be null".
  // Only enforce non-null when the schema type does NOT include 'null'.
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : [];
  for (const rawKey of required) {
    const requiredKey = String(rawKey);
    const value = args[requiredKey];

    // Check if this field's type allows null
    const propSchema = properties[requiredKey];
    const typeAllowsNull =
      isPlainObject(propSchema) &&
      Array.isArray(propSchema['type']) &&
      (propSchema['type'] as unknown[]).includes('null');

    // If type allows null, the field is semantically optional — skip required check entirely.
    // OpenAI strict mode lists all fields as required with type:['T','null'] for optional ones.
    // Non-OpenAI models omit optional fields instead of sending null.
    if (typeAllowsNull) continue;

    // For non-nullable required fields, reject both undefined and null
    const isMissing = value === undefined || value === null;

    if (isMissing) {
      let errorMsg = `Missing required parameter: "${requiredKey}"`;
      // Cross-reference with unknown keys for actionable hints
      if (unknownKeysForHint.length > 0) {
        const unknownParams = unknownKeysForHint.map((k) => `"${k}"`).join(', ');
        errorMsg += `. You passed: ${unknownParams}. Did you mean "${requiredKey}"?`;
      }
      errors.push(errorMsg);
    }
  }

  // Check 5 & 7 & 8: For each provided key, validate the value
  for (const key of providedKeys) {
    if (!knownKeySet.has(key)) continue;

    const value = args[key];

    // Skip validation if not provided (optional field)
    if (value === undefined || value === null) continue;

    // Check 5: Placeholder detection (before type check, so placeholders get specific error)
    if (looksLikePlaceholder(value)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      errors.push(
        `${key}: received placeholder "${valueStr}" - omit optional parameters you don't need`
      );
      continue;
    }

    // Get expected types from schema
    const propSchema = properties[key];
    if (!isPlainObject(propSchema)) continue;

    const expectedTypes: ('string' | 'number' | 'boolean' | 'object' | 'array')[] =
      getTypeListFromSchema(propSchema['type']);

    if (expectedTypes.length === 0) continue;

    let coerced = value;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    // Check 7: Type checking with auto-coercion
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

    // Auto-coerce: string → object (JSON string)
    if (expectedTypes.includes('object') && actualType === 'string') {
      try {
        const parsed: unknown = JSON.parse(value as string);
        if (isPlainObject(parsed)) {
          coerced = parsed;
          args[key] = parsed;
        }
      } catch {
        // fall through to type check error
      }
    }

    // Auto-coerce: object/array → string (JSON.stringify)
    // Weak models (glm-4.7-flash) pass JSON objects where strings are expected (e.g., write tool content)
    if (expectedTypes.includes('string') && (actualType === 'object' || actualType === 'array')) {
      coerced = JSON.stringify(value, null, 2);
      args[key] = coerced;
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

    // Check 8: Enum validation
    const enumValues = Array.isArray(propSchema['enum'])
      ? propSchema['enum'].filter((v) => typeof v === 'string')
      : [];
    if (enumValues.length > 0 && typeof value === 'string') {
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
