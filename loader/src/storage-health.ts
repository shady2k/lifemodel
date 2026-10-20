/**
 * The storage module's health logic (ADR-015 S-D7).
 *
 * Readiness answers one question: does SeaweedFS answer with valid auth right
 * now? A failed store is `down` with its own reason - unreachable, refused,
 * missing bucket, no credentials, or a check that passed its deadline - and is
 * never reported as an empty store. Liveness answers a different one: is this
 * process alive.
 *
 * A check that misses its deadline is an unhealthy outcome of that evaluation,
 * not a reason to repeat the last good answer: the check is cancelled, its
 * eventual result is discarded, and the caller gets a 503 with `timeout`.
 */
import type { LoaderLogger } from './logger.js';
import type { S3CheckFailure } from './storage-s3.js';

export type StorageFailureCode = S3CheckFailure | 'credentials_unavailable' | 'timeout';
export type StoreCheck = { ok: true } | { ok: false; code: StorageFailureCode };

export interface StorageHealthBody {
  state: 'unknown' | 'ok' | 'down';
  store: 'seaweedfs';
  bucket: string;
  lastErrorCode: StorageFailureCode | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  outageSeconds: number | null;
}

export interface StorageHealthOptions {
  bucket: string;
  /** The store check. The signal ends work its deadline has already answered. */
  check(signal: AbortSignal): Promise<StoreCheck>;
  logger: LoaderLogger;
  now?: () => number;
  /** How long one answer stands before a new check; tests set it to zero. */
  cacheMs?: number;
  /**
   * How long an evaluation waits for its check. It must stay below the
   * Kubernetes readiness probe's `timeoutSeconds`, so the probe always gets an
   * answer (deploy/platform/a/storage-module.yaml).
   */
  boundMs?: number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

export interface StorageHealth {
  body(): StorageHealthBody;
  evaluate(): Promise<{ status: number; body: StorageHealthBody }>;
}

/** The module's bounds; the manifest's probe timeout is checked against this. */
export const STORAGE_HEALTH_DEFAULTS = { cacheMs: 2_000, boundMs: 3_000 } as const;

export function createStorageHealth(options: StorageHealthOptions): StorageHealth {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? STORAGE_HEALTH_DEFAULTS.cacheMs;
  const boundMs = options.boundMs ?? STORAGE_HEALTH_DEFAULTS.boundMs;
  const { set: schedule, clear: cancel } = options.timers ?? {
    set: setTimeout,
    clear: clearTimeout,
  };
  let state: StorageHealthBody['state'] = 'unknown';
  let lastErrorCode: StorageFailureCode | null = null;
  let lastCheckedAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let outageSince: number | null = null;
  /** The last check started, and the last one whose result counted. */
  let started = 0;
  let applied = 0;
  let pending: { id: number; promise: Promise<void>; control: AbortController } | undefined;

  /**
   * Record one outcome. An older check's late answer never overwrites a newer
   * one: the module's health only moves forward in check order.
   */
  function apply(id: number, result: StoreCheck): void {
    if (id <= applied) return;
    applied = id;
    const at = now();
    lastCheckedAt = at;
    if (result.ok) {
      const recovered = state === 'down';
      const outageSeconds =
        outageSince === null ? null : Math.max(0, Math.round((at - outageSince) / 1000));
      state = 'ok';
      lastErrorCode = null;
      lastSuccessAt = at;
      outageSince = null;
      if (recovered)
        options.logger.info({ outageSeconds }, 'The storage module reached SeaweedFS again');
      return;
    }
    recordFailure(at, result.code);
  }

  function recordFailure(at: number, code: StorageFailureCode): void {
    const changed = state !== 'down' || lastErrorCode !== code;
    state = 'down';
    lastErrorCode = code;
    lastCheckedAt = at;
    outageSince ??= at;
    // One line per reason, never one per probe.
    if (changed) options.logger.warn({ code }, 'The storage module cannot use SeaweedFS');
  }

  /**
   * The check missed its deadline: that evaluation is unhealthy, the check is
   * cancelled, and whatever it eventually answers is obsolete.
   */
  function expire(): void {
    const expired = pending;
    if (expired === undefined) return;
    pending = undefined;
    applied = Math.max(applied, expired.id);
    expired.control.abort(new Error('storage health deadline'));
    recordFailure(now(), 'timeout');
  }

  function startCheck(): Promise<void> | undefined {
    if (pending !== undefined) return undefined;
    if (lastCheckedAt !== null && now() - lastCheckedAt < cacheMs) return undefined;
    const id = ++started;
    const control = new AbortController();
    const running = (async () => {
      let result: StoreCheck;
      try {
        result = await options.check(control.signal);
      } catch {
        result = { ok: false, code: 'unreachable' };
      }
      apply(id, result);
    })();
    const promise = running.finally(() => {
      if (pending?.id === id) pending = undefined;
    });
    pending = { id, promise, control };
    return promise;
  }

  function iso(at: number | null): string | null {
    return at === null ? null : new Date(at).toISOString();
  }

  function body(): StorageHealthBody {
    return {
      state,
      store: 'seaweedfs',
      bucket: options.bucket,
      lastErrorCode,
      lastCheckedAt: iso(lastCheckedAt),
      lastSuccessAt: iso(lastSuccessAt),
      outageSeconds:
        outageSince === null ? null : Math.max(0, Math.round((now() - outageSince) / 1000)),
    };
  }

  return {
    body,
    evaluate: async () => {
      // A cached answer, a shared check, or a new one: the caller waits on the
      // check that belongs to its own evaluation, bounded by the deadline.
      const waiting = startCheck() ?? pending?.promise;
      if (waiting !== undefined) {
        let expired = false;
        await new Promise<void>((resolve) => {
          const timer = schedule(() => {
            expired = true;
            resolve();
          }, boundMs);
          void waiting.finally(() => {
            cancel(timer);
            resolve();
          });
        });
        if (expired) expire();
      }
      return { status: state === 'ok' ? 200 : 503, body: body() };
    },
  };
}
