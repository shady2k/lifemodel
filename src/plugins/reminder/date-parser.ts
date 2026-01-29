/**
 * Date Parser for Reminder Plugin
 *
 * Resolves semantic date anchors to concrete UTC timestamps.
 * DST-aware for recurring schedules using Luxon.
 */

import { DateTime } from 'luxon';
import type { RecurrenceSpec } from '../../types/plugin.js';
import type {
  SemanticDateAnchor,
  RelativeTime,
  AbsoluteTime,
  RecurringTime,
  DateConstraint,
} from './reminder-types.js';

/**
 * Result of resolving a semantic anchor.
 */
export interface ResolvedDate {
  /** Concrete trigger time (UTC) */
  triggerAt: Date;

  /** Recurrence specification for recurring reminders */
  recurrence: RecurrenceSpec | null;

  /** Local time string (HH:mm) for recurring */
  localTime: string | null;
}

/**
 * Resolve a semantic date anchor to a concrete date.
 *
 * @param anchor The semantic anchor from LLM
 * @param baseTime Base time for calculations (usually now)
 * @param timezone User's timezone (IANA name, e.g., "America/New_York")
 */
export function resolveSemanticAnchor(
  anchor: SemanticDateAnchor,
  baseTime: Date,
  timezone: string
): ResolvedDate {
  const baseDt = DateTime.fromJSDate(baseTime, { zone: timezone });

  switch (anchor.type) {
    case 'relative':
      if (!anchor.relative) {
        throw new Error('Relative anchor missing relative data');
      }
      return resolveRelative(anchor.relative, baseDt);

    case 'absolute':
      if (!anchor.absolute) {
        throw new Error('Absolute anchor missing absolute data');
      }
      return resolveAbsolute(anchor.absolute, baseDt, timezone);

    case 'recurring':
      if (!anchor.recurring) {
        throw new Error('Recurring anchor missing recurring data');
      }
      return resolveRecurring(anchor.recurring, baseDt, timezone);

    default:
      throw new Error(`Unknown anchor type: ${String(anchor.type)}`);
  }
}

/**
 * Resolve relative time (e.g., "in 30 minutes").
 */
function resolveRelative(relative: RelativeTime, baseDt: DateTime): ResolvedDate {
  let triggerDt: DateTime;

  switch (relative.unit) {
    case 'minute':
      triggerDt = baseDt.plus({ minutes: relative.amount });
      break;
    case 'hour':
      triggerDt = baseDt.plus({ hours: relative.amount });
      break;
    case 'day':
      triggerDt = baseDt.plus({ days: relative.amount });
      break;
    case 'week':
      triggerDt = baseDt.plus({ weeks: relative.amount });
      break;
    case 'month':
      triggerDt = baseDt.plus({ months: relative.amount });
      break;
    default:
      throw new Error(`Unknown relative unit: ${String(relative.unit)}`);
  }

  return {
    triggerAt: triggerDt.toJSDate(),
    recurrence: null,
    localTime: null,
  };
}

/**
 * Resolve absolute time (e.g., "tomorrow at 3pm").
 */
function resolveAbsolute(
  absolute: AbsoluteTime,
  baseDt: DateTime,
  _timezone: string
): ResolvedDate {
  let triggerDt = baseDt;

  // Handle special named times first
  if (absolute.special) {
    triggerDt = resolveSpecialTime(absolute.special, baseDt);
  }

  // Handle day of week (e.g., "next Monday")
  if (absolute.dayOfWeek !== undefined) {
    triggerDt = resolveNextDayOfWeek(absolute.dayOfWeek, baseDt);
  }

  // Apply explicit date components
  if (absolute.year !== undefined) {
    triggerDt = triggerDt.set({ year: absolute.year });
  }
  if (absolute.month !== undefined) {
    triggerDt = triggerDt.set({ month: absolute.month });
  }
  if (absolute.day !== undefined) {
    triggerDt = triggerDt.set({ day: absolute.day });
  }

  // Apply time components (default to 9am if no time specified)
  const hour = absolute.hour ?? 9;
  const minute = absolute.minute ?? 0;
  triggerDt = triggerDt.set({ hour, minute, second: 0, millisecond: 0 });

  // If the resolved time is in the past, adjust
  if (triggerDt <= baseDt) {
    // If only time was specified, assume next occurrence
    if (
      absolute.day === undefined &&
      absolute.month === undefined &&
      !absolute.special &&
      absolute.dayOfWeek === undefined
    ) {
      triggerDt = triggerDt.plus({ days: 1 });
    }
  }

  return {
    triggerAt: triggerDt.toJSDate(),
    recurrence: null,
    localTime: null,
  };
}

