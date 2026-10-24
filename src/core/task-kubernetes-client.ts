/** Bounded in-cluster HTTPS transport. One agent, rotated credentials read per request. */
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import type { Socket } from 'node:net';
import { TaskExecutorError } from './task-executor.js';

export interface TaskKubernetesResponse {
  readonly status: number;
  readonly body: unknown;
}
export interface TaskKubernetesClient {
  request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<TaskKubernetesResponse>;
  close(): void;
}
export interface TaskKubernetesClientOptions {
  readonly apiServer?: string;
  readonly tokenFile?: string;
  readonly caFile?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly readProjection?: (path: string, signal: AbortSignal) => Promise<Buffer>;
}

/** Cancellation bounds projection readers even when filesystem work cannot stop. */
async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new TaskExecutorError('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function createTaskKubernetesClient(
  options: TaskKubernetesClientOptions = {}
): TaskKubernetesClient {
  let server: URL;
  try {
    server = new URL(
      options.apiServer ??
        `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`
    );
  } catch {
    throw new TaskExecutorError('invalid_launch');
  }
  if (
    (options.tokenFile !== undefined && !options.tokenFile) ||
    (options.caFile !== undefined && !options.caFile)
  )
    throw new TaskExecutorError('invalid_launch');
  if (
    server.protocol !== 'https:' ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    server.pathname !== '/'
  ) {
    throw new TaskExecutorError('invalid_launch');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 16 * 1024 * 1024
  ) {
    throw new TaskExecutorError('invalid_launch');
  }
  const agent = new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
  agent.on('error', () => undefined);
  const sockets = new WeakSet<Socket>();
  const active = new Set<AbortController>();
  const readProjection =
    options.readProjection ?? ((path: string, signal: AbortSignal) => readFile(path, { signal }));
  let closed = false;
  return {
    close() {
      closed = true;
      for (const controller of active) controller.abort();
      agent.destroy();
    },
    async request(method, path, body, signal) {
      if (closed) throw new TaskExecutorError('transport_error');
      const controller = new AbortController();
      active.add(controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const watch = method === 'WATCH';
      const timer = setTimeout(
        () => {
          controller.abort();
        },
        watch ? 35_000 : timeoutMs
      );
      timer.unref();
      try {
        if (combined.aborted) throw new TaskExecutorError('aborted');
        if (
          !/^\/(?:apis\/batch\/v1\/namespaces\/[a-z0-9-]+\/jobs|api\/v1\/namespaces\/[a-z0-9-]+\/(?:pods|persistentvolumeclaims))(?:\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)?(?:\?[^#]*)?$/.test(
            path
          )
        )
          throw new TaskExecutorError('invalid_launch');
        const [tokenBytes, ca] = await withAbort(
          Promise.all([
            readProjection(
              options.tokenFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
              combined
            ),
            readProjection(
              options.caFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
              combined
            ),
          ]),
          combined
        );
        if (combined.aborted || closed) throw new TaskExecutorError('aborted');
        const token = tokenBytes.toString('utf8').trim();
        if (
          !token ||
          token.length > 64 * 1024 ||
          /[\r\n]/.test(token) ||
          !ca.length ||
          ca.length > 1024 * 1024
        )
          throw new TaskExecutorError('transport_error');
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload !== undefined && Buffer.byteLength(payload) > maxBytes)
          throw new TaskExecutorError('invalid_launch');
        return await new Promise<TaskKubernetesResponse>((resolve, reject) => {
          const req = request(
            new URL(path, server),
            {
              method: watch ? 'GET' : method,
              agent,
              ca,
              signal: combined,
              headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/json',
                ...(payload === undefined
                  ? {}
                  : {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(payload),
                    }),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              let size = 0;
              res.on('error', () => {
                reject(new TaskExecutorError('transport_error'));
              });
              res.on('aborted', () => {
                reject(new TaskExecutorError('transport_error'));
              });
              res.on('close', () => {
                if (!res.complete) reject(new TaskExecutorError('transport_error'));
              });
              if (watch && res.statusCode === 410) {
                resolve({ status: 410, body: null });
                res.destroy();
                req.destroy();
                return;
              }
              res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                  reject(new TaskExecutorError('transport_error'));
                  res.destroy();
                  req.destroy();
                  return;
                }
                if (watch && res.statusCode === 200 && chunk.toString('utf8').trim()) {
                  // A watch is a wakeup, not authority. Resync reads canonical objects.
                  resolve({ status: 200, body: null });
                  res.destroy();
                  req.destroy();
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => {
                try {
                  if (watch && res.statusCode === 200) {
                    resolve({ status: 200, body: null });
                    return;
                  }
                  const text = Buffer.concat(chunks).toString('utf8');
                  resolve({
                    status: res.statusCode ?? 0,
                    body: text ? (JSON.parse(text) as unknown) : null,
                  });
                } catch {
                  reject(new TaskExecutorError('transport_error'));
                }
              });
            }
          );
          req.on('error', () => {
            reject(new TaskExecutorError(combined.aborted ? 'aborted' : 'transport_error'));
          });
          req.on('socket', (socket) => {
            if (!sockets.has(socket)) {
              sockets.add(socket);
              socket.on('error', () => undefined);
            }
          });
          if (payload !== undefined) req.write(payload);
          req.end();
        });
      } catch (error) {
        if (signal?.aborted) throw new TaskExecutorError('aborted');
        if (error instanceof TaskExecutorError) throw error;
        throw new TaskExecutorError('transport_error');
      } finally {
        clearTimeout(timer);
        active.delete(controller);
      }
    },
  };
}
