/**
 * The logs page's freshness, its store alarm and the evictor's notices
 * (ADR-016 §4, §5; check L14).
 *
 * Three independent answers, each of which may be unknown, and a page that says
 * "unknown" rather than a healthy or an empty one:
 *
 * - collection: the collector's heartbeat. The record the collector writes
 *   itself proves its process and the store's write path; the copy it reads
 *   back through its own pod's log file proves this node's pod-log files are
 *   still being read. The second is the stronger proof, so its age is the age
 *   the page shows; the first keeps a stopped collector from being blamed on
 *   the file source alone and keeps "no heartbeat at all" distinguishable from
 *   "heartbeats but no pod line ever".
 * - the store's `vl_storage_is_read_only` gauge: `the store is refusing writes
 *   (read-only)` whenever it is 1, whatever the cause.
 * - the evictor's CronJob: `the log evictor is failing or has not run` only
 *   once its last successful run is older than two of its minute intervals, so
 *   a refusal between runs never blames a working evictor.
 *
 * Nothing here builds a query or names a vendor field: the store's own names
 * live in `logs-store-adapter.ts`.
 */
import type { LogsEviction, LogsStore } from './logs-store-adapter.js';

/** ADR-016 §4: a heartbeat every 30 s, and the page warns past 90 s. */
export const COLLECTION_STOPPED_MS = 90_000;
/** ADR-016 §5: two evictor intervals, so one interval of refusal blames nobody. */
export const EVICTOR_STALE_MS = 120_000;

export interface LogsCollection {
  /**
   * `live` while a heartbeat proves collection; `stopped` when the proof is
   * missing or older than the threshold; `unknown` when no heartbeat was ever
   * stored, so the page never guesses health from an empty answer.
   */
  readonly state: 'live' | 'stopped' | 'unknown';
  /** How long the newest proof of collection has been silent, or null when unknown. */
  readonly stoppedForMs: number | null;
}

export interface LogsStatus {
  readonly collection: LogsCollection;
  /** The store's read-only gauge, or null when it could not be read. */
  readonly storeReadOnly: boolean | null;
  readonly evictor: {
    /** The CronJob's last successful run, or null when it has none. */
    readonly lastSuccessAt: string | null;
    /** True only when the staleness is known: a failed read is null, never true. */
    readonly stale: boolean | null;
  };
  /** Each evictor line whose removed day falls inside the page's window. */
  readonly evictions: readonly LogsEviction[];
}

/** The evictor's schedule, as the page needs it: when it last succeeded. */
export interface LogsEvictorStatus {
  lastSuccessAt(): Promise<string | null>;
}

export interface LogsStatusSources {
  readonly store: Pick<LogsStore, 'heartbeats' | 'readOnly' | 'evictions'>;
  readonly evictor: LogsEvictorStatus;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
}

/** The page's window, whose days bound the eviction notices it shows. */
export interface LogsStatusWindow {
  readonly from: number;
  readonly to: number;
}

export interface LogsStatusQuery {
  read(window: LogsStatusWindow): Promise<LogsStatus>;
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** The `YYYYMMDD` day of a millisecond time, as the store names partitions. */
export function logDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Collection health from the two heartbeats. The pod-log copy is the proof the
 * page trusts; the collector's own record is what an absent copy is measured
 * against, because a collector that has never delivered one has been up for at
 * least as long as its newest heartbeat is old.
 */
function collectionOf(process: string | null, podLog: string | null, now: number): LogsCollection {
  const podLogTime = parseTime(podLog);
  const processTime = parseTime(process);
  if (podLogTime === null && processTime === null) return { state: 'unknown', stoppedForMs: null };
  const proof = podLogTime ?? processTime;
  const stoppedForMs = Math.max(0, now - (proof ?? now));
  if (podLogTime === null || stoppedForMs > COLLECTION_STOPPED_MS)
    return { state: 'stopped', stoppedForMs };
  return { state: 'live', stoppedForMs: null };
}

export function createLogsStatus(sources: LogsStatusSources): LogsStatusQuery {
  return {
    async read(window) {
      const [heartbeats, readOnly, evictions, evictorRead] = await Promise.all([
        sources.store.heartbeats(),
        sources.store.readOnly(),
        sources.store.evictions(),
        sources.evictor.lastSuccessAt().then(
          (time) => ({ known: true, time }),
          () => ({ known: false, time: null })
        ),
      ]);
      const lastSuccess = evictorRead.time;
      const now = sources.now();
      const collection =
        heartbeats.state === 'ok'
          ? collectionOf(heartbeats.process, heartbeats.podLog, now)
          : { state: 'unknown' as const, stoppedForMs: null };
      const successAt = parseTime(lastSuccess);
      const fromDay = logDayOf(window.from);
      const toDay = logDayOf(window.to);
      const evictionList =
        evictions.state === 'ok'
          ? evictions.evictions.filter(
              (line) => line.day !== null && line.day >= fromDay && line.day <= toDay
            )
          : [];
      return {
        collection,
        storeReadOnly: readOnly.state === 'ok' ? readOnly.readOnly : null,
        evictor: {
          lastSuccessAt: lastSuccess,
          // A run that has never succeeded is stale; a read the loader was not
          // allowed to make is not evidence of anything.
          stale: evictorRead.known
            ? successAt === null || now - successAt > EVICTOR_STALE_MS
            : null,
        },
        evictions: evictionList,
      };
    },
  };
}
