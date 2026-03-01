/**
 * Date utility functions.
 *
 * Shared helpers for date handling across the codebase.
 */

/**
 * Check if a string looks like an ISO 8601 date.
 *
 * Matches: YYYY-MM-DDTHH:mm:ss (with optional milliseconds and timezone)
 * Examples: 2024-01-15T10:30:00.000Z, 2024-01-15T10:30:00
 */
export function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

/**
 * List of common date field names used in JSON serialization.
 *
 * Used by JSON.parse revivers to know which fields should be
 * converted from ISO strings back to Date objects.
 */
export const DATE_FIELD_NAMES = [
  'createdAt',
  'lastModifiedAt',
  'lastUpdatedAt',
  'lastAmendedAt',
  'lastReviewedAt',
  'crystallizedAt',
  'resolvedAt',
  'completedAt',
  'timestamp',
  'contestedSince',
  'refreshAt',
  'resetAt',
  'lastMismatchCheckAt',
  'lastReflectionAt', // Renamed from lastMismatchCheckAt in Phase 1.5
  'lastAuditAt',
  'lastSavedAt',
  'lastPeriodicCheck',
  'lastTickAt',
  'lastMentioned',
  'lastSignalAt',
  'updatedAt',
  'start',
  'end',
  // Soft learning fields (Phase 3.5)
  'lastTouchedAt',
  'expiresAt',
  // Parliament deliberation (Phase 4)
  'lastDeliberationAt',
  // Ack registry persistence
  'deferUntil',
  // Batch reflection (soul provider)
  'batchWindowStartAt',
  'startedAt',
] as const;

/**
 * Create a JSON.parse reviver function that converts date fields.
 *
 * @param additionalFields Additional field names to treat as dates
 * @returns A reviver function for JSON.parse
 */
export function createDateReviver(
  additionalFields: readonly string[] = []
): (key: string, value: unknown) => unknown {
  const dateFields = new Set([...DATE_FIELD_NAMES, ...additionalFields]);

  return (key: string, value: unknown): unknown => {
    if (typeof value === 'string' && dateFields.has(key) && isIsoDateString(value)) {
      return new Date(value);
    }
    return value;
  };
}

/**
 * JSON.stringify replacer that converts Date objects to ISO strings.
 *
 * Usage: JSON.stringify(data, dateReplacer)
 */
export function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/**
 * Serialize an object to JSON with Date handling.
 *
 * Dates are converted to ISO strings.
 */
export function serializeWithDates(data: unknown): string {
  return JSON.stringify(data, dateReplacer);
}

/**
 * Parse JSON with automatic Date field restoration.
 *
 * Fields matching DATE_FIELD_NAMES are converted to Date objects.
 *
 * @param json The JSON string to parse
 * @param additionalFields Additional field names to treat as dates
 */
export function parseWithDates(json: string, additionalFields: readonly string[] = []): unknown {
  return JSON.parse(json, createDateReviver(additionalFields));
}

/**
 * Resolve the effective IANA timezone from user model data.
 *
 * Priority:
 * 1. Explicit IANA timezone string (e.g., "Europe/Moscow")
 * 2. Derived from numeric offset (Etc/GMT signs are inverted: +3 → Etc/GMT-3)
 * 3. Fallback default
 *
 * @param userTimezone IANA timezone string from user model
 * @param timezoneOffset Numeric UTC offset (hours) from user model
 * @param fallback Default timezone if neither is available
 */
export function getEffectiveTimezone(
  userTimezone?: string,
  timezoneOffset?: number | null,
  fallback = 'Europe/Moscow'
): string {
  if (userTimezone) return userTimezone;

  if (timezoneOffset != null) {
    const invertedOffset = -timezoneOffset;
    const sign = invertedOffset >= 0 ? '+' : '';
    return `Etc/GMT${sign}${String(invertedOffset)}`;
  }

  return fallback;
}

/**
 * Format a timestamp as human-readable relative time.
 *
 * Today: relative ("just now", "6 min ago", "3h ago")
 * Yesterday: "yesterday 23:55"
 * Older: "Feb 4, 14:30"
 *
 * Used by conversation history, news results, and anywhere the LLM
 * needs to understand when something happened without date arithmetic.
 *
 * @param ts Timestamp to format
 * @param now Reference "now" timestamp
 * @param timezone IANA timezone for formatting
 */
export function formatRelativeTime(ts: Date, now: Date, timezone: string): string {
  const msgDate = ts.toLocaleDateString('en-GB', { timeZone: timezone });
  const todayDate = now.toLocaleDateString('en-GB', { timeZone: timezone });
  const yesterdayDate = new Date(now.getTime() - 86400000).toLocaleDateString('en-GB', {
    timeZone: timezone,
  });

  if (msgDate === todayDate) {
    // Same day — use relative time (no arithmetic needed by the LLM)
    const diffMs = now.getTime() - ts.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMin / 60);
    const remainMin = diffMin % 60;

    if (diffMin < 1) {
      return 'just now';
    } else if (diffMin < 60) {
      return `${String(diffMin)} min ago`;
    } else if (remainMin > 0) {
      return `${String(diffHours)}h ${String(remainMin)}m ago`;
    } else {
      return `${String(diffHours)}h ago`;
    }
  } else if (msgDate === yesterdayDate) {
    const timeStr = ts.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    });
    return `yesterday ${timeStr}`;
  } else {
    const timeStr = ts.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    });
    const dateStr = ts.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: timezone,
    });
    return `${dateStr}, ${timeStr}`;
  }
}

/**
 * Format a timestamp as a conversation message prefix with XML tags.
 *
 * Wraps formatRelativeTime in `<msg_time>` tags for conversation history.
 *
 * @param ts Message timestamp
 * @param now Reference "now" timestamp
 * @param timezone IANA timezone for formatting
 */
export function formatTimestampPrefix(ts: Date, now: Date, timezone: string): string {
  return `<msg_time>${formatRelativeTime(ts, now, timezone)}</msg_time>`;
}

/**
 * Check if a given hour falls within a sleep window.
 * Handles midnight wrap (e.g., sleepHour=23, wakeHour=7).
 */
export function isWithinSleepWindow(
  currentHour: number,
  sleepHour: number,
  wakeHour: number
): boolean {
  if (sleepHour === wakeHour) return false; // 0-width window = never sleeping
  if (sleepHour > wakeHour) {
    // Wraps midnight: e.g., 23→7 means 23,0,1,2,3,4,5,6 are sleep
    return currentHour >= sleepHour || currentHour < wakeHour;
  }
  // No wrap: e.g., 2→10 means 2,3,4,5,6,7,8,9 are sleep
  return currentHour >= sleepHour && currentHour < wakeHour;
}

/**
 * Calculate the midpoint hour of a sleep window.
 * Used for daily maintenance scheduling and food-day boundaries.
 *
 * Example: sleepHour=23, wakeHour=7 → midpoint=3
 */
export function calculateSleepMidpointHour(sleepHour: number, wakeHour: number): number {
  if (sleepHour < wakeHour) {
    return Math.floor((sleepHour + wakeHour) / 2);
  }
  const wakeNormalized = wakeHour + 24;
  const midpoint = (sleepHour + wakeNormalized) / 2;
  return Math.floor(midpoint % 24);
}