/**
 * Resolve special named times.
 */
function resolveSpecialTime(special: AbsoluteTime['special'], baseDt: DateTime): DateTime {
  switch (special) {
    case 'tomorrow':
      return baseDt.plus({ days: 1 }).startOf('day');

    case 'next_week':
      // Next Monday
      return resolveNextDayOfWeek(1, baseDt);

    case 'next_month':
      return baseDt.plus({ months: 1 }).startOf('month');

    case 'this_evening': {
      // 6pm today, or tomorrow if past 6pm
      const evening = baseDt.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
      return evening <= baseDt ? evening.plus({ days: 1 }) : evening;
    }

    case 'tonight': {
      // 8pm today, or tomorrow if past 8pm
      const tonight = baseDt.set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
      return tonight <= baseDt ? tonight.plus({ days: 1 }) : tonight;
    }

    case 'this_afternoon': {
      // 2pm today, or tomorrow if past 2pm
      const afternoon = baseDt.set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
      return afternoon <= baseDt ? afternoon.plus({ days: 1 }) : afternoon;
    }

    default:
      return baseDt;
  }
}

/**
 * Resolve next occurrence of a day of week.
 */
function resolveNextDayOfWeek(targetDow: number, baseDt: DateTime): DateTime {
  // Luxon uses 1=Monday, 7=Sunday
  // Our API uses 0=Sunday, 6=Saturday
  const luxonDow = targetDow === 0 ? 7 : targetDow;
  const currentDow = baseDt.weekday;

  let daysToAdd: number;
  if (luxonDow > currentDow) {
    daysToAdd = luxonDow - currentDow;
  } else {
    // Next week
    daysToAdd = 7 - currentDow + luxonDow;
  }

  return baseDt.plus({ days: daysToAdd }).startOf('day');
}

/**
 * Resolve recurring time (e.g., "every day at 9am").
 */
function resolveRecurring(
  recurring: RecurringTime,
  baseDt: DateTime,
  _timezone: string
): ResolvedDate {
  // Calculate first occurrence
  let firstOccurrence = baseDt;

  // Set the time
  const hour = recurring.hour ?? 9;
  const minute = recurring.minute ?? 0;
  firstOccurrence = firstOccurrence.set({ hour, minute, second: 0, millisecond: 0 });

  // Adjust based on frequency
  switch (recurring.frequency) {
    case 'daily':
      // If time already passed today, start tomorrow
      if (firstOccurrence <= baseDt) {
        firstOccurrence = firstOccurrence.plus({ days: 1 });
      }
      break;

    case 'weekly':
      if (recurring.daysOfWeek && recurring.daysOfWeek.length > 0) {
        // Find next matching day
        firstOccurrence = findNextMatchingDay(baseDt, recurring.daysOfWeek, hour, minute);
      } else {
        // Default to same day next week if no days specified
        if (firstOccurrence <= baseDt) {
          firstOccurrence = firstOccurrence.plus({ weeks: 1 });
        }
      }
      break;

    case 'monthly':
      if (recurring.anchorDay !== undefined && recurring.constraint) {
        // Constraint-based scheduling: "weekend after 10th", etc.
        firstOccurrence = resolveConstrainedMonthly(
          baseDt,
          recurring.anchorDay,
          recurring.constraint,
          hour,
          minute
        );
      } else if (recurring.dayOfMonth !== undefined) {
        // Fixed day of month
        firstOccurrence = firstOccurrence.set({
          day: Math.min(recurring.dayOfMonth, firstOccurrence.daysInMonth ?? 28),
        });
        if (firstOccurrence <= baseDt) {
          firstOccurrence = firstOccurrence.plus({ months: 1 });
          // Re-adjust day for month with fewer days
          firstOccurrence = firstOccurrence.set({
            day: Math.min(recurring.dayOfMonth, firstOccurrence.daysInMonth ?? 28),
          });
        }
      }
      break;
  }

  // Build recurrence spec
  const recurrence: RecurrenceSpec = {
    frequency: recurring.frequency,
    interval: recurring.interval,
    endDate: null,
    maxOccurrences: null,
  };
  if (recurring.daysOfWeek) {
    recurrence.daysOfWeek = recurring.daysOfWeek;
  }
  if (recurring.dayOfMonth !== undefined) {
    recurrence.dayOfMonth = recurring.dayOfMonth;
  }
  if (recurring.anchorDay !== undefined) {
    recurrence.anchorDay = recurring.anchorDay;
  }
  if (recurring.constraint) {
    recurrence.constraint = recurring.constraint;
  }

  // Store local time for DST-aware scheduling
  const localTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  return {
    triggerAt: firstOccurrence.toJSDate(),
    recurrence,
    localTime,
  };
}

