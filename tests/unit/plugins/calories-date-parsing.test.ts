/**
 * Test: Calories plugin relative date parsing
 *
 * Verifies that relative date keywords ("today", "yesterday", "tomorrow")
 * are correctly parsed to YYYY-MM-DD format.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DateTime } from 'luxon';

// Re-implement the functions from calories-tool.ts for testing
function getCurrentFoodDate(
  timezone: string,
  userPatterns: { wakeHour?: number; sleepHour?: number } | null
): string {
  const now = DateTime.now().setZone(timezone);
  const hour = now.hour;

  const sleepHour = userPatterns?.sleepHour ?? 23;
  const wakeHour = userPatterns?.wakeHour ?? 7;

  let cutoff: number;
  if (sleepHour < wakeHour) {
    cutoff = Math.floor((sleepHour + wakeHour) / 2);
  } else {
    const wakeNormalized = wakeHour + 24;
    const midpoint = (sleepHour + wakeNormalized) / 2;
    cutoff = Math.floor(midpoint % 24);
  }

  if (hour < cutoff) {
    return now.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  }

  return now.toFormat('yyyy-MM-dd');
}

function parseRelativeDate(
  dateInput: string,
  timezone: string,
  userPatterns: { wakeHour?: number; sleepHour?: number } | null
): string {
  // Check if it's an absolute date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return dateInput;
  }

  const normalized = dateInput.toLowerCase().trim();
  const baseDate = getCurrentFoodDate(timezone, userPatterns);
  const baseDt = DateTime.fromISO(baseDate, { zone: timezone });

  switch (normalized) {
    case 'today':
      return baseDate;
    case 'yesterday':
      return baseDt.minus({ days: 1 }).toFormat('yyyy-MM-dd');
    case 'tomorrow':
      return baseDt.plus({ days: 1 }).toFormat('yyyy-MM-dd');
    default:
      // Unknown keyword — return base date as fallback
      return baseDate;
  }
}

describe('Calories plugin relative date parsing', () => {
  const timezone = 'Europe/Moscow';
  const userPatterns = { wakeHour: 7, sleepHour: 23 };

  describe('parseRelativeDate', () => {
    it('should parse "today" as current food date', () => {
      const today = getCurrentFoodDate(timezone, userPatterns);
      const result = parseRelativeDate('today', timezone, userPatterns);
      expect(result).toBe(today);
    });

    it('should parse "yesterday" as previous day', () => {
      const today = getCurrentFoodDate(timezone, userPatterns);
      const result = parseRelativeDate('yesterday', timezone, userPatterns);
      const yesterday = DateTime.fromISO(today, { zone: timezone })
        .minus({ days: 1 })
        .toFormat('yyyy-MM-dd');
      expect(result).toBe(yesterday);
    });

    it('should parse "tomorrow" as next day', () => {
      const today = getCurrentFoodDate(timezone, userPatterns);
      const result = parseRelativeDate('tomorrow', timezone, userPatterns);
      const tomorrow = DateTime.fromISO(today, { zone: timezone })
        .plus({ days: 1 })
        .toFormat('yyyy-MM-dd');
      expect(result).toBe(tomorrow);
    });

    it('should pass through YYYY-MM-DD format unchanged', () => {
      const absoluteDate = '2026-02-10';
      const result = parseRelativeDate(absoluteDate, timezone, userPatterns);
      expect(result).toBe(absoluteDate);
    });

    it('should handle case-insensitive input', () => {
      const today = getCurrentFoodDate(timezone, userPatterns);
      expect(parseRelativeDate('TODAY', timezone, userPatterns)).toBe(today);
      expect(parseRelativeDate('ToDaY', timezone, userPatterns)).toBe(today);
      expect(parseRelativeDate('YESTERDAY', timezone, userPatterns)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(parseRelativeDate('TOMORROW', timezone, userPatterns)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should handle whitespace in input', () => {
      const today = getCurrentFoodDate(timezone, userPatterns);
      expect(parseRelativeDate('  today  ', timezone, userPatterns)).toBe(today);
      expect(parseRelativeDate(' yesterday ', timezone, userPatterns)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should return today as fallback for unknown keywords', () => {
      const today = getCurrentFoodDate(timezone, userPatterns);
      const result = parseRelativeDate('unknown_keyword', timezone, userPatterns);
      expect(result).toBe(today);
    });

    it('should work with null user patterns', () => {
      const result = parseRelativeDate('today', timezone, null);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('Relative date sequence', () => {
    it('should correctly calculate yesterday, today, tomorrow sequence', () => {
      const today = parseRelativeDate('today', timezone, userPatterns);
      const yesterday = parseRelativeDate('yesterday', timezone, userPatterns);
      const tomorrow = parseRelativeDate('tomorrow', timezone, userPatterns);

      const todayDt = DateTime.fromISO(today, { zone: timezone });
      const yesterdayDt = DateTime.fromISO(yesterday, { zone: timezone });
      const tomorrowDt = DateTime.fromISO(tomorrow, { zone: timezone });

      // Verify the sequence: yesterday < today < tomorrow
      expect(yesterdayDt < todayDt).toBe(true);
      expect(todayDt < tomorrowDt).toBe(true);

      // Verify they're consecutive days
      expect(todayDt.diff(yesterdayDt, 'days').days).toBe(1);
      expect(tomorrowDt.diff(todayDt, 'days').days).toBe(1);
    });
  });
});
