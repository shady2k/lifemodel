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
 * Format a timestamp as a human-readable prefix for conversation messages.
 *
 * Today's messages use relative time so the LLM doesn't need arithmetic:
 * - < 1 min: `[just now]`
 * - < 60 min: `[6 min ago]`
 * - Same day: `[3 hours ago]`
 * - Yesterday: `[yesterday 23:55]`
 * - Older: `[Feb 4, 14:30]`
 *
 * @param ts Message timestamp
 * @param now Reference "now" timestamp
 * @param timezone IANA timezone for formatting
 */
export function formatTimestampPrefix(ts: Date, now: Date, timezone: string): string {
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

    let relative: string;
    if (diffMin < 1) {
      relative = 'just now';
    } else if (diffMin < 60) {
      relative = `${String(diffMin)} min ago`;
    } else if (remainMin > 0) {
      relative = `${String(diffHours)}h ${String(remainMin)}m ago`;
    } else {
      relative = `${String(diffHours)}h ago`;
    }

    return `<msg_time>${relative}</msg_time>`;
  } else if (msgDate === yesterdayDate) {
    const timeStr = ts.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    });
    return `<msg_time>yesterday ${timeStr}</msg_time>`;
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
    return `<msg_time>${dateStr}, ${timeStr}</msg_time>`;
  }
}
