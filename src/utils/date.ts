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
