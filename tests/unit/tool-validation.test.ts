/**
 * Unit tests for tool argument validation.
 *
 * Tests the validateAgainstParameters function that catches invalid
 * LLM outputs before tool execution, enabling graceful retry.
 */

import { describe, it, expect } from 'vitest';
import { validateAgainstParameters } from '../../src/layers/cognition/tools/validation.js';
import type { ToolParameter } from '../../src/layers/cognition/tools/types.js';
import { createFinalTool } from '../../src/layers/cognition/tools/core/final.js';

describe('validateAgainstParameters', () => {
  const parameters: ToolParameter[] = [
    { name: 'type', type: 'string', enum: ['a', 'b'], required: true, description: 'Type' },
    { name: 'count', type: 'number', required: false, description: 'Count' },
    { name: 'flag', type: 'boolean', required: false, description: 'Flag' },
    { name: 'data', type: 'object', required: false, description: 'Data' },
    { name: 'items', type: 'array', required: false, description: 'Items' },
  ];

  describe('required fields', () => {
    it('rejects missing required field', () => {
      const result = validateAgainstParameters({}, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('type: required');
      }
    });

    it('rejects null required field', () => {
      const result = validateAgainstParameters({ type: null }, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('type: required');
      }
    });

    it('accepts provided required field', () => {
      const result = validateAgainstParameters({ type: 'a' }, parameters);
      expect(result.success).toBe(true);
    });
  });

  describe('enum validation', () => {
    it('rejects invalid enum value', () => {
      const result = validateAgainstParameters({ type: 'c' }, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('must be one of [a, b]');
        expect(result.error).toContain('got "c"');
      }
    });

    it('accepts valid enum value', () => {
      const result = validateAgainstParameters({ type: 'a' }, parameters);
      expect(result.success).toBe(true);
    });
  });

  describe('type checking', () => {
    it('rejects wrong type for string', () => {
      const result = validateAgainstParameters({ type: 123 }, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('expected string, got number');
      }
    });

    it('rejects wrong type for number', () => {
      const result = validateAgainstParameters({ type: 'a', count: 'five' }, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('expected number, got string');
      }
    });

    it('rejects wrong type for boolean', () => {
      const result = validateAgainstParameters({ type: 'a', flag: 'yes' }, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('expected boolean, got string');
      }
    });

    it('rejects wrong type for object (array passed)', () => {
      const result = validateAgainstParameters({ type: 'a', data: [1, 2] }, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('expected object, got array');
      }
    });

    it('rejects wrong type for array', () => {
      const result = validateAgainstParameters({ type: 'a', items: 'not-array' }, parameters);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('expected array, got string');
      }
    });
  });

  describe('optional fields', () => {
    it('allows missing optional fields', () => {
      const result = validateAgainstParameters({ type: 'a' }, parameters);
      expect(result.success).toBe(true);
    });

    it('allows null optional fields', () => {
      const result = validateAgainstParameters({ type: 'a', count: null }, parameters);
      expect(result.success).toBe(true);
    });

    it('validates provided optional fields', () => {
      const result = validateAgainstParameters({ type: 'a', count: 'not-a-number' }, parameters);
      expect(result.success).toBe(false);
    });
  });

  describe('multiple errors', () => {
    it('collects all errors', () => {
      const result = validateAgainstParameters(
        { count: 'not-a-number', flag: 'not-a-boolean' },
        parameters
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('type: required');
        expect(result.error).toContain('expected number');
        expect(result.error).toContain('expected boolean');
      }
    });
  });
});

describe('core.final validation (the original bug)', () => {
  it('rejects type: "active" (the original bug that caused runtime error)', () => {
    const tool = createFinalTool();
    const result = tool.validate({ type: 'active' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('must be one of [respond, no_action, defer]');
    }
  });

  it('accepts valid respond type', () => {
    const tool = createFinalTool();
    const result = tool.validate({
      type: 'respond',
      text: 'Hello',
      confidence: 0.9,
      conversationStatus: 'active',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid no_action type', () => {
    const tool = createFinalTool();
    const result = tool.validate({ type: 'no_action', reason: 'No response needed' });
    expect(result.success).toBe(true);
  });

  it('accepts valid defer type', () => {
    const tool = createFinalTool();
    const result = tool.validate({
      type: 'defer',
      reason: 'User busy',
      signalType: 'contact_urge',
      deferHours: 4,
    });
    expect(result.success).toBe(true);
  });
});
