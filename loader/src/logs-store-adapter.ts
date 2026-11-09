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

/**
 * The collector's heartbeat (ADR-016 §4): one record every 30 s, stored by the
 * collector's own process, and a second copy of it read back from the
 * collector pod's log file. The first says the collector and the store's write
 * path answer; the second says this node's pod-log files are still being read.
 * Either may be absent, and absent is not the same as old.
 */
export interface LogsHeartbeats {
  readonly state: 'ok';
  /** The newest `_time` of the collector's own heartbeat record. */
  readonly process: string | null;
  /** The newest `_time` of the copy read back through the pod's log file. */
  readonly podLog: string | null;
}

export type LogsHeartbeatsResult = LogsHeartbeats | LogsUnavailable;

/** The store's `vl_storage_is_read_only` gauge: true when writes are refused. */
export type LogsReadOnlyResult =
  | { readonly state: 'ok'; readonly readOnly: boolean }
  | LogsUnavailable;

/** One line the evictor wrote about a run that dropped a day or failed. */
export interface LogsEviction {
  readonly time: string;
  /** The removed day as `YYYYMMDD`, or null when the line removed nothing. */
  readonly day: string | null;
  readonly freedBytes: number | null;
  readonly reason: string | null;
  readonly message: string;
}

export type LogsEvictionsResult =
  | { readonly state: 'ok'; readonly evictions: readonly LogsEviction[] }
  | LogsUnavailable;

/** The window's record count, read with one query (ADR-016 §4). */
export type LogsCountResult = { readonly state: 'ok'; readonly count: number } | LogsUnavailable;

export interface LogsStore {
  query(logsql: string): Promise<LogsStoreResult>;
  count(logsql: string): Promise<LogsCountResult>;
  modules(): Promise<LogsModulesResult>;
  heartbeats(): Promise<LogsHeartbeatsResult>;
  readOnly(): Promise<LogsReadOnlyResult>;
  evictions(): Promise<LogsEvictionsResult>;
}

export interface LogsStoreOptions {
  /** The store's HTTP base, without the query path. */
  readonly url: string;
  readonly timeoutMs?: number;
  /** Milliseconds since the epoch, for the module cache. */
  readonly now?: () => number;
}

const QUERY_PATH = 'select/logsql/query';
const METRICS_PATH = 'metrics';
const MODULES_QUERY = '* | stats by (module) count()';
/** The field the store's `count()` aggregation writes its answer into. */
const COUNT_FIELD = 'count(*)';
/**
 * The heartbeat record's module, and the two containers that write one: the
 * collector's own heartbeat and the copy of it the collector reads back from
 * its own pod's log file (ADR-016 §4). The queries are fixed text, not built
 * from a request.
 */
const HEARTBEAT_MODULE = 'collector-heartbeat';
const HEARTBEAT_PROCESS_CONTAINER = 'collector-heartbeat';
const HEARTBEAT_POD_LOG_CONTAINER = 'logs-collector';
const HEARTBEAT_PROCESS_QUERY = `module:="${HEARTBEAT_MODULE}" container:="${HEARTBEAT_PROCESS_CONTAINER}" | sort by (_time desc) | limit 1`;
const HEARTBEAT_POD_LOG_QUERY = `module:="${HEARTBEAT_MODULE}" container:="${HEARTBEAT_POD_LOG_CONTAINER}" | sort by (_time desc) | limit 1`;
/** The evictor's own lines, newest first (ADR-016 §5); one per run that acted. */
const EVICTOR_MODULE = 'logs-evictor';
const EVICTIONS_LIMIT = 50;
const EVICTIONS_QUERY = `module:="${EVICTOR_MODULE}" | sort by (_time desc) | limit ${String(EVICTIONS_LIMIT)}`;
/** The store's read-only gauge: `1` while it refuses writes (ADR-016 §5). */
const READ_ONLY_GAUGE = 'vl_storage_is_read_only';
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

/** The store's read-only gauge value, or null when the body carries none. */
function parseReadOnly(body: string): boolean | null {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    // A sample line is `name{labels} value`, with an optional timestamp after
    // the value; only the value decides the gauge.
    const [sample, value] = line.split(/\s+/);
    if (sample === undefined || value === undefined) continue;
    if (sample.split('{')[0] !== READ_ONLY_GAUGE) continue;
    if (value === '0') return false;
    if (value === '1') return true;
    return null;
  }
  return null;
}

/** One evictor line: the drop's day and bytes when it names them. */
function parseEviction(record: LogsRecord): LogsEviction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.message);
  } catch {
    parsed = null;
  }
  const object =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const day = object['day'];
  const freedBytes = object['freedBytes'];
  const reason = object['reason'];
  return {
    time: record.time,
    day: typeof day === 'string' && /^\d{8}$/.test(day) ? day : null,
    freedBytes: typeof freedBytes === 'number' && Number.isFinite(freedBytes) ? freedBytes : null,
    reason: typeof reason === 'string' ? reason : null,
    message: record.message,
  };
}

export function createLogsStore(options: LogsStoreOptions): LogsStore {
  const base = options.url.endsWith('/') ? options.url : `${options.url}/`;
  const endpoint = new URL(QUERY_PATH, base);
  const metricsEndpoint = new URL(METRICS_PATH, base);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; modules: string[] } | null = null;

  async function send(
    target: URL,
    init: RequestInit = {}
  ): Promise<{ state: 'ok'; body: string } | LogsUnavailable> {
    try {
      const response = await fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 429)
        return { state: 'unavailable', reason: 'read_only', status: 429 };
      if (!response.ok)
        return { state: 'unavailable', reason: 'http_error', status: response.status };
      return { state: 'ok', body: await response.text() };
    } catch (error) {
      return { state: 'unavailable', reason: failureReason(error) };
    }
  }

  function request(logsql: string): Promise<{ state: 'ok'; body: string } | LogsUnavailable> {
    return send(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: logsql }).toString(),
    });
  }

  /** The newest record's `_time`; null when the store holds none. */
  async function newest(
    logsql: string
  ): Promise<{ state: 'ok'; time: string | null } | LogsUnavailable> {
    const answer = await request(logsql);
    if (answer.state !== 'ok') return answer;
    const records = parseRecords(answer.body);
    if (records === null) return { state: 'unavailable', reason: 'invalid_response' };
    return { state: 'ok', time: records[0]?.time ?? null };
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
    async heartbeats() {
      const process = await newest(HEARTBEAT_PROCESS_QUERY);
      if (process.state !== 'ok') return process;
      const podLog = await newest(HEARTBEAT_POD_LOG_QUERY);
      if (podLog.state !== 'ok') return podLog;
      return { state: 'ok', process: process.time, podLog: podLog.time };
    },
    async readOnly() {
      const answer = await send(metricsEndpoint, { method: 'GET' });
      if (answer.state !== 'ok') return answer;
      const readOnly = parseReadOnly(answer.body);
      if (readOnly === null) return { state: 'unavailable', reason: 'invalid_response' };
      return { state: 'ok', readOnly };
    },
    async evictions() {
      const answer = await request(EVICTIONS_QUERY);
      if (answer.state !== 'ok') return answer;
      const records = parseRecords(answer.body);
      if (records === null) return { state: 'unavailable', reason: 'invalid_response' };
      return { state: 'ok', evictions: records.map(parseEviction) };
    },
  };
}
