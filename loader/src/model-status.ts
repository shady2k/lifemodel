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

/** The most a status body may be; a larger answer is not a status. */
const MAX_STATUS_BODY_BYTES = 4 * 1024;

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
    let response: Response | null = null;
    let reading = false;
    try {
      const answer = await Promise.race([
        fetchStatus(options.url, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null),
        expired,
      ]);
      if (answer === 'expired' || answer === null) return null;
      response = answer;
      // Exactly one answer is a status body; another 2xx is not one.
      if (response.status !== 200) return null;
      reading = true;
      const body = await Promise.race([
        readBoundedBody(response, MAX_STATUS_BODY_BYTES, controller.signal),
        expired,
      ]);
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
      // The body reader owns the cancel once it holds the stream; every other
      // path aborts the request and cancels what it did not consume.
      if (response !== null && !reading) {
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
      }
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

/**
 * The status body up to `limit` bytes; `null` when it overflows or cannot be
 * read. The reader is cancelled on every path that does not consume it,
 * including an abort while a read is pending.
 */
async function readBoundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<string | null> {
  const body = response.body;
  if (body === null) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  let text = '';
  let ended = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        ended = true;
        break;
      }
      // The loader's library types the body reader loosely; these are the
      // response's own bytes.
      const chunk = part.value as Uint8Array;
      size += chunk.byteLength;
      if (size > limit) return null;
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!ended) await reader.cancel().catch(() => undefined);
  }
}
