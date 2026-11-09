/**
 * The log store's HTTP protocol, in one file (ADR-016 §3, §4).
 *
 * This is the only place that speaks the store's read protocol: the query
 * endpoint, the form-encoded `query` argument, the JSON-lines response and the
 * record's `_time` and `_msg` fields. Everything else in the loader sees a
 * store with `query` and `modules`. A replacement store implements the same
 * operations and nothing above this file changes.
 *
 * Unavailable is an answer, never an empty list: a refused connection, a
 * timeout, a 5xx, a read-only 429 or an unreadable body returns a reason.
 */
export type LogsUnavailableReason =
  | 'timeout'
  | 'connection_refused'
  | 'unreachable'
  | 'read_only'
  | 'http_error'
  | 'invalid_response';

export interface LogsUnavailable {
  readonly state: 'unavailable';
  readonly reason: LogsUnavailableReason;
  readonly status?: number;
}

/** One stored line: its event time, its message and its fields. */
export interface LogsRecord {
  readonly time: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, string>>;
}

export type LogsStoreResult =
  | { readonly state: 'ok'; readonly records: readonly LogsRecord[] }
  | LogsUnavailable;

export type LogsModulesResult =
  | { readonly state: 'ok'; readonly modules: readonly string[] }
  | LogsUnavailable;

/** The window's record count, read with one query (ADR-016 §4). */
export type LogsCountResult = { readonly state: 'ok'; readonly count: number } | LogsUnavailable;

export interface LogsStore {
  query(logsql: string): Promise<LogsStoreResult>;
  count(logsql: string): Promise<LogsCountResult>;
  modules(): Promise<LogsModulesResult>;
}

export interface LogsStoreOptions {
  /** The store's HTTP base, without the query path. */
  readonly url: string;
  readonly timeoutMs?: number;
  /** Milliseconds since the epoch, for the module cache. */
  readonly now?: () => number;
}

const QUERY_PATH = 'select/logsql/query';
const MODULES_QUERY = '* | stats by (module) count()';
/** The field the store's `count()` aggregation writes its answer into. */
const COUNT_FIELD = 'count(*)';
const MODULES_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function failureReason(error: unknown): LogsUnavailableReason {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return 'timeout';
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (cause?.code === 'ECONNREFUSED') return 'connection_refused';
  return 'unreachable';
}

function parseRecords(body: string): LogsRecord[] | null {
  const records: LogsRecord[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const object = value as Record<string, unknown>;
    const time = object['_time'];
    const message = object['_msg'];
    if (typeof time !== 'string' || typeof message !== 'string') return null;
    const fields: Record<string, string> = {};
    for (const [key, field] of Object.entries(object)) {
      if (key.startsWith('_')) continue;
      if (typeof field === 'string') fields[key] = field;
      else if (typeof field === 'number' || typeof field === 'boolean') fields[key] = String(field);
    }
    records.push({ time, message, fields });
  }
  return records;
}

/** The store answers a count with one JSON line holding `count(*)`. */
function parseCount(body: string): number | null {
  const lines = body.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(lines[0] ?? '');
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[COUNT_FIELD];
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function parseModules(body: string): string[] | null {
  const modules = new Set<string>();
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const module = (value as Record<string, unknown>)['module'];
    if (typeof module === 'string' && module !== '') modules.add(module);
  }
  return [...modules].sort();
}

export function createLogsStore(options: LogsStoreOptions): LogsStore {
  const endpoint = new URL(QUERY_PATH, options.url.endsWith('/') ? options.url : `${options.url}/`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; modules: string[] } | null = null;

  async function request(logsql: string): Promise<{ state: 'ok'; body: string } | LogsUnavailable> {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query: logsql }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429)
        return { state: 'unavailable', reason: 'read_only', status: 429 };
      if (!response.ok)
        return { state: 'unavailable', reason: 'http_error', status: response.status };
      return { state: 'ok', body: await response.text() };
    } catch (error) {
      return { state: 'unavailable', reason: failureReason(error) };
    }
  }

  return {
    async query(logsql) {
      const answer = await request(logsql);
      if (answer.state !== 'ok') return answer;
      const records = parseRecords(answer.body);
      if (records === null) return { state: 'unavailable', reason: 'invalid_response' };
      return { state: 'ok', records };
    },
    async count(logsql) {
      const answer = await request(logsql);
      if (answer.state !== 'ok') return answer;
      const count = parseCount(answer.body);
      if (count === null) return { state: 'unavailable', reason: 'invalid_response' };
      return { state: 'ok', count };
    },
    async modules() {
      const at = now();
      if (cached !== null && at - cached.at < MODULES_TTL_MS)
        return { state: 'ok', modules: cached.modules };
      const answer = await request(MODULES_QUERY);
      if (answer.state !== 'ok') return answer;
      const modules = parseModules(answer.body);
      if (modules === null) return { state: 'unavailable', reason: 'invalid_response' };
      cached = { at, modules };
      return { state: 'ok', modules };
    },
  };
}
