/** Collector-owned, aligned throttle counters (ADR-016 N5). */
import type { LogsRecord, LogsStore } from './logs-store-adapter.js';

const WINDOW_MS = 6_000;
// One extra row detects truncation; truncated data cannot prove any pair complete.
const MAX_COUNTERS = 20_000;

export interface LogsThrottleWindow {
  readonly pod: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly discarded: number | null;
}

export interface LogsThrottle {
  readonly state: 'ok' | 'unknown';
  readonly windows: readonly LogsThrottleWindow[];
}

function count(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function aligned(value: string | undefined): number | null {
  if (value === undefined || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value))
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time % WINDOW_MS === 0 ? time : null;
}

/** Never read counters from message text or from a normalized pod record. */
export function pairThrottleWindows(records: readonly LogsRecord[]): LogsThrottleWindow[] {
  const groups = new Map<
    string,
    {
      pod: string;
      start: string | null;
      end: string | null;
      input: number[];
      accepted: number[];
      invalid: boolean;
    }
  >();
  for (const record of records) {
    const f = record.fields;
    if (
      f['module'] !== 'throttle-window' ||
      f['namespace'] !== 'lifemodel-motor' ||
      f['untrusted'] !== undefined ||
      !f['pod']
    )
      continue;
    const start = aligned(f['window_start']);
    const end = aligned(f['window_end']);
    const validWindow = start !== null && end !== null && end - start === WINDOW_MS;
    const key = JSON.stringify([f['pod'], start ?? f['window_start'], end ?? f['window_end']]);
    const group = groups.get(key) ?? {
      pod: f['pod'],
      start: validWindow ? new Date(start).toISOString() : null,
      end: validWindow ? new Date(end).toISOString() : null,
      input: [],
      accepted: [],
      invalid: false,
    };
    const value = count(f['value']);
    const counter = f['counter'];
    if (!validWindow || value === null || (counter !== 'input' && counter !== 'accepted'))
      group.invalid = true;
    else group[counter].push(value);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const input = group.input[0];
    const accepted = group.accepted[0];
    const known =
      !group.invalid &&
      group.input.length === 1 &&
      group.accepted.length === 1 &&
      input !== undefined &&
      accepted !== undefined &&
      accepted <= input;
    return {
      pod: group.pod,
      start: group.start,
      end: group.end,
      discarded: known ? input - accepted : null,
    };
  });
}

/** Independent of text/level/module filters: those fields do not exist on counters. */
export async function readLogsThrottle(
  store: Pick<LogsStore, 'query'>,
  window: { from: number; to: number },
  pageRecords: readonly LogsRecord[]
): Promise<LogsThrottle> {
  const query = `_time:[${new Date(window.from).toISOString()}, ${new Date(window.to).toISOString()}] module:="throttle-window" namespace:="lifemodel-motor" NOT untrusted:* | limit ${String(MAX_COUNTERS + 1)}`;
  const result = await store.query(query);
  const complete = result.state === 'ok' && result.records.length <= MAX_COUNTERS;
  const windows =
    result.state === 'ok'
      ? pairThrottleWindows(result.records.slice(0, MAX_COUNTERS)).map((entry) =>
          complete ? entry : { ...entry, discarded: null }
        )
      : [];
  const pods = new Set(windows.map((entry) => entry.pod));
  for (const record of pageRecords) {
    const pod = record.fields['pod'];
    if (record.fields['namespace'] === 'lifemodel-motor' && pod && !pods.has(pod)) {
      windows.push({ pod, start: null, end: null, discarded: null });
      pods.add(pod);
    }
  }
  return { state: complete && windows.length > 0 ? 'ok' : 'unknown', windows };
}
