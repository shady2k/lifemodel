/**
 * JSON-safe encoding for Date values in payloads stored through JSONStorage.
 *
 * JSON.stringify turns Date objects into plain ISO strings; a value restored
 * from such a file is a string, not a Date, and code holding an object shape
 * breaks quietly. Dates are therefore encoded as single-key tagged objects
 * before they reach storage and decoded back after load. Used by everything
 * that persists Signal-shaped payloads (the pending-signal journal, the
 * durable inbound log).
 */

/** The single-key tag object a Date is encoded into. */
export const DATE_TAG = '__date';

export function encodeDates(value: unknown): unknown {
  if (value instanceof Date) {
    return { [DATE_TAG]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeDates);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = encodeDates(v);
    }
    return out;
  }
  return value;
}

function isDateTagged(value: unknown): value is { __date: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    DATE_TAG in value &&
    typeof (value as Record<string, unknown>)[DATE_TAG] === 'string'
  );
}

export function decodeDates(value: unknown): unknown {
  if (isDateTagged(value)) {
    return new Date(value[DATE_TAG]);
  }
  if (Array.isArray(value)) {
    return value.map(decodeDates);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = decodeDates(v);
    }
    return out;
  }
  return value;
}
