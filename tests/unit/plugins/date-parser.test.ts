/**
 * Date Parser Tests
 *
 * Tests for the reminder plugin's semantic date anchor resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSemanticAnchor,
  formatRecurrence,
} from '../../../src/plugins/reminder/date-parser.js';
import type { SemanticDateAnchor } from '../../../src/plugins/reminder/reminder-types.js';

describe('Date Parser', () => {
  const baseTime = new Date('2024-03-15T10:00:00Z');
  const timezone = 'America/New_York'; // UTC-4/5

  describe('resolveSemanticAnchor - relative', () => {
    it('should resolve "in 30 minutes"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'relative',
        relative: { unit: 'minute', amount: 30 },
        confidence: 0.9,
        originalPhrase: 'in 30 minutes',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      expect(result.triggerAt.getTime()).toBe(baseTime.getTime() + 30 * 60 * 1000);
      expect(result.recurrence).toBeNull();
    });

    it('should resolve "in 2 hours"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'relative',
        relative: { unit: 'hour', amount: 2 },
        confidence: 0.9,
        originalPhrase: 'in 2 hours',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      expect(result.triggerAt.getTime()).toBe(baseTime.getTime() + 2 * 60 * 60 * 1000);
    });

    it('should resolve "in 3 days"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'relative',
        relative: { unit: 'day', amount: 3 },
        confidence: 0.9,
        originalPhrase: 'in 3 days',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      expect(result.triggerAt.getTime()).toBe(baseTime.getTime() + 3 * 24 * 60 * 60 * 1000);
    });
  });

  describe('resolveSemanticAnchor - absolute', () => {
    it('should resolve "tomorrow at 3pm"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'absolute',
        absolute: { special: 'tomorrow', hour: 15, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'tomorrow at 3pm',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      // Should be March 16th at 3pm in the user's timezone
      const expected = new Date(result.triggerAt);
      expect(expected.getDate()).toBe(16);
      expect(result.recurrence).toBeNull();
    });

    it('should resolve explicit date/time', () => {
      const anchor: SemanticDateAnchor = {
        type: 'absolute',
        absolute: { month: 4, day: 1, hour: 9, minute: 30 },
        confidence: 0.9,
        originalPhrase: 'April 1st at 9:30am',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      const expected = new Date(result.triggerAt);
      expect(expected.getMonth()).toBe(3); // April (0-indexed)
      expect(expected.getDate()).toBe(1);
    });
  });

  describe('resolveSemanticAnchor - recurring', () => {
    it('should resolve "every day at 9am"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'daily', interval: 1, hour: 9, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'every day at 9am',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      expect(result.recurrence).not.toBeNull();
      expect(result.recurrence?.frequency).toBe('daily');
      expect(result.recurrence?.interval).toBe(1);
      expect(result.localTime).toBe('09:00');
    });

    it('should resolve "every Monday at 10am"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'weekly', interval: 1, daysOfWeek: [1], hour: 10, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'every Monday at 10am',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      expect(result.recurrence).not.toBeNull();
      expect(result.recurrence?.frequency).toBe('weekly');
      expect(result.recurrence?.daysOfWeek).toEqual([1]);
    });

    it('should resolve "every 2 weeks"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'weekly', interval: 2, hour: 9 },
        confidence: 0.9,
        originalPhrase: 'every 2 weeks',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone);

      expect(result.recurrence?.frequency).toBe('weekly');
      expect(result.recurrence?.interval).toBe(2);
    });
  });

  describe('formatRecurrence', () => {
    it('should format daily recurrence', () => {
      const result = formatRecurrence({
        frequency: 'daily',
        interval: 1,
        endDate: null,
        maxOccurrences: null,
      });
      expect(result).toBe('daily');
    });

    it('should format every N days', () => {
      const result = formatRecurrence({
        frequency: 'daily',
        interval: 3,
        endDate: null,
        maxOccurrences: null,
      });
      expect(result).toBe('every 3 days');
    });

    it('should format weekly with days', () => {
      const result = formatRecurrence({
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [1, 3, 5],
        endDate: null,
        maxOccurrences: null,
      });
      expect(result).toBe('weekly on Mon, Wed, Fri');
    });

    it('should format monthly with day', () => {
      const result = formatRecurrence({
        frequency: 'monthly',
        interval: 1,
        dayOfMonth: 15,
        endDate: null,
        maxOccurrences: null,
      });
      expect(result).toBe('monthly on the 15th');
    });
  });
});
