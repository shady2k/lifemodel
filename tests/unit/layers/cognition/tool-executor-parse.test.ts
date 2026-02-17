/**
 * TDD tests for tool argument parsing issues with weak models (GLM-4.7).
 *
 * Root cause chain:
 * 1. SiliconFlow's GLM-4.7 returns TRUNCATED JSON in tool call arguments (missing closing `}`)
 * 2. AI SDK fails to parse truncated JSON → passes raw string as tc.input
 * 3. vercel-ai-provider.ts does JSON.stringify(string) → double-quoted
 * 4. robustJsonParse unwraps one layer → still truncated JSON → inner parse fails
 * 5. Falls through to recovery attempts which return the string with `as Record` cast
 * 6. validateToolArgs → isPlainObject(string) → "Tool arguments must be a JSON object."
 *
 * DeepInfra's GLM-4.7 returns COMPLETE JSON → AI SDK parses correctly → works fine.
 */
import { describe, it, expect } from 'vitest';
import { validateToolArgs } from '../../../../src/utils/tool-validation.js';

// ── Simulating the full data flow ──────────────────────────────────

/**
 * Simulate what vercel-ai-provider.ts does with tc.input.
 * Current code: JSON.stringify(tc.input)
 */
function currentProviderMapping(tcInput: unknown): string {
  return JSON.stringify(tcInput);
}

/**
 * Simulate the fixed vercel-ai-provider.ts with string detection.
 */
function fixedProviderMapping(tcInput: unknown): string {
  if (typeof tcInput === 'string') {
    try {
      const parsed: unknown = JSON.parse(tcInput);
      if (typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify(parsed);
      }
    } catch {
      // Not valid JSON — pass through
    }
  }
  return JSON.stringify(tcInput);
}

/**
 * Simulate robustJsonParse with double-unwrap fix.
 */
function robustJsonParseCurrent(argsString: string): Record<string, unknown> | null {
  const trimmed = argsString.trim();
  if (trimmed === '') return {};

  try {
    let parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // inner parse failed
      }
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to recovery
  }

  // Simplified recovery: just try adding missing braces
  // (in real code there are regex-based recovery attempts)
  return null;
}

/**
 * Simulate robustJsonParse with truncated JSON repair.
 */
