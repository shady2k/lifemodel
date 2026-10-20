/**
 * The storage module's health logic (ADR-015 S-D7).
 *
 * Readiness answers one question: does SeaweedFS answer with valid auth right
 * now? A failed store is `down` with its own reason - unreachable, refused,
 * missing bucket, no credentials - and is never reported as an empty store.
 * Liveness answers a different one: is this process alive.
 */
import type { LoaderLogger } from './logger.js';
import type { S3CheckFailure } from './storage-s3.js';

export type StorageFailureCode = S3CheckFailure | 'credentials_unavailable';
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
  check(): Promise<StoreCheck>;
  logger: LoaderLogger;
  now?: () => number;
  /** How long one answer stands before a new check; tests set it to zero. */
  cacheMs?: number;
  /** How long a `/status` answer waits for the check it started. */
  boundMs?: number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

export interface StorageHealth {
  body(): StorageHealthBody;
  evaluate(): Promise<{ status: number; body: StorageHealthBody }>;
}

const DEFAULT_CACHE_MS = 2_000;
const DEFAULT_BOUND_MS = 3_000;

export function createStorageHealth(options: StorageHealthOptions): StorageHealth {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const boundMs = options.boundMs ?? DEFAULT_BOUND_MS;
  const { set: schedule, clear: cancel } = options.timers ?? {
    set: setTimeout,
    clear: clearTimeout,
  };
  let state: StorageHealthBody['state'] = 'unknown';
  let lastErrorCode: StorageFailureCode | null = null;
  let lastCheckedAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let outageSince: number | null = null;
  let pending: Promise<void> | undefined;

  function apply(result: StoreCheck): void {
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
    const changed = state !== 'down' || lastErrorCode !== result.code;
    state = 'down';
    lastErrorCode = result.code;
    outageSince ??= at;
    // One line per reason, never one per probe.
    if (changed)
      options.logger.warn({ code: result.code }, 'The storage module cannot use SeaweedFS');
  }

  async function checkOnce(): Promise<void> {
    if (pending !== undefined) return pending;
    if (lastCheckedAt !== null && now() - lastCheckedAt < cacheMs) return;
    const active = (async () => {
      let result: StoreCheck;
      try {
        result = await options.check();
      } catch {
        result = { ok: false, code: 'unreachable' };
      }
      apply(result);
    })();
    pending = active;
    try {
      await active;
    } finally {
      if (pending === active) pending = undefined;
    }
  }

  /** A caller never waits past the bound; a slow check applies its own answer later. */
  function within(check: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = schedule(() => {
        resolve();
      }, boundMs);
      void check.finally(() => {
        cancel(timer);
        resolve();
      });
    });
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
      await within(checkOnce());
      return { status: state === 'ok' ? 200 : 503, body: body() };
    },
  };
}
