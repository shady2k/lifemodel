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
  const wakeHour = 8; // Default wake hour for tests

  describe('resolveSemanticAnchor - relative', () => {
    it('should resolve "in 30 minutes"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'relative',
        relative: { unit: 'minute', amount: 30 },
        confidence: 0.9,
        originalPhrase: 'in 30 minutes',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

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

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      expect(result.triggerAt.getTime()).toBe(baseTime.getTime() + 2 * 60 * 60 * 1000);
    });

    it('should resolve "in 3 days"', () => {
      const anchor: SemanticDateAnchor = {
        type: 'relative',
        relative: { unit: 'day', amount: 3 },
        confidence: 0.9,
        originalPhrase: 'in 3 days',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      expect(result.triggerAt.getTime()).toBe(baseTime.getTime() + 3 * 24 * 60 * 60 * 1000);
    });
  });

  describe('resolveSemanticAnchor - absolute', () => {
    it('should resolve "tomorrow at 3pm" when current time is after wake hour', () => {
      // Use a base time that's actually after wake hour in the local timezone
      // March 15, 2024 1:00 PM UTC = 9:00 AM EDT (after wake hour 8 AM)
      const baseTimeAfterWake = new Date('2024-03-15T13:00:00Z');

      const anchor: SemanticDateAnchor = {
        type: 'absolute',
        absolute: { special: 'tomorrow', hour: 15, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'tomorrow at 3pm',
      };

      const result = resolveSemanticAnchor(anchor, baseTimeAfterWake, timezone, wakeHour);

      // Should be March 16th at 3pm in the user's timezone
      const expected = new Date(result.triggerAt);
      expect(expected.getDate()).toBe(16);
      expect(result.recurrence).toBeNull();
    });

    it('should resolve "tomorrow" before wake hour as today at 9am', () => {
      // User asks at 1 AM for "tomorrow" - should mean today at 9 AM
      const earlyMorning = new Date('2024-03-15T01:00:00Z'); // 1 AM UTC
      const timezone = 'Europe/Moscow'; // UTC+3, so this is 4 AM local time
      const wakeHour = 8; // User wakes at 8 AM

      const anchor: SemanticDateAnchor = {
        type: 'absolute',
        absolute: { special: 'tomorrow' },
        confidence: 0.9,
        originalPhrase: 'tomorrow',
      };

      const result = resolveSemanticAnchor(anchor, earlyMorning, timezone, wakeHour);

      // Should be today (March 15th) at 9 AM, not tomorrow
      const expected = new Date(result.triggerAt);
      expect(expected.getUTCDate()).toBe(15); // Same day, not tomorrow
      expect(expected.getUTCHours()).toBe(6); // 9 AM Moscow time = 6 AM UTC
    });

    it('should resolve "tomorrow" after wake hour as tomorrow at 9am', () => {
      // User asks at 2 PM for "tomorrow" - should mean tomorrow at 9 AM
      const afternoon = new Date('2024-03-15T11:00:00Z'); // 11 AM UTC = 2 PM Moscow time
      const timezone = 'Europe/Moscow'; // UTC+3
      const wakeHour = 8; // User wakes at 8 AM

      const anchor: SemanticDateAnchor = {
        type: 'absolute',
        absolute: { special: 'tomorrow' },
        confidence: 0.9,
        originalPhrase: 'tomorrow',
      };

      const result = resolveSemanticAnchor(anchor, afternoon, timezone, wakeHour);

      // Should be tomorrow (March 16th) at 9 AM
      const expected = new Date(result.triggerAt);
      expect(expected.getUTCDate()).toBe(16); // Next day
      expect(expected.getUTCHours()).toBe(6); // 9 AM Moscow time = 6 AM UTC
    });

    it('should resolve explicit date/time', () => {
      const anchor: SemanticDateAnchor = {
        type: 'absolute',
        absolute: { month: 4, day: 1, hour: 9, minute: 30 },
        confidence: 0.9,
        originalPhrase: 'April 1st at 9:30am',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

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

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

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

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

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

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      expect(result.recurrence?.frequency).toBe('weekly');
      expect(result.recurrence?.interval).toBe(2);
    });
  });

  describe('resolveSemanticAnchor - recurring monthly range (dayOfMonthEnd)', () => {
    it('should resolve within window, time not passed → today', () => {
      // baseTime is March 15 10:00 UTC → March 15 06:00 EDT
      // dayOfMonth=13, dayOfMonthEnd=18, hour=10 (EDT) → 10:00 EDT hasn't passed (it's 06:00)
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'monthly', interval: 1, dayOfMonth: 13, dayOfMonthEnd: 18, hour: 10, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'с 13 по 18 каждого месяца',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      expect(result.recurrence?.dayOfMonth).toBe(13);
      expect(result.recurrence?.dayOfMonthEnd).toBe(18);
      // Should fire today (15th) since within window and time hasn't passed
      const triggerDt = new Date(result.triggerAt);
      expect(triggerDt.getDate()).toBe(15);
      expect(triggerDt.getMonth()).toBe(2); // March
    });

    it('should resolve within window, time already passed, not last day → tomorrow', () => {
      // baseTime March 15 10:00 UTC → 06:00 EDT
      // Set hour=5 so 05:00 EDT has already passed at 06:00 EDT
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'monthly', interval: 1, dayOfMonth: 13, dayOfMonthEnd: 18, hour: 5, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'с 13 по 18 каждого месяца в 5 утра',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      // Time passed today (15th), still within window → tomorrow (16th)
      const triggerDt = new Date(result.triggerAt);
      expect(triggerDt.getDate()).toBe(16);
      expect(triggerDt.getMonth()).toBe(2); // March
    });

    it('should resolve past window → next month start day', () => {
      // baseTime March 15 10:00 UTC
      // dayOfMonth=10, dayOfMonthEnd=13 → window is 10-13, we're on 15 → past window
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'monthly', interval: 1, dayOfMonth: 10, dayOfMonthEnd: 13, hour: 10, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'с 10 по 13 каждого месяца',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      // Past window → next month's start day (April 10)
      const triggerDt = new Date(result.triggerAt);
      expect(triggerDt.getMonth()).toBe(3); // April
      expect(triggerDt.getDate()).toBe(10);
    });

    it('should resolve before window → start day this month', () => {
      // baseTime March 15 10:00 UTC
      // dayOfMonth=20, dayOfMonthEnd=25 → window is 20-25, we're on 15 → before window
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'monthly', interval: 1, dayOfMonth: 20, dayOfMonthEnd: 25, hour: 10, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'с 20 по 25 каждого месяца',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      // Before window → start day this month (March 20)
      const triggerDt = new Date(result.triggerAt);
      expect(triggerDt.getMonth()).toBe(2); // March
      expect(triggerDt.getDate()).toBe(20);
    });

    it('should clamp to short month (Feb)', () => {
      // Feb 2024 has 29 days (leap year)
      const febBase = new Date('2024-02-20T10:00:00Z');
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'monthly', interval: 1, dayOfMonth: 29, dayOfMonthEnd: 31, hour: 10, minute: 0 },
        confidence: 0.9,
        originalPhrase: 'с 29 по 31 каждого месяца',
      };

      const result = resolveSemanticAnchor(anchor, febBase, timezone, wakeHour);

      // Feb has 29 days → clamped to 29..29 → fires on 29th
      const triggerDt = new Date(result.triggerAt);
      expect(triggerDt.getMonth()).toBe(1); // February
      expect(triggerDt.getDate()).toBe(29);
    });

    it('should pass dayOfMonthEnd through to recurrence spec', () => {
      const anchor: SemanticDateAnchor = {
        type: 'recurring',
        recurring: { frequency: 'monthly', interval: 1, dayOfMonth: 20, dayOfMonthEnd: 25, hour: 10 },
        confidence: 0.9,
        originalPhrase: 'с 20 по 25',
      };

      const result = resolveSemanticAnchor(anchor, baseTime, timezone, wakeHour);

      expect(result.recurrence?.dayOfMonthEnd).toBe(25);
      expect(result.recurrence?.dayOfMonth).toBe(20);
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

    it('should format monthly with day range', () => {
      const result = formatRecurrence({
        frequency: 'monthly',
        interval: 1,
        dayOfMonth: 20,
        dayOfMonthEnd: 25,
        endDate: null,
        maxOccurrences: null,
      });
      expect(result).toBe('monthly, 20th–25th');
    });

    it('should default missing interval to 1', () => {
      const result = formatRecurrence({
        frequency: 'monthly',
        dayOfMonth: 26,
        endDate: null,
        maxOccurrences: null,
      } as import('../../../src/types/plugin.js').RecurrenceSpec);
      expect(result).toBe('monthly on the 26th');
    });
  });
});
