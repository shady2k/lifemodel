import { Agent, request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

export interface DeletionPlan {
  id: string;
  sequence: string;
  reason: string;
  state: 'pending';
  leadDays: number;
  settingsRevision: string;
  totalBytes: number;
}

/** Only safe identifiers cross the transport boundary; never attach an upstream cause. */
export class StorageControlError extends Error {
  readonly id = randomUUID();
  constructor(
    readonly route: string,
    readonly status?: number
  ) {
    super(
      `Storage control request failed: ${route}${status === undefined ? '' : ` (${String(status)})`}`
    );
    this.name = 'StorageControlError';
  }
}

export interface StorageControlClient {
  plans(
    cursor?: string,
    signal?: AbortSignal
  ): Promise<{ plans: DeletionPlan[]; nextCursor: string | null }>;
  warningCommitted(planId: string, messageId: string, signal?: AbortSignal): Promise<void>;
  close(): void;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validPlan(value: unknown): value is DeletionPlan {
  if (!record(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    ID.test(value['id']) &&
    typeof value['sequence'] === 'string' &&
    /^[1-9][0-9]*$/.test(value['sequence']) &&
    (value['reason'] === 'age' || value['reason'] === 'quota') &&
    value['state'] === 'pending' &&
    typeof value['leadDays'] === 'number' &&
    Number.isInteger(value['leadDays']) &&
    value['leadDays'] >= 1 &&
    value['leadDays'] <= 30 &&
    typeof value['settingsRevision'] === 'string' &&
    /^[0-9]+$/.test(value['settingsRevision']) &&
    typeof value['totalBytes'] === 'number' &&
    Number.isSafeInteger(value['totalBytes']) &&
    value['totalBytes'] >= 0
  );
}

/** Settle on abort even when an underlying filesystem read cannot stop. */
async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new Error('Storage projection read aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    // Promise.race keeps rejection handlers on the read after cancellation.
    // A late result can settle only the losing promise, never start HTTP.
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** One instance, one keep-alive pool. Explicit CA replaces (never extends) system trust. */
export function createStorageControlClient(options: {
  origin: string;
  tokenFile: string;
  caFile: string;
  requestTimeoutMs?: number;
  /** Read a rotating projection; cancellation must also bound readers that cannot stop. */
  readProjection?: (path: string, signal: AbortSignal) => Promise<Buffer>;
}): StorageControlClient {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new StorageControlError('/configuration');
  const timeoutMs = options.requestTimeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !options.tokenFile || !options.caFile)
    throw new StorageControlError('/configuration');
  const readProjection = options.readProjection ?? ((path, signal) => readFile(path, { signal }));
  const agent = new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1 });
  agent.on('error', () => undefined);
  const sockets = new WeakSet<Socket>();
  const active = new Set<AbortController>();
  let closed = false;

  async function call(
    route: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const controller = new AbortController();
    active.add(controller);
    const abort = () => {
      controller.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (closed || signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref();
    let status: number | undefined;
    try {
      // Neither credential nor CA is cached: kubelet rotates projections in place.
      controller.signal.throwIfAborted();
      const [tokenBytes, ca] = await withAbort(
        Promise.all([
          readProjection(options.tokenFile, controller.signal),
          readProjection(options.caFile, controller.signal),
        ]),
        controller.signal
      );
      controller.signal.throwIfAborted();
      const token = tokenBytes.toString('utf8').trim();
      if (!token || ca.length === 0) throw new Error('missing projection');
      return await new Promise<unknown>((resolve, reject) => {
        const fail = () => {
          reject(new StorageControlError(route, status));
        };
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request(new URL(path, origin), {
          method: payload === undefined ? 'GET' : 'POST',
          agent,
          ca,
          rejectUnauthorized: true,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
          },
        });
        req.on('error', fail);
        req.on('socket', (socket) => {
          if (!sockets.has(socket)) {
            sockets.add(socket);
            socket.on('error', () => undefined);
          }
        });
        req.on('response', (res) => {
          res.on('error', fail);
          res.on('aborted', fail);
          status = res.statusCode;
          if (status === undefined || status < 200 || status >= 300) {
            fail();
            res.destroy();
            req.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 131072) {
              fail();
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
            } catch {
              fail();
            }
          });
        });
        req.end(payload);
      });
    } catch (error) {
      if (error instanceof StorageControlError) throw error;
      throw new StorageControlError(route, status);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active.delete(controller);
    }
  }
  return {
    plans: async (cursor, signal) => {
      const route = '/retention/plans';
      const path = `${route}?limit=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const result = await call(route, path, undefined, signal);
      if (
        !record(result) ||
        !Array.isArray(result['plans']) ||
        result['plans'].length > 100 ||
        !result['plans'].every(validPlan) ||
        !(
          result['nextCursor'] === null ||
          (typeof result['nextCursor'] === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/.test(result['nextCursor']))
        )
      )
        throw new StorageControlError(route, 200);
      return { plans: result['plans'], nextCursor: result['nextCursor'] };
    },
    warningCommitted: async (planId, messageId, signal) => {
      if (!ID.test(planId) || !ID.test(messageId))
        throw new StorageControlError('/retention/warningCommitted');
      const result = await call(
        '/retention/warningCommitted',
        '/retention/warningCommitted',
        { planId, messageId },
        signal
      );
      if (
        !record(result) ||
        result['planId'] !== planId ||
        result['messageId'] !== messageId ||
        typeof result['id'] !== 'string' ||
        typeof result['earliestDeleteAt'] !== 'string'
      )
        throw new StorageControlError('/retention/warningCommitted', 200);
    },
    close: () => {
      closed = true;
      for (const controller of active) controller.abort();
      agent.destroy();
    },
  };
}
