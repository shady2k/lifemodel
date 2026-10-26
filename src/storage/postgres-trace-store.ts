import type { Pool, PoolClient } from 'pg';
import type { TraceRecord, TraceWriter } from '../ports/observability.js';

export interface TraceRetentionPolicy {
  maxAgeDays?: number | null;
  maxTraces?: number | null;
  /** Logical row bytes, not physical relation/WAL size. */
  maxBytes?: number | null;
}

export interface PostgresTraceStoreOptions {
  maxQueue?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  knownSecrets?: readonly string[];
  retention?: TraceRetentionPolicy;
  pruneEveryBatches?: number;
}

const REDACTED = '[REDACTED]';

// Match complete name parts, not ordinary words such as tokenizer or secretary.
function sensitiveTraceKey(key: string): boolean {
  return /(?:^|[_.-])(?:authorization|password|passwd|secret|token|api[_.-]?key|access[_.-]?key|credentials?)(?:$|[_.-])/i.test(
    key
  );
}

/** Redact assignments even inside quoted tool output or nested JSON serialization. */
function scrubTraceAssignments(input: string): string {
  // Consume whole names once, even when no assignment follows. Searching for a
  // sensitive suffix at each offset of a long name/backslash run is quadratic.
  const names = /[a-z0-9_.-]+/gi;
  const assignment = /(?:\\*["'])?\s*[=:]\s*/y;
  const quoted = /(\\*)(["'])/y;
  const unquoted = /[^\s,;"'}]+/y;
  // Scan each consumed value once. Quotes inside Digest parameters are content
  // unless they close the surrounding shell/serialized header delimiter.
  function endOfValue(start: number, quote?: string, depth = 0, header = false): number {
    let slashes = 0;
    for (let i = start; i < input.length; i++) {
      const char = input[i];
      if (header && (char === '\r' || char === '\n')) return i;
      if (
        quote &&
        char === quote &&
        slashes >= depth &&
        (slashes - depth) % (2 * (depth + 1)) === 0
      )
        return i - slashes;
      slashes = char === '\\' ? slashes + 1 : 0;
    }
    return input.length;
  }
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = names.exec(input)) !== null) {
    if (!sensitiveTraceKey(match[0])) continue;
    assignment.lastIndex = names.lastIndex;
    if (!assignment.exec(input)) continue;
    const start = assignment.lastIndex;
    const header = match[0].toLowerCase() === 'authorization';
    quoted.lastIndex = start;
    const opening = quoted.exec(input);
    let end = start;
    if (opening) {
      end = endOfValue(start + opening[0].length, opening[2], opening[1]?.length, header);
      output += input.slice(cursor, start) + opening[0] + '[REDACTED]';
    } else if (header) {
      // A whole curl -H 'Authorization: ...' header has its delimiter BEFORE
      // the key. Without a delimiter the HTTP value ends only at CR/LF or EOF,
      // never at a space/comma/quote belonging to an unknown scheme's value.
      const before = input[match.index - 1];
      let depth = 0;
      if (before === '"' || before === "'") {
        for (let i = match.index - 2; i >= cursor && input[i] === '\\'; i--) depth++;
      }
      end = endOfValue(start, before === '"' || before === "'" ? before : undefined, depth, true);
      output += input.slice(cursor, start) + '[REDACTED]';
    } else {
      unquoted.lastIndex = start;
      end = start + (unquoted.exec(input)?.[0].length ?? 0);
      output += input.slice(cursor, start) + '[REDACTED]';
    }
    cursor = end;
    names.lastIndex = Math.max(end, start + 1);
  }
  return output + input.slice(cursor);
}

/** Scrub before queueing, including nested bags and their keys. Returns a detached copy. */
export function scrubTraceRecord(
  record: TraceRecord,
  knownSecrets: readonly string[] = []
): TraceRecord {
  const secrets = knownSecrets.filter(Boolean).sort((a, b) => b.length - a.length);
  const text = (input: string): string => {
    let value = input;
    for (const secret of secrets) value = value.split(secret).join(REDACTED);
    return scrubTraceAssignments(value)
      .replace(/\bBearer\s+[^\s"'<>]+/gi, `Bearer ${REDACTED}`)
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
        REDACTED
      )
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  };
  let nodes = 0;
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) return '[TRUNCATED]';
    if (typeof value === 'string') return text(value).slice(0, 16384);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.slice(0, 256).map((item) => walk(item, depth + 1));
    if (typeof value !== 'object') return null;
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 256)
        .map(([key, item]) => [
          text(key),
          sensitiveTraceKey(key) ? REDACTED : walk(item, depth + 1),
        ])
    );
  };
  return walk(record, 0) as TraceRecord;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Raw, unfenced Pool: losing this evidence cannot change authoritative state. */
export class PostgresTraceStore implements TraceWriter {
  private readonly queue: TraceRecord[] = [];
  private readonly observedClients = new WeakSet<PoolClient>();
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly interval: number;
  private readonly pruneEvery: number;
  private readonly secrets: readonly string[];
  private readonly retention: TraceRetentionPolicy;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  private inFlight = 0;
  private batches = 0;
  private closed = false;
  private expired = false;
  private activeClient: PoolClient | undefined;
  private dropped = 0;

  constructor(
    private readonly pool: Pool,
    options: PostgresTraceStoreOptions = {}
  ) {
    this.maxQueue = positive(options.maxQueue, 10000);
    this.batchSize = Math.min(positive(options.batchSize, 128), this.maxQueue);
    this.interval = positive(options.flushIntervalMs, 200);
    this.pruneEvery = positive(options.pruneEveryBatches, 50);
    this.secrets = [...(options.knownSecrets ?? [])];
    this.retention = {
      maxAgeDays: 14,
      maxTraces: 5000,
      maxBytes: 256 * 1024 * 1024,
      ...options.retention,
    };
  }

  get droppedCount(): number {
    return this.dropped;
  }

  enqueue(record: TraceRecord): boolean {
    try {
      if (this.closed || this.queue.length + this.inFlight >= this.maxQueue) {
        this.dropped++;
        return false;
      }
      const clean = scrubTraceRecord(record, this.secrets);
      if (clean.kind === 'span') {
        const span = clean.span;
        if (!span.endedAt) span.status = null;
        else if (!['ok', 'failed', 'suppressed'].includes(span.status ?? ''))
          span.status = 'failed';
      }
      // Bounds memory as well as queue depth, and rejects cyclic/non-JSON input fail-open.
      if (Buffer.byteLength(JSON.stringify(clean)) > 65536) throw new Error('trace too large');
      this.queue.push(clean);
      this.schedule();
      return true;
    } catch {
      this.dropped++;
      return false;
    }
  }

  private schedule(): void {
    if (this.timer || this.writing || this.closed) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.flush();
      },
      this.queue.length >= this.batchSize ? 0 : this.interval
    );
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) {
      await this.writing;
      if (this.queue.length) await this.flush();
      return;
    }
    this.writing = this.drain();
    try {
      await this.writing;
    } finally {
      this.writing = undefined;
      if (this.queue.length) this.schedule();
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.batchSize);
      this.inFlight = batch.length;
      let client: PoolClient | undefined;
      try {
        client = await this.pool.connect();
        if (this.expired) {
          client.release(true);
          client = undefined;
          throw new Error('trace deadline');
        }
        this.activeClient = client;
        // pg removes its idle-client error listener while a client is checked
        // out. Socket failures between queries must not escape as unhandled
        // EventEmitter errors and terminate the authoritative core process.
        if (!this.observedClients.has(client)) {
          client.on('error', () => undefined);
          this.observedClients.add(client);
        }
        await client.query("SET client_connection_check_interval = '50ms'");
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '2s'");
        await client.query("SET LOCAL lock_timeout = '1s'");
        // Serializes retention with other disposable writers, not an active-holder fence.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('lifemodel-observability'))");
        for (const record of batch) {
          if (this.expired) throw new Error('trace deadline');
          await this.write(client, record);
        }
        if (this.expired) throw new Error('trace deadline');
        await client.query('COMMIT');
        // Persistence is settled even if disposable retention still owns SQL.
        this.inFlight = 0;
        this.batches++;
        if (this.batches === 1 || this.batches % this.pruneEvery === 0) {
          try {
            await client.query('BEGIN');
            await client.query("SET LOCAL statement_timeout = '2s'");
            await client.query("SET LOCAL lock_timeout = '1s'");
            await client.query("SELECT pg_advisory_xact_lock(hashtext('lifemodel-observability'))");
            await this.prune(client);
            await client.query('COMMIT');
          } catch {
            try {
              await client.query('ROLLBACK');
            } catch {
              /* pruning is disposable too */
            }
          }
        }
      } catch {
        if (!this.expired) this.dropped += batch.length;
        // A held rollback must not count this already-settled failure twice.
        this.inFlight = 0;
        if (client && !this.expired) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* disposable */
          }
        }
      } finally {
        try {
          if (client && this.activeClient === client) {
            this.activeClient = undefined;
            client.release();
          }
        } catch {
          /* never fail the caller on cleanup */
        }
        this.inFlight = 0;
      }
    }
  }

  private async write(client: PoolClient, record: TraceRecord): Promise<void> {
    if (record.kind === 'span') {
      const s = record.span;
      await client.query(
        `INSERT INTO observability.trace_spans
        (trace_id,span_id,parent_span_id,component,started_at,ended_at,status,attrs)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (trace_id,span_id) DO UPDATE SET
          ended_at=COALESCE(EXCLUDED.ended_at,trace_spans.ended_at),
          status=COALESCE(EXCLUDED.status,trace_spans.status),
          attrs=trace_spans.attrs || EXCLUDED.attrs`,
        [
          s.traceId,
          s.spanId,
          s.parentSpanId,
          s.component,
          s.startedAt,
          s.endedAt,
          s.status,
          s.attrs,
        ]
      );
    } else {
      const e = record.event;
      await client.query(
        `INSERT INTO observability.trace_events
        (record_id,trace_id,span_id,event,ts,fields) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (record_id) DO NOTHING`,
        [e.recordId, e.traceId, e.spanId, e.event, e.ts, e.fields]
      );
    }
  }

  private async prune(client: PoolClient): Promise<void> {
    const result = await client.query<{
      trace_id: string;
      closed: boolean;
      ended_at: Date | null;
      bytes: string;
    }>(`SELECT trace_id, bool_and(closed) AS closed, max(ended_at) AS ended_at,
        sum(bytes)::text AS bytes FROM (
      SELECT s.trace_id, s.ended_at IS NOT NULL AND s.status IS NOT NULL AS closed,
        s.ended_at, pg_column_size(s)::bigint AS bytes FROM observability.trace_spans s
      UNION ALL
      SELECT e.trace_id, true, NULL::timestamptz, pg_column_size(e)::bigint
        FROM observability.trace_events e
      ) records GROUP BY trace_id ORDER BY max(ended_at) ASC NULLS LAST, trace_id`);
    let count = result.rows.length;
    let bytes = result.rows.reduce((n, row) => n + Number(row.bytes), 0);
    const { maxAgeDays, maxTraces, maxBytes } = this.retention;
    const cutoff = maxAgeDays == null ? -Infinity : Date.now() - maxAgeDays * 86400000;
    const ids: string[] = [];
    for (const row of result.rows) {
      // Events-only traces and ANY open span are protected, even if over budget.
      if (!row.closed || !row.ended_at) continue;
      if (
        row.ended_at.getTime() < cutoff ||
        (maxTraces != null && count > maxTraces) ||
        (maxBytes != null && bytes > maxBytes)
      ) {
        ids.push(row.trace_id);
        count--;
        bytes -= Number(row.bytes);
      }
    }
    if (ids.length) {
      await client.query('DELETE FROM observability.trace_events WHERE trace_id=ANY($1::text[])', [
        ids,
      ]);
      await client.query('DELETE FROM observability.trace_spans WHERE trace_id=ANY($1::text[])', [
        ids,
      ]);
    }
  }

  async close(deadlineMs?: number, signal?: AbortSignal): Promise<void> {
    this.closed = true;
    const drained = this.flush();
    if (deadlineMs === undefined && !signal) {
      await drained;
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        drained,
        new Promise<void>((resolve) => {
          onAbort = resolve;
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', onAbort, { once: true });
          if (deadlineMs !== undefined)
            timeout = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    // Cancel only our checked-out socket. No state/owner client belongs here.
    // A late connect also checks expired and destroys its own client.
    this.expired = true;
    this.dropped += this.queue.length + this.inFlight;
    this.queue.length = 0;
    this.inFlight = 0;
    const client = this.activeClient;
    this.activeClient = undefined;
    try {
      client?.release(true);
    } catch {
      /* disposable cleanup must not delay state cleanup */
    }
  }
}

export function createPostgresTraceStore(
  options: PostgresTraceStoreOptions & { pool: Pool }
): PostgresTraceStore {
  return new PostgresTraceStore(options.pool, options);
}
