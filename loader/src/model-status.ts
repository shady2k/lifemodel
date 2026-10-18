/**
 * The model gateway's status for the loader's settings (ADR-013 D6).
 *
 * The loader reads `/status` itself, server side, with a bounded fetch and a
 * short cache, and hands the browser only the safe fields. This mirrors
 * `src/web/model-status.ts`; the loader is a separate TypeScript project
 * (`rootDir: ./src`), so the two cannot share the module and each keeps the
 * safe-code list beside its own projection (a test keeps them equal).
 */
import { isOwnedGatewayErrorCode, isUpstreamErrorCode } from './model-error-codes.js';

/** The fixed value every code the gateway does not own becomes. */
export const UNSAFE_MODEL_ERROR_CODE = 'unknown_error';

/** An ISO 8601 instant with its offset, the only timestamp shape accepted. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface LoaderModelStatus {
  state: 'unknown' | 'ok' | 'down';
  outageSince: string | null;
  lastErrorCode: string | null;
}

/** What the loader's HTTP layer sees: the safe status, or `null` when unreadable. */
export interface ModelStatusReader {
  read(): Promise<LoaderModelStatus | null>;
}

export interface ModelStatusReaderOptions {
  url: string;
  /** How long one fetch may take before the status is unavailable. */
  timeoutMs?: number;
  /** How long one answer is reused (ADR-013 D6: ≤ 10 s). */
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The outage's start as the gateway wrote it, or `null` for anything else. */
function safeInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * A code a browser may hold: one the gateway owns, or an upstream status. Any
 * other string — a URL, a secret, a prototype name — becomes one fixed value.
 */
export function safeModelErrorCode(code: string): string {
  return isOwnedGatewayErrorCode(code) || isUpstreamErrorCode(code)
    ? code
    : UNSAFE_MODEL_ERROR_CODE;
}

/** Reads exactly the safe fields; anything else is unavailable, never an outage. */
export function parseLoaderModelStatus(value: unknown): LoaderModelStatus | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const state = body['state'];
  if (state !== 'unknown' && state !== 'ok' && state !== 'down') return null;
  const outageSince = body['outageSince'];
  const lastErrorCode = body['lastErrorCode'];
  if (outageSince !== undefined && outageSince !== null && typeof outageSince !== 'string')
    return null;
  if (lastErrorCode !== undefined && lastErrorCode !== null && typeof lastErrorCode !== 'string')
    return null;
  // Only `down` carries the moment the outage began: another state drops it,
  // and a `down` without a usable instant is not an outage at all.
  const since = state === 'down' ? safeInstant(outageSince) : null;
  if (state === 'down' && since === null) return null;
  return {
    state,
    outageSince: since,
    lastErrorCode: typeof lastErrorCode === 'string' ? safeModelErrorCode(lastErrorCode) : null,
  };
}

export function createModelStatusReader(options: ModelStatusReaderOptions): ModelStatusReader {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cacheMs = options.cacheMs ?? 5_000;
  const now = options.now ?? Date.now;
  const fetchStatus = options.fetch ?? fetch;
  let cached: { at: number; value: LoaderModelStatus | null } | undefined;
  let inFlight: Promise<LoaderModelStatus | null> | undefined;

  async function fetchOnce(): Promise<LoaderModelStatus | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('expired');
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetchStatus(options.url, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null),
        expired,
      ]);
      if (response === 'expired' || response?.ok !== true) return null;
      const body = await Promise.race([response.text().catch(() => null), expired]);
      if (body === 'expired' || body === null) return null;
      try {
        return parseLoaderModelStatus(JSON.parse(body));
      } catch {
        return null;
      }
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async read() {
      const current = now();
      if (cached !== undefined && current - cached.at < cacheMs) return cached.value;
      inFlight ??= fetchOnce()
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
