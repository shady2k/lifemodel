/**
 * The model gateway's status for the loader's settings (ADR-013 D6).
 *
 * The loader reads `/status` itself, server side, with a bounded fetch and a
 * short cache, and hands the browser only the safe fields. This mirrors
 * `src/web/model-status.ts`; the loader is a separate TypeScript project
 * (`rootDir: ./src`), so the two cannot share the module.
 */
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

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
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
  if (state === 'down' && !isInstant(outageSince)) return null;
  return { state, outageSince: outageSince ?? null, lastErrorCode: lastErrorCode ?? null };
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
      if (response === 'expired' || response === null || !response.ok) return null;
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
