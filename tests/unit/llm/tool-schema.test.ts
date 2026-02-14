/**
 * Unit tests for tool schema conversion utilities.
 *
 * Tests the toStrictSchema function that converts canonical (non-strict) schemas
 * to OpenAI strict mode format.
 */

import { describe, it, expect } from 'vitest';
import { toStrictSchema, toolToOpenAIFormat } from '../../../src/llm/tool-schema.js';
import type { Tool } from '../../../src/layers/cognition/tools/types.js';

describe('toStrictSchema', () => {
  describe('top-level required promotion', () => {
    it('promotes all properties to required array', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          action: { type: 'string' },
          entries: { type: 'array' },
          date: { type: 'string' },
        },
        required: ['action'] as string[],
        additionalProperties: false,
      };

      const strict = toStrictSchema(canonical);

      expect(strict.required).toContain('action');
      expect(strict.required).toContain('entries');
      expect(strict.required).toContain('date');
      expect(strict.required).toHaveLength(3);
    });

    it('handles empty properties', () => {
      const canonical = {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      };

      const strict = toStrictSchema(canonical);
      // Empty properties means empty required array (strict mode still works, just no fields)
      expect(strict.required).toEqual([]);
    });
  });

  describe('nullable type wrapping', () => {
    it('wraps non-required field types as nullable', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          action: { type: 'string' },
          optional: { type: 'number' },
        },
        required: ['action'] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, { type: string | string[] }>;

      // Required field stays as-is
      expect(props['action'].type).toBe('string');

      // Optional field becomes nullable
      expect(props['optional'].type).toEqual(['number', 'null']);
    });

    it('preserves already-nullable types', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          field: { type: ['string', 'null'] },
        },
        required: [] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, { type: string | string[] }>;

      // Already nullable - should still be ['string', 'null']
      expect(props['field'].type).toEqual(['string', 'null']);
    });
  });

  describe('enum null addition', () => {
    it('adds null to enum for optional fields', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          meal_type: {
            type: 'string',
            enum: ['breakfast', 'lunch', 'dinner'],
          },
        },
        required: [] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, { enum: (string | null)[] }>;

      expect(props['meal_type'].enum).toContain('breakfast');
      expect(props['meal_type'].enum).toContain(null);
    });

    it('does not add null to enum for required fields', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete'],
          },
        },
        required: ['action'] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, { enum: (string | null)[] }>;

      expect(props['action'].enum).toEqual(['create', 'update', 'delete']);
      expect(props['action'].enum).not.toContain(null);
    });

    it('does not duplicate null in enum', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          field: {
            type: ['string', 'null'],
            enum: ['a', 'b', null],
          },
        },
        required: [] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, { enum: (string | null)[] }>;

      const nullCount = props['field'].enum.filter((v) => v === null).length;
      expect(nullCount).toBe(1);
    });
  });

  describe('nested object handling', () => {
    it('recursively transforms nested object properties', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          anchor: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['type'] as string[],
            additionalProperties: false,
          },
        },
        required: [] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, unknown>;
      const anchorProps = (props['anchor'] as { properties: Record<string, unknown> }).properties;

      // All nested fields should be in nested required
      const anchorRequired = (props['anchor'] as { required: string[] }).required;
      expect(anchorRequired).toContain('type');
      expect(anchorRequired).toContain('confidence');

      // Optional nested field should be nullable
      const confidenceType = (anchorProps['confidence'] as { type: string | string[] }).type;
      expect(confidenceType).toEqual(['number', 'null']);
    });

    it('handles deeply nested objects', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          level1: {
            type: 'object',
            properties: {
              level2: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                },
                required: [] as string[],
              },
            },
            required: [] as string[],
          },
        },
        required: [] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, unknown>;

      // Verify the structure is preserved
      expect(props['level1']).toBeDefined();
      const level1 = props['level1'] as { properties: Record<string, unknown> };
      expect(level1.properties['level2']).toBeDefined();
    });
  });

  describe('array items handling', () => {
    it('recursively transforms array items', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                portion: { type: 'number' },
              },
              required: ['name'] as string[],
            },
          },
        },
        required: [] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, unknown>;
      const items = (props['entries'] as { items: Record<string, unknown> }).items;

      // All item fields should be in required
      const itemsRequired = (items as { required: string[] }).required;
      expect(itemsRequired).toContain('name');
      expect(itemsRequired).toContain('portion');
    });
  });

  describe('preservation of other schema elements', () => {
    it('preserves additionalProperties: false', () => {
      const canonical = {
        type: 'object' as const,
        properties: { field: { type: 'string' } },
        required: [] as string[],
        additionalProperties: false,
      };

      const strict = toStrictSchema(canonical);
      expect(strict.additionalProperties).toBe(false);
    });

    it('preserves description fields', () => {
      const canonical = {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            description: 'Action to perform',
          },
        },
        required: ['action'] as string[],
      };

      const strict = toStrictSchema(canonical);
      const props = strict.properties as Record<string, { description?: string }>;
      expect(props['action'].description).toBe('Action to perform');
    });
  });
});

describe('toolToOpenAIFormat with strict option', () => {
  const testTool: Tool = {
    name: 'test',
    description: 'Test tool',
    parameters: [
      { name: 'action', type: 'string', required: true },
      { name: 'optional', type: 'string', required: false },
    ],
    validate: () => ({ success: true, data: {} }),
    execute: async () => ({}),
  };

  it('returns strict schema when strict: true', () => {
    const result = toolToOpenAIFormat(testTool, { strict: true });

    expect(result.strict).toBe(true);
    if ('function' in result) {
      expect(result.function.parameters.required).toContain('action');
      expect(result.function.parameters.required).toContain('optional');
    }
  });

  it('returns non-strict schema when strict: false (default)', () => {
    const result = toolToOpenAIFormat(testTool, { strict: false });

    expect(result.strict).toBeUndefined();
    if ('function' in result) {
      expect(result.function.parameters.required).toEqual(['action']);
      expect(result.function.parameters.required).not.toContain('optional');

      // Non-strict mode: optional fields should have plain types, not nullable unions
      const optionalProp = result.function.parameters.properties['optional'];
      expect(optionalProp.type).toBe('string');
      expect(optionalProp.type).not.toEqual(['string', 'null']);
    }
  });

  it('defaults to non-strict when no option provided', () => {
    const result = toolToOpenAIFormat(testTool);

    expect(result.strict).toBeUndefined();
  });

  it('handles backward-compatible boolean parameter (minimal mode)', () => {
    const result = toolToOpenAIFormat(testTool, true);

    // Should be minimal format (no parameters)
    expect('parameters' in (result as { function: { parameters?: unknown } }).function).toBe(false);
  });
});
