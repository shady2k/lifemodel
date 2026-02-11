/**
 * Prevalidation Tests
 *
 * Tests for prevalidateToolArgs middleware that validates
 * tool arguments before per-tool validation.
 */

import { describe, it, expect } from 'vitest';
import { prevalidateToolArgs } from '../../../../../src/layers/cognition/tools/validation.js';
import type { ToolParameter } from '../../../../../src/layers/cognition/tools/types.js';

describe('prevalidateToolArgs', () => {
  const mockParameters: ToolParameter[] = [
    { name: 'entry_id', type: 'string', description: 'Entry ID', required: false },
    { name: 'action', type: 'string', description: 'Action', required: true },
    { name: 'entries', type: 'array', description: 'Entries', required: false },
  ];

  const mockRawSchema = {
    type: 'object' as const,
    properties: {
      entry_id: { type: ['string', 'null'] },
      action: { type: 'string' },
      entries: { type: ['array', 'null'] },
    },
    required: ['action'],
    additionalProperties: false,
  };

  describe('unknown key detection', () => {
    it('suggests entry_id when id is passed', () => {
      const args = { id: 'food_abc123' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown parameter "id"');
        expect(result.error).toContain('Did you mean "entry_id"?');
      }
    });

    it('suggests entry_id when entryId is passed', () => {
      const args = { entryId: 'food_abc123' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown parameter "entryId"');
        expect(result.error).toContain('Did you mean "entry_id"?');
      }
    });

    it('passes when all keys are known', () => {
      const args = { entry_id: 'food_abc123', action: 'delete' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(args);
      }
    });
  });

  describe('internal key handling', () => {
    it('ignores _validatedEntries internal key', () => {
      const args = { _validatedEntries: [], entry_id: 'food_abc', action: 'delete' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(true);
    });

    it('ignores any _-prefixed key', () => {
      const args = { _internal: 'data', action: 'delete' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(true);
    });
  });

  describe('type validation', () => {
    it('errors on type mismatch with preview', () => {
      const args = { action: 123, entry_id: 'abc' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('action: expected string, got number');
        expect(result.error).toContain('(received: 123)');
      }
    });

    it('coerces string to number for numeric params', () => {
      const args = { action: 'delete', count: '5' };
      const paramsWithNumber: ToolParameter[] = [
        { name: 'action', type: 'string', description: 'Action', required: true },
        { name: 'count', type: 'number', description: 'Count', required: false },
      ];
      const schemaWithNumber = {
        type: 'object' as const,
        properties: {
          action: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['action'],
        additionalProperties: false,
      };
      const result = prevalidateToolArgs(args, paramsWithNumber, schemaWithNumber);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ action: 'delete', count: 5 });
      }
    });

    it('coerces string to array for array params', () => {
      const args: Record<string, unknown> = { entries: '[{"name": "apple"}]' };
      const paramsWithArray: ToolParameter[] = [
        { name: 'entries', type: 'array', description: 'Entries', required: false },
      ];
      const schemaWithArray = {
        type: 'object' as const,
        properties: {
          entries: { type: 'array' },
        },
        required: [],
        additionalProperties: false,
      };
      const result = prevalidateToolArgs(args, paramsWithArray, schemaWithArray);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data['entries'])).toBe(true);
      }
    });
  });

  describe('null value handling', () => {
    it('skips null values for optional params', () => {
      const args = { entry_id: null, action: 'delete' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(true);
    });
  });

  describe('non-object args', () => {
    it('errors when args is not an object', () => {
      const args = 'not an object';
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Tool arguments must be a JSON object.');
      }
    });

    it('errors when args is null', () => {
      const args = null;
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Tool arguments must be a JSON object.');
      }
    });

    it('errors when args is array', () => {
      const args = ['not', 'an', 'object'];
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Tool arguments must be a JSON object.');
      }
    });
  });

  describe('enum validation', () => {
    const enumParams: ToolParameter[] = [
      {
        name: 'action',
        type: 'string',
        description: 'Action',
        required: true,
        enum: ['log', 'list', 'delete'],
      },
    ];

    it('validates enum values from schema', () => {
      const args = { action: 'invalid' };
      const enumSchema = {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['log', 'list', 'delete'] },
        },
        required: ['action'],
        additionalProperties: false,
      };
      const result = prevalidateToolArgs(args, enumParams, enumSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('must be one of [log, list, delete]');
      }
    });

    it('accepts valid enum value', () => {
      const args = { action: 'log' };
      const enumSchema = {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['log', 'list', 'delete'] },
        },
        required: ['action'],
        additionalProperties: false,
      };
      const result = prevalidateToolArgs(args, enumParams, enumSchema);

      expect(result.success).toBe(true);
    });
  });

  describe('required field validation', () => {
    it('checks required fields - now enabled via shared validator', () => {
      const args = {};
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      // prevalidateToolArgs NOW checks required parameters via shared validateToolArgs
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Missing required parameter');
        expect(result.error).toContain('"action"');
      }
    });

    it('passes when required field is provided', () => {
      const args = { action: 'delete' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(true);
    });

    it('passes with required field and optional field', () => {
      const args = { action: 'delete', entry_id: 'food_abc' };
      const result = prevalidateToolArgs(args, mockParameters, mockRawSchema);

      expect(result.success).toBe(true);
    });
  });
});
