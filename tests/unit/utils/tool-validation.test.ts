/**
 * Unit tests for shared tool argument validation.
 *
 * Tests the validateToolArgs function that validates against raw JSON Schema.
 * This is the unified validator used by both Cognition and Motor Cortex.
 */

import { describe, it, expect } from 'vitest';
import { validateToolArgs } from '../../../src/utils/tool-validation.js';

describe('validateToolArgs', () => {
  const basicSchema = {
    type: 'object' as const,
    properties: {
      question: { type: 'string' },
      count: { type: 'number' },
      flag: { type: 'boolean' },
      data: { type: 'object' },
      items: { type: 'array' },
    },
    required: ['question'] as string[],
  };

  describe('required fields', () => {
    it('rejects empty args when required field missing', () => {
      const result = validateToolArgs({}, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Missing required parameter');
        expect(result.error).toContain('"question"');
      }
    });

    it('rejects null required field', () => {
      const result = validateToolArgs({ question: null }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Missing required parameter');
        expect(result.error).toContain('"question"');
      }
    });

    it('rejects undefined required field', () => {
      const result = validateToolArgs({ question: undefined }, basicSchema);
      expect(result.success).toBe(false);
    });

    it('accepts provided required field', () => {
      const result = validateToolArgs({ question: 'Hello' }, basicSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.question).toBe('Hello');
      }
    });

    it('allows omitting optional fields', () => {
      const result = validateToolArgs({ question: 'Hi' }, basicSchema);
      expect(result.success).toBe(true);
    });
  });

  describe('required + unknown cross-reference', () => {
    it('cross-references unknown param with missing required', () => {
      const result = validateToolArgs({ message: 'Hi' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Missing required parameter: "question"');
        expect(result.error).toContain('You passed: "message"');
        expect(result.error).toContain('Did you mean "question"?');
      }
    });

    it('handles multiple unknown params in cross-reference', () => {
      const result = validateToolArgs({ msg: 'Hi', text: 'there' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Missing required parameter: "question"');
        expect(result.error).toContain('You passed: "msg", "text"');
      }
    });
  });

  describe('unknown parameter detection', () => {
    it('suggests closest match for unknown parameter', () => {
      const result = validateToolArgs({ question: 'Hi', quesion: 'typo' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown parameter "quesion"');
        expect(result.error).toContain('Did you mean "question"?');
      }
    });

    it('fuzzy matches parameter with suffix', () => {
      const result = validateToolArgs({ question: 'Hi', itemsData: [] }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown parameter "itemsData"');
        // Should suggest "items" as close match
      }
    });

    it('reports unknown parameter without suggestion when no close match', () => {
      const result = validateToolArgs({ question: 'Hi', xyz: 'random' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown parameter "xyz"');
      }
    });

    it('ignores _-prefixed internal keys', () => {
      const result = validateToolArgs({ question: 'Hi', _validatedEntries: [] }, basicSchema);
      expect(result.success).toBe(true);
    });

    it('ignores all _-prefixed keys', () => {
      const result = validateToolArgs(
        { question: 'Hi', _internal: 'data', _meta: {} },
        basicSchema
      );
      expect(result.success).toBe(true);
    });
  });

  describe('type checking with coercion', () => {
    it('coerces string to number', () => {
      const result = validateToolArgs({ question: 'Hi', count: '42' }, basicSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.count).toBe(42);
        expect(typeof result.data.count).toBe('number');
      }
    });

    it('coerces numeric string to number', () => {
      const result = validateToolArgs({ question: 'Hi', count: '3.14' }, basicSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.count).toBe(3.14);
      }
    });

    it('rejects non-numeric string for number param', () => {
      const result = validateToolArgs({ question: 'Hi', count: 'five' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('count: expected number, got string');
      }
    });

    it('coerces JSON string to array', () => {
      const result = validateToolArgs(
        { question: 'Hi', items: '["a", "b", "c"]' },
        basicSchema
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data.items)).toBe(true);
        expect(result.data.items).toEqual(['a', 'b', 'c']);
      }
    });

    it('rejects non-JSON string for array param', () => {
      const result = validateToolArgs({ question: 'Hi', items: 'not-an-array' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('items: expected array, got string');
        expect(result.error).toContain('not a stringified JSON string');
      }
    });

    it('rejects wrong type for object', () => {
      const result = validateToolArgs({ question: 'Hi', data: 'string' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('data: expected object, got string');
      }
    });

    it('rejects array for object param', () => {
      const result = validateToolArgs({ question: 'Hi', data: [1, 2] }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('data: expected object, got array');
      }
    });
  });

  describe('placeholder detection', () => {
    it('rejects <UNKNOWN> placeholder', () => {
      const result = validateToolArgs({ question: '<UNKNOWN>' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('placeholder');
        expect(result.error).toContain('<UNKNOWN>');
      }
    });

    it('rejects <MISSING> placeholder', () => {
      const result = validateToolArgs({ question: '<MISSING>' }, basicSchema);
      expect(result.success).toBe(false);
    });

    it('rejects <TODO> placeholder', () => {
      const result = validateToolArgs({ question: '<TODO>' }, basicSchema);
      expect(result.success).toBe(false);
    });

    it('rejects <VALUE> placeholder', () => {
      const result = validateToolArgs({ question: '<VALUE>' }, basicSchema);
      expect(result.success).toBe(false);
    });

    it('rejects <N/A> placeholder', () => {
      const result = validateToolArgs({ question: '<N/A>' }, basicSchema);
      expect(result.success).toBe(false);
    });

    it('case-insensitive placeholder detection', () => {
      const result = validateToolArgs({ question: '<unknown>' }, basicSchema);
      expect(result.success).toBe(false);
    });
  });

  describe('enum validation', () => {
    const enumSchema = {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete'],
        },
        status: {
          type: 'string',
          enum: ['pending', 'active', 'completed'],
        },
      },
      required: ['action'] as string[],
    };

    it('accepts valid enum value', () => {
      const result = validateToolArgs({ action: 'create' }, enumSchema);
      expect(result.success).toBe(true);
    });

    it('rejects invalid enum value', () => {
      const result = validateToolArgs({ action: 'invalid' }, enumSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('must be one of [create, update, delete]');
        expect(result.error).toContain('got "invalid"');
      }
    });

    it('validates enum for optional field', () => {
      const result = validateToolArgs({ action: 'create', status: 'invalid' }, enumSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('must be one of [pending, active, completed]');
      }
    });
  });

  describe('non-object args rejection', () => {
    it('rejects string args', () => {
      const result = validateToolArgs('string', basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Tool arguments must be a JSON object.');
      }
    });

    it('rejects null args', () => {
      const result = validateToolArgs(null, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Tool arguments must be a JSON object.');
      }
    });

    it('rejects array args', () => {
      const result = validateToolArgs(['args'], basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Tool arguments must be a JSON object.');
      }
    });

    it('rejects number args', () => {
      const result = validateToolArgs(123, basicSchema);
      expect(result.success).toBe(false);
    });

    it('rejects boolean args', () => {
      const result = validateToolArgs(true, basicSchema);
      expect(result.success).toBe(false);
    });
  });

  describe('missing schema properties', () => {
    it('returns success when schema has no properties', () => {
      const emptySchema = { type: 'object' as const, properties: {} };
      const result = validateToolArgs({ any: 'thing' }, emptySchema);
      expect(result.success).toBe(true);
    });

    it('returns success when schema.properties is not an object', () => {
      const invalidSchema = { type: 'object' as const, properties: null };
      const result = validateToolArgs({ any: 'thing' }, invalidSchema);
      expect(result.success).toBe(true);
    });
  });

  describe('multiple errors combined', () => {
    it('collects multiple validation errors', () => {
      const result = validateToolArgs({ msg: 'Hi', count: 'five' }, basicSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Should have both unknown parameter error and missing required error
        expect(result.error).toContain('Missing required parameter: "question"');
        expect(result.error).toContain('Unknown parameter "msg"');
        expect(result.error).toContain('expected number, got string');
      }
    });

    it('separates errors with semicolon', () => {
      const result = validateToolArgs(
        { message: 'Hi', count: 'five', flag: 'yes' },
        basicSchema
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const errors = result.error.split('; ');
        expect(errors.length).toBeGreaterThan(1);
      }
    });
  });

  describe('integer type handling', () => {
    const integerSchema = {
      type: 'object' as const,
      properties: {
        value: { type: 'integer' },
      },
      required: [] as string[],
    };

    it('accepts integer as number', () => {
      const result = validateToolArgs({ value: 42 }, integerSchema);
      expect(result.success).toBe(true);
    });

    it('coerces numeric string to integer', () => {
      const result = validateToolArgs({ value: '42' }, integerSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.value).toBe(42);
      }
    });
  });

  describe('union type handling', () => {
    const unionSchema = {
      type: 'object' as const,
      properties: {
        flexible: { type: ['string', 'null'] },
        multi: { type: ['string', 'number'] },
      },
      required: [] as string[],
    };

    it('accepts first type in union', () => {
      const result = validateToolArgs({ flexible: 'hello' }, unionSchema);
      expect(result.success).toBe(true);
    });

    it('accepts null in union type', () => {
      const result = validateToolArgs({ flexible: null }, unionSchema);
      expect(result.success).toBe(true);
    });

    it('accepts string from string|number union', () => {
      const result = validateToolArgs({ multi: 'hello' }, unionSchema);
      expect(result.success).toBe(true);
    });

    it('accepts number from string|number union', () => {
      const result = validateToolArgs({ multi: 42 }, unionSchema);
      expect(result.success).toBe(true);
    });
  });
});
