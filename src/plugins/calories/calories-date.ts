/**
 * Shared date utilities for the calories plugin.
 *
 * The "food day" boundary is based on the midpoint of the user's sleep period,
 * not calendar midnight. For example, with sleepHour=23 and wakeHour=8,
 * the cutoff is 3 AM — entries before 3 AM belong to the previous food day.
 */

import { DateTime } from 'luxon';
import { calculateSleepMidpointHour } from '../../utils/date.js';

// Re-export under the old name for calories-tool.ts compatibility
export const calculateCutoffHour = calculateSleepMidpointHour;

/**
 * Get the current "food day" based on user's sleep patterns.
 * Before the sleep-midpoint cutoff = still "yesterday."
 */
export function getCurrentFoodDate(
  timezone: string,
  userPatterns: { wakeHour?: number | undefined; sleepHour?: number | undefined } | null
): string {
  const now = DateTime.now().setZone(timezone);
  return getFoodDateForDateTime(now, userPatterns);
}

/**
 * Get the food day for a specific DateTime instance.
 * Useful for both "now" queries and testing with fixed times.
 */
export function getFoodDateForDateTime(
  dt: DateTime,
  userPatterns: { wakeHour?: number | undefined; sleepHour?: number | undefined } | null
): string {
  const hour = dt.hour;

  const sleepHour = userPatterns?.sleepHour ?? 23;
  const wakeHour = userPatterns?.wakeHour ?? 7;

  const cutoff = calculateCutoffHour(sleepHour, wakeHour);

  if (hour < cutoff) {
    return dt.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  }

  return dt.toFormat('yyyy-MM-dd');
}