/**
 * Find next matching day from a list of days of week.
 */
function findNextMatchingDay(
  baseDt: DateTime,
  daysOfWeek: number[],
  hour: number,
  minute: number
): DateTime {
  // Convert our 0=Sunday format to Luxon 1=Monday format
  const luxonDays = daysOfWeek.map((d) => (d === 0 ? 7 : d)).sort((a, b) => a - b);
  const currentLuxonDow = baseDt.weekday;

  // Try today first if it's a matching day and time hasn't passed
  const todayTime = baseDt.set({ hour, minute, second: 0, millisecond: 0 });
  if (luxonDays.includes(currentLuxonDow) && todayTime > baseDt) {
    return todayTime;
  }

  // Find next matching day
  for (const targetDow of luxonDays) {
    if (targetDow > currentLuxonDow) {
      return baseDt
        .plus({ days: targetDow - currentLuxonDow })
        .set({ hour, minute, second: 0, millisecond: 0 });
    }
  }

  // Wrap to next week - use first matching day
  const firstDow = luxonDays[0];
  if (firstDow === undefined) {
    return baseDt.set({ hour, minute, second: 0, millisecond: 0 });
  }
  const daysToAdd = 7 - currentLuxonDow + firstDow;
  return baseDt.plus({ days: daysToAdd }).set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * Resolve monthly recurrence with constraint (e.g., "weekend after 10th").
 */
function resolveConstrainedMonthly(
  baseDt: DateTime,
  anchorDay: number,
  constraint: DateConstraint,
  hour: number,
  minute: number
): DateTime {
  let targetMonth = baseDt.month;
  let targetYear = baseDt.year;

  // Helper to create anchor with clamped day
  const createAnchor = (year: number, month: number): DateTime => {
    const tempDt = DateTime.fromObject({ year, month, day: 1 }, { zone: baseDt.zone });
    const daysInMonth = tempDt.daysInMonth ?? 28;
    const clampedDay = Math.min(anchorDay, daysInMonth);
    return DateTime.fromObject(
      { year, month, day: clampedDay, hour, minute, second: 0 },
      { zone: baseDt.zone }
    );
  };

  // Start from anchorDay of current month (clamped to valid range)
  let anchor = createAnchor(targetYear, targetMonth);

  // Apply constraint to find the target date
  let result = applyConstraint(anchor, constraint);

  // If the result is in the past, move to next month
  if (result <= baseDt) {
    targetMonth += 1;
    if (targetMonth > 12) {
      targetYear += 1;
      targetMonth = 1;
    }
    anchor = createAnchor(targetYear, targetMonth);
    result = applyConstraint(anchor, constraint);
  }

  return result;
}

/**
 * Apply a constraint to find the target date from an anchor.
 * Ported from harmonytech/src/lib/date-resolver.ts
 */
function applyConstraint(anchor: DateTime, constraint: DateConstraint): DateTime {
  // Luxon weekday: 1=Monday, 7=Sunday
  const dayOfWeek = anchor.weekday;

  switch (constraint) {
    case 'next-weekend': {
      // Find first Saturday (weekday 6) on or after anchor
      let daysUntilSaturday: number;
      if (dayOfWeek === 6) {
        daysUntilSaturday = 0; // Already Saturday
      } else if (dayOfWeek === 7) {
        daysUntilSaturday = 6; // Sunday -> next Saturday
      } else {
        daysUntilSaturday = 6 - dayOfWeek;
      }
      return anchor.plus({ days: daysUntilSaturday });
    }

    case 'next-saturday': {
      let daysUntilSaturday: number;
      if (dayOfWeek === 6) {
        daysUntilSaturday = 0;
      } else if (dayOfWeek === 7) {
        daysUntilSaturday = 6;
      } else {
        daysUntilSaturday = 6 - dayOfWeek;
      }
      return anchor.plus({ days: daysUntilSaturday });
    }

    case 'next-sunday': {
      // Find first Sunday (weekday 7) on or after anchor
      let daysUntilSunday: number;
      if (dayOfWeek === 7) {
        daysUntilSunday = 0; // Already Sunday
      } else {
        daysUntilSunday = 7 - dayOfWeek;
      }
      return anchor.plus({ days: daysUntilSunday });
    }

    case 'next-weekday': {
      // Find first weekday (Mon-Fri, weekdays 1-5) on or after anchor
      let daysUntilWeekday: number;
      if (dayOfWeek <= 5) {
        daysUntilWeekday = 0; // Already a weekday
      } else if (dayOfWeek === 6) {
        daysUntilWeekday = 2; // Saturday -> Monday
      } else {
        daysUntilWeekday = 1; // Sunday -> Monday
      }
      return anchor.plus({ days: daysUntilWeekday });
    }

    default:
      return anchor;
  }
}

/**
 * Format a recurrence spec for human display.
 */
export function formatRecurrence(recurrence: RecurrenceSpec): string {
  const interval = recurrence.interval;
  const intervalStr = interval > 1 ? `every ${String(interval)} ` : 'every ';

  switch (recurrence.frequency) {
    case 'daily':
      return interval === 1 ? 'daily' : `every ${String(interval)} days`;

    case 'weekly':
      if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = recurrence.daysOfWeek.map((d) => dayNames[d]).join(', ');
        return interval === 1 ? `weekly on ${days}` : `every ${String(interval)} weeks on ${days}`;
      }
      return interval === 1 ? 'weekly' : `every ${String(interval)} weeks`;

    case 'monthly':
      if (recurrence.anchorDay !== undefined && recurrence.constraint) {
        const anchorStr = getOrdinal(recurrence.anchorDay);
        const constraintStr = formatConstraint(recurrence.constraint);
        return interval === 1
          ? `monthly, ${constraintStr} after the ${anchorStr}`
          : `every ${String(interval)} months, ${constraintStr} after the ${anchorStr}`;
      }
      if (recurrence.dayOfMonth !== undefined) {
        const dayStr = getOrdinal(recurrence.dayOfMonth);
        return interval === 1
          ? `monthly on the ${dayStr}`
          : `every ${String(interval)} months on the ${dayStr}`;
      }
      return interval === 1 ? 'monthly' : `every ${String(interval)} months`;

    case 'custom':
      return `${intervalStr}custom`;

    default:
      return intervalStr + String(recurrence.frequency);
  }
}

/**
 * Get ordinal suffix for a number (1st, 2nd, 3rd, etc.).
 */
function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  const suffix = s[(v - 20) % 10] ?? s[v] ?? s[0] ?? 'th';
  return String(n) + suffix;
}

/**
 * Format a constraint for human display.
 */
function formatConstraint(constraint: string): string {
  switch (constraint) {
    case 'next-weekend':
      return 'first weekend';
    case 'next-saturday':
      return 'first Saturday';
    case 'next-sunday':
      return 'first Sunday';
    case 'next-weekday':
      return 'first weekday';
    default:
      return constraint;
  }
}
