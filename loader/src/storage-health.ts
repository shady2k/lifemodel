/**
 * The storage module's health logic (ADR-015 S-D7).
 *
 * Readiness answers one question: can the module use its catalog and its store
 * right now? A failed catalog or a failed store is `down` with its own reason -
 * an unreachable catalog, refused credentials, a missing bucket, no Seaweed
 * custody, or a check that passed its deadline - and is never reported as an
 * empty store. Liveness answers a different one: is this process alive.
 *
 * A check that misses its deadline is an unhealthy outcome of that evaluation,
 * not a reason to repeat the last good answer: the check is cancelled, its
 * eventual result is discarded, and the caller gets a 503 with `timeout`.
 */
import type { LoaderLogger } from './logger.js';
import type { S3CheckFailure } from './storage-s3.js';

export type StorageFailureCode =
  | S3CheckFailure
  | 'credentials_unavailable'
  | 'catalog_unavailable'
  | 'timeout';
/**
 * A failed check. `cause` is the repair it needs - a refused login, a missing
 * schema, an unreachable server - and never a body, a credential or a name.
 */
export type StoreCheck = { ok: true } | { ok: false; code: StorageFailureCode; cause?: string };

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
   * answer (deploy/platform/d/storage-module.yaml).
   */
  boundMs?: number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

export interface StorageHealth {
  body(): StorageHealthBody;
  evaluate(): Promise<{ status: number; body: StorageHealthBody }>;
}

interface ActiveCheck {
  id: number;
  control: AbortController;
  /** Settles when the check's result has been applied or discarded. */
  promise: Promise<void>;
  /** Settles when this check's own deadline passed, or when it finished first. */
  deadline: Promise<void>;
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
  /** The repair the last failure named, so a new one is logged as a change. */
  let lastCause: string | null = null;
  let lastCheckedAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let outageSince: number | null = null;
  /** The last check started, and the last one whose result counted. */
  let started = 0;
  let applied = 0;
  /**
   * The live check. Its deadline belongs to the check, not to a caller: every
   * caller awaiting this check settles on this one outcome, and no caller can
   * expire a check it did not await.
   */
  let pending: ActiveCheck | undefined;

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
      if (recovered) options.logger.info({ outageSeconds }, 'The storage module is ready again');
      return;
    }
    recordFailure(at, result.code, result.cause);
  }

  function recordFailure(at: number, code: StorageFailureCode, cause?: string): void {
    // A changed repair is a new diagnosis, even while the code stays the same.
    const changed = state !== 'down' || lastErrorCode !== code || lastCause !== (cause ?? null);
    state = 'down';
    lastErrorCode = code;
    lastCause = cause ?? null;
    lastCheckedAt = at;
    outageSince ??= at;
    // One line per reason, never one per probe.
    if (changed)
      options.logger.warn(
        { code, ...(cause === undefined ? {} : { cause }) },
        'The storage module is not ready'
      );
  }

  function startCheck(): ActiveCheck | undefined {
    // A live check is shared by every caller, including its deadline.
    if (pending !== undefined) return pending;
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
    let settled: (() => void) | undefined;
    const deadline = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const timer = schedule(() => {
      // This check missed its own deadline: that outcome is unhealthy, the
      // check is cancelled, and whatever it answers later is obsolete. Only
      // this check may be affected - never a newer one that replaced it.
      if (pending?.id === id) {
        pending = undefined;
        applied = Math.max(applied, id);
        control.abort(new Error('storage health deadline'));
        recordFailure(now(), 'timeout');
      }
      settled?.();
    }, boundMs);
    void promise.finally(() => {
      cancel(timer);
      settled?.();
    });
    pending = { id, control, promise, deadline };
    return pending;
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
      // check it belongs to, and on that check's own deadline.
      const check = startCheck();
      if (check !== undefined) await Promise.race([check.promise, check.deadline]);
      return { status: state === 'ok' ? 200 : 503, body: body() };
    },
  };
}