function robustJsonParseFixed(argsString: string): Record<string, unknown> | null {
  const trimmed = argsString.trim();
  if (trimmed === '') return {};

  try {
    let parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      // Unwrap double-stringification
      let inner = parsed;
      // Try direct parse first
      try {
        const innerParsed: unknown = JSON.parse(inner);
        if (typeof innerParsed === 'object' && innerParsed !== null && !Array.isArray(innerParsed)) {
          return innerParsed as Record<string, unknown>;
        }
      } catch {
        // Inner JSON might be truncated — try adding closing braces
        const openBraces = (inner.match(/\{/g) || []).length;
        const closeBraces = (inner.match(/\}/g) || []).length;
        const missing = openBraces - closeBraces;
        if (missing > 0) {
          const repaired = inner + '}'.repeat(missing);
          try {
            const repairedParsed: unknown = JSON.parse(repaired);
            if (typeof repairedParsed === 'object' && repairedParsed !== null) {
              return repairedParsed as Record<string, unknown>;
            }
          } catch {
            // Still can't parse even with added braces
          }
        }
      }
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  return null;
}


describe('GLM-4.7 tool argument parsing', () => {
  // ── The exact arguments the model INTENDS to send ──
  const intendedArgs = {
    action: 'create',
    content: 'Заплатить за интернет',
    anchor: {
      type: 'recurring',
      recurring: { frequency: 'monthly', dayOfMonth: 26 },
      confidence: 0.9,
      originalPhrase: 'на 26 число',
    },
  };

  // ── What providers actually return at HTTP level ──

  // DeepInfra: complete JSON
  const deepInfraHttpArgs = JSON.stringify(intendedArgs);

  // SiliconFlow: TRUNCATED JSON (missing closing brace — real bug from curl test)
  const siliconFlowHttpArgs =
    '{"action": "create", "content": "Заплатить за интернет", "anchor": {"type": "recurring", "recurring": {"frequency": "monthly", "dayOfMonth": 26}, "confidence": 0.9, "originalPhrase": "на 26 число"}';
  // Note: missing final `}`

  // ── What AI SDK does with the HTTP arguments ──

  describe('AI SDK behavior with truncated JSON', () => {
    it('DeepInfra: valid JSON → AI SDK parses to object', () => {
      const tcInput = JSON.parse(deepInfraHttpArgs);
      expect(typeof tcInput).toBe('object');
      expect(tcInput.action).toBe('create');
    });

    it('SiliconFlow: truncated JSON → AI SDK parse fails → passes raw string', () => {
      // When JSON.parse fails, AI SDK passes the raw string as tc.input
      expect(() => JSON.parse(siliconFlowHttpArgs)).toThrow();
      // So tc.input = the raw truncated string
      const tcInput = siliconFlowHttpArgs; // string, not object
      expect(typeof tcInput).toBe('string');
    });
  });

  describe('current code (with double-unwrap fix, without truncation repair)', () => {
    it('DeepInfra: tc.input=object → works', () => {
      const tcInput = JSON.parse(deepInfraHttpArgs); // object
      const providerArgs = currentProviderMapping(tcInput);
      const result = robustJsonParseCurrent(providerArgs);
      expect(result).not.toBeNull();
      expect(result!['action']).toBe('create');
    });

    it('SiliconFlow: tc.input=string (truncated) → FAILS', () => {
      const tcInput = siliconFlowHttpArgs; // raw truncated string
      const providerArgs = currentProviderMapping(tcInput); // JSON.stringify(string) = double-quoted

      // robustJsonParse unwraps one layer → gets truncated JSON string
      // inner parse fails because truncated → returns null
      const result = robustJsonParseCurrent(providerArgs);
      // BUG: result is null because inner JSON is truncated
      expect(result).toBeNull();
    });
  });

  describe('fixed code: repair truncated JSON after unwrap', () => {
    it('SiliconFlow: tc.input=string (truncated) → repaired and parsed', () => {
      const tcInput = siliconFlowHttpArgs; // raw truncated string
      const providerArgs = currentProviderMapping(tcInput);

      const result = robustJsonParseFixed(providerArgs);
      expect(result).not.toBeNull();
      expect(result!['action']).toBe('create');
      expect(result!['content']).toBe('Заплатить за интернет');
    });

    it('DeepInfra: tc.input=object → still works', () => {
      const tcInput = JSON.parse(deepInfraHttpArgs);
      const providerArgs = currentProviderMapping(tcInput);

      const result = robustJsonParseFixed(providerArgs);
      expect(result).not.toBeNull();
      expect(result!['action']).toBe('create');
    });

    it('normal args (no double-stringification) → still works', () => {
      const normalArgs = JSON.stringify(intendedArgs);
      const result = robustJsonParseFixed(normalArgs);
      expect(result).not.toBeNull();
      expect(result!['action']).toBe('create');
    });
  });

  describe('provider-level fix: detect string tc.input and parse/repair', () => {
    it('SiliconFlow: string tc.input → repair truncated JSON at provider level', () => {
      const tcInput = siliconFlowHttpArgs; // truncated string
      // Fixed provider mapping tries to parse the string
      const providerArgs = fixedProviderMapping(tcInput);
      // fixedProviderMapping fails to parse truncated JSON → passes through as double-stringified
      // We still need robustJsonParse to handle it
      const result = robustJsonParseFixed(providerArgs);
      expect(result).not.toBeNull();
      expect(result!['action']).toBe('create');
    });
  });

  describe('validateToolArgs with fixed parse', () => {
    it('accepts the repaired object', () => {
      const tcInput = siliconFlowHttpArgs;
      const providerArgs = currentProviderMapping(tcInput);
      const result = robustJsonParseFixed(providerArgs);
      expect(result).not.toBeNull();

      const schema = {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'cancel', 'complete'] },
          content: { type: 'string' },
          anchor: { type: 'object' },
        },
        required: ['action'],
      };

      const validation = validateToolArgs(result!, schema);
      expect(validation.success).toBe(true);
    });
  });
});
