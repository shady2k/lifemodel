import { Agent, request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { TaskSealReceipt } from '../ports/tasks.js';

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
    readonly status?: number,
    readonly code?: string
  ) {
    super(
      `Storage control request failed: ${route}${status === undefined ? '' : ` (${String(status)})`}`
    );
    this.name = 'StorageControlError';
  }
}

export interface StorageAllocationReceipt {
  readonly id: string;
  readonly space: string;
  readonly effectKey: string;
}
export interface StorageAllocationRequest {
  readonly taskId: string;
  readonly launchId: string;
  readonly effectKey: string;
  readonly retentionRevision: string;
}

export interface StorageSealRequest {
  readonly space: string;
  readonly effectKey: string;
  readonly expectedRevision: string;
  readonly outcome: 'completed' | 'failed' | 'stopped';
}
export interface StorageControlClient {
  seal(request: StorageSealRequest, signal?: AbortSignal): Promise<TaskSealReceipt>;
  allocate(
    request: StorageAllocationRequest,
    signal?: AbortSignal
  ): Promise<StorageAllocationReceipt>;
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

/** Validate the module receipt before it can cross the terminal CAS boundary. */
function validSealReceipt(value: unknown, request: StorageSealRequest): value is TaskSealReceipt {
  if (!record(value) || !record(value['manifest'])) return false;
  const manifest = value['manifest'];
  const object = (o: unknown) =>
    record(o) &&
    typeof o['id'] === 'string' &&
    ID.test(o['id']) &&
    typeof o['name'] === 'string' &&
    Buffer.byteLength(o['name']) <= 1024 &&
    typeof o['size'] === 'number' &&
    Number.isSafeInteger(o['size']) &&
    o['size'] >= 0 &&
    typeof o['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(o['sha256']) &&
    ['result', 'log', 'artifact'].includes(o['mark'] as string);
  return (
    typeof value['id'] === 'string' &&
    ID.test(value['id']) &&
    value['space'] === request.space &&
    value['effectKey'] === request.effectKey &&
    typeof value['revision'] === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value['revision']) &&
    value['outcome'] === request.outcome &&
    value['state'] === 'sealed' &&
    (value['reason'] === null ||
      (typeof value['reason'] === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value['reason']))) &&
    typeof manifest['id'] === 'string' &&
    ID.test(manifest['id']) &&
    manifest['version'] === 1 &&
    typeof manifest['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest['sha256']) &&
    Array.isArray(manifest['objects']) &&
    manifest['objects'].every(object) &&
    new Set(manifest['objects'].map((o) => (o as Record<string, unknown>)['id'])).size ===
      manifest['objects'].length &&
    (request.outcome !== 'completed' ||
      (value['reason'] === null &&
        manifest['objects'].some((o) => (o as Record<string, unknown>)['mark'] === 'result')))
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
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (status === undefined || status < 200 || status >= 300) {
                // Consume only a bounded structured code. Never retain remote text,
                // IDs, response bodies or transport causes in an error.
                const code =
                  record(parsed) &&
                  record(parsed['error']) &&
                  typeof parsed['error']['code'] === 'string' &&
                  /^[a-z][a-z0-9_]{0,63}$/.test(parsed['error']['code'])
                    ? parsed['error']['code']
                    : undefined;
                reject(new StorageControlError(route, status, code));
                return;
              }
              resolve(parsed);
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
    seal: async (seal, signal) => {
      const route = '/seal';
      if (
        !ID.test(seal.space) ||
        !ID.test(seal.effectKey) ||
        !/^(0|[1-9][0-9]{0,18})$/.test(seal.expectedRevision) ||
        !['completed', 'failed', 'stopped'].includes(seal.outcome)
      )
        throw new StorageControlError(route);
      const result = await call(route, route, seal, signal);
      if (!validSealReceipt(result, seal)) throw new StorageControlError(route, 200);
      return result;
    },
    allocate: async (allocation, signal) => {
      const route = '/allocate';
      if (
        ![
          allocation.taskId,
          allocation.launchId,
          allocation.effectKey,
          allocation.retentionRevision,
        ].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512)
      )
        throw new StorageControlError(route);
      const result = await call(route, route, allocation, signal);
      if (
        !record(result) ||
        typeof result['id'] !== 'string' ||
        !ID.test(result['id']) ||
        typeof result['space'] !== 'string' ||
        !ID.test(result['space']) ||
        result['effectKey'] !== allocation.effectKey
      )
        throw new StorageControlError(route, 200);
      return { id: result['id'], space: result['space'], effectKey: allocation.effectKey };
    },
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
