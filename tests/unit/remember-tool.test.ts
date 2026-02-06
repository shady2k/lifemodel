/**
 * Tests for core.remember tool
 *
 * Validates:
 * - Explicit source enum validation
 * - Default confidence from source type
 * - Field policy enforcement
 * - Subject normalization
 * - Strict mode null handling
 */

import { describe, it, expect } from 'vitest';
import { createRememberTool, type RememberResult } from '../../src/layers/cognition/tools/core/remember.js';

describe('core.remember tool', () => {
  const tool = createRememberTool();

  describe('schema', () => {
    it('has correct name and description', () => {
      expect(tool.name).toBe('core.remember');
      expect(tool.description).toContain('Remember a fact');
    });

    it('has required parameters: attribute, value', () => {
      const required = tool.parameters.filter((p) => p.required);
      expect(required.map((p) => p.name)).toEqual(['attribute', 'value']);
    });

    it('has optional subject, source, confidence parameters', () => {
      const optional = tool.parameters.filter((p) => !p.required);
      expect(optional.map((p) => p.name)).toEqual(['subject', 'source', 'confidence']);
    });

    it('source parameter has enum constraint', () => {
      const source = tool.parameters.find((p) => p.name === 'source');
      expect(source?.enum).toEqual(['user_quote', 'user_explicit', 'user_implicit', 'inferred']);
    });

    it('marks tool as having side effects', () => {
      expect(tool.hasSideEffects).toBe(true);
    });
  });

  describe('source enum validation', () => {
    it('accepts valid source: user_quote', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        source: 'user_quote',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.source).toBe('user_quote');
    });

    it('accepts valid source: user_explicit', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'language',
        value: 'Russian',
        source: 'user_explicit',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.source).toBe('user_explicit');
    });

    it('accepts valid source: user_implicit', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'timezone',
        value: 'Europe/Moscow',
        source: 'user_implicit',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.source).toBe('user_implicit');
    });

    it('accepts valid source: inferred', async () => {
      const result = (await tool.execute({
        subject: 'topic',
        attribute: 'interest',
        value: 'programming',
        source: 'inferred',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.source).toBe('inferred');
    });

    it('rejects invalid source', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        source: 'user_said', // Invalid!
      })) as RememberResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid source');
      expect(result.error).toContain('user_said');
    });
  });

  describe('default confidence by source', () => {
    it('user_quote defaults to 0.98', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        source: 'user_quote',
      })) as RememberResult;

      expect(result.confidence).toBe(0.98);
    });

    it('user_explicit defaults to 0.95', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        source: 'user_explicit',
      })) as RememberResult;

      expect(result.confidence).toBe(0.95);
    });

    it('user_implicit defaults to 0.85', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'language',
        value: 'English',
        source: 'user_implicit',
      })) as RememberResult;

      expect(result.confidence).toBe(0.85);
    });

    it('inferred defaults to 0.6', async () => {
      const result = (await tool.execute({
        subject: 'topic',
        attribute: 'category',
        value: 'tech',
        source: 'inferred',
      })) as RememberResult;

      expect(result.confidence).toBe(0.6);
    });

    it('respects explicit confidence override', async () => {
      // Use a non-user subject to avoid field policy interference
      const result = (await tool.execute({
        subject: 'topic',
        attribute: 'note',
        value: 'test',
        source: 'user_quote',
        confidence: 0.75,
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.confidence).toBe(0.75);
    });

    it('handles null confidence (strict mode)', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        source: 'user_quote',
        confidence: null, // Strict mode sends null for optional fields
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.confidence).toBe(0.98); // Falls back to default
    });
  });

  describe('confidence validation', () => {
    it('rejects confidence below 0', async () => {
      const result = (await tool.execute({
        subject: 'topic',
        attribute: 'note',
        value: 'test',
        source: 'inferred',
        confidence: -0.1,
      })) as RememberResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Confidence must be between 0 and 1');
    });

    it('rejects confidence above 1', async () => {
      const result = (await tool.execute({
        subject: 'topic',
        attribute: 'note',
        value: 'test',
        source: 'inferred',
        confidence: 1.5,
      })) as RememberResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Confidence must be between 0 and 1');
    });

    it('accepts confidence at boundaries', async () => {
      const result0 = (await tool.execute({
        subject: 'topic',
        attribute: 'note',
        value: 'test',
        source: 'inferred',
        confidence: 0,
      })) as RememberResult;
      expect(result0.success).toBe(true);

      const result1 = (await tool.execute({
        subject: 'topic',
        attribute: 'note',
        value: 'test',
        source: 'inferred',
        confidence: 1,
      })) as RememberResult;
      expect(result1.success).toBe(true);
    });
  });

  describe('subject normalization', () => {
    it.each(['user', 'User', 'USER', 'me', 'Me', 'my', 'self', 'recipient', 'i', 'I'])(
      'normalizes "%s" to "user"',
      async (subject) => {
        const result = (await tool.execute({
          subject,
          attribute: 'mood',
          value: 'happy',
          source: 'inferred',
        })) as RememberResult;

        expect(result.success).toBe(true);
        expect(result.subject).toBe('user');
        expect(result.isUserFact).toBe(true);
      }
    );

    it('preserves other subject names', async () => {
      const result = (await tool.execute({
        subject: 'Alice',
        attribute: 'relationship',
        value: 'friend',
        source: 'user_explicit',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.subject).toBe('Alice');
      expect(result.isUserFact).toBe(false);
    });

    it('trims whitespace from subject', async () => {
      const result = (await tool.execute({
        subject: '  Bob  ',
        attribute: 'note',
        value: 'test',
        source: 'inferred',
      })) as RememberResult;

      expect(result.subject).toBe('Bob');
    });
  });

  describe('field policy enforcement', () => {
    describe('user.name (high-stakes)', () => {
      it('rejects inferred source (fails confidence check first)', async () => {
        // Inferred source defaults to 0.6 confidence, which fails the 0.9 requirement
        const result = (await tool.execute({
          subject: 'user',
          attribute: 'name',
          value: 'Alice',
          source: 'inferred',
        })) as RememberResult;

        expect(result.success).toBe(false);
        expect(result.error).toContain('user.name requires confidence >= 0.9');
      });

      it('rejects user_implicit source (fails source policy)', async () => {
        // user_implicit has 0.85 confidence (passes), but wrong source type
        // However, 0.85 < 0.9, so it fails confidence first
        const result = (await tool.execute({
          subject: 'user',
          attribute: 'name',
          value: 'Alice',
          source: 'user_implicit',
        })) as RememberResult;

        expect(result.success).toBe(false);
        // Confidence check runs first: 0.85 < 0.9
        expect(result.error).toContain('user.name requires confidence >= 0.9');
      });

      it('rejects high confidence with wrong source', async () => {
        // Override confidence to pass the check, but use wrong source
        const result = (await tool.execute({
          subject: 'user',
          attribute: 'name',
          value: 'Alice',
          source: 'user_implicit', // Not in [user_quote, user_explicit]
          confidence: 0.95, // Override to pass confidence check
        })) as RememberResult;

        expect(result.success).toBe(false);
        expect(result.error).toContain('user.name requires source from');
        expect(result.error).toContain('user_quote');
      });

      it('accepts user_quote for name', async () => {
        const result = (await tool.execute({
          subject: 'user',
          attribute: 'name',
          value: 'Alice',
          source: 'user_quote',
        })) as RememberResult;

        expect(result.success).toBe(true);
      });
    });

    describe('user.birthday (high-stakes)', () => {
      it('requires confidence >= 0.9', async () => {
        const result = (await tool.execute({
          subject: 'user',
          attribute: 'birthday',
          value: 'November 9',
          source: 'user_implicit', // Defaults to 0.85, below 0.9
        })) as RememberResult;

        expect(result.success).toBe(false);
        expect(result.error).toContain('user.birthday requires confidence >= 0.9');
      });

      it('accepts user_quote for birthday', async () => {
        const result = (await tool.execute({
          subject: 'user',
          attribute: 'birthday',
          value: 'November 9',
          source: 'user_quote', // 0.98 confidence
        })) as RememberResult;

        expect(result.success).toBe(true);
        expect(result.value).toBe('November 9');
      });
    });

    describe('user.mood (low-stakes)', () => {
      it('accepts inferred source for mood', async () => {
        const result = (await tool.execute({
          subject: 'user',
          attribute: 'mood',
          value: 'tired',
          source: 'inferred',
        })) as RememberResult;

        expect(result.success).toBe(true);
      });
    });

    describe('non-user facts', () => {
      it('does not enforce field policies for non-user subjects', async () => {
        const result = (await tool.execute({
          subject: 'Alice',
          attribute: 'birthday', // Same attribute, but not "user"
          value: 'March 15',
          source: 'inferred',
          confidence: 0.5,
        })) as RememberResult;

        expect(result.success).toBe(true);
        expect(result.isUserFact).toBe(false);
      });
    });
  });

  describe('required fields validation', () => {
    it('rejects missing attribute', async () => {
      const result = (await tool.execute({
        value: 'Alice',
      })) as RememberResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required fields');
    });

    it('rejects missing value', async () => {
      const result = (await tool.execute({
        attribute: 'name',
      })) as RememberResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required fields');
    });

    it('defaults subject to "user" when omitted', async () => {
      const result = (await tool.execute({
        attribute: 'mood',
        value: 'happy',
        source: 'inferred',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.subject).toBe('user');
      expect(result.isUserFact).toBe(true);
    });

    it('defaults source to "user_implicit" when omitted', async () => {
      const result = (await tool.execute({
        attribute: 'work_style',
        value: 'prefers structure',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.source).toBe('user_implicit');
      expect(result.confidence).toBe(0.85);
    });

    it('works with just attribute and value (minimal call)', async () => {
      const result = (await tool.execute({
        attribute: 'coffee_preference',
        value: 'dark roast',
      })) as RememberResult;

      expect(result.success).toBe(true);
      expect(result.subject).toBe('user');
      expect(result.source).toBe('user_implicit');
      expect(result.confidence).toBe(0.85);
      expect(result.isUserFact).toBe(true);
    });
  });

  describe('result structure', () => {
    it('returns correct structure on success', async () => {
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        source: 'user_quote',
        confidence: 0.99,
      })) as RememberResult;

      expect(result).toEqual({
        success: true,
        action: 'remember',
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        confidence: 0.99,
        source: 'user_quote',
        isUserFact: true,
      });
    });

    it('returns clean value without provenance markers', async () => {
      // The new implementation expects clean values - no parsing needed
      const result = (await tool.execute({
        subject: 'user',
        attribute: 'birthday',
        value: '9 ноября', // Clean value, not "9 ноября (user said)"
        source: 'user_quote',
      })) as RememberResult;

      expect(result.value).toBe('9 ноября');
    });
  });
});
