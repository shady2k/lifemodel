/** TLS-only task door; core's HTTP listener never routes here. */
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { createModelGateway } from './model-gateway-app.js';
import type { createTaskIdentity, TaskStart } from './task-identity.js';
import { StorageAccessError } from './storage-access-error.js';
import { TaskAuthorizationError } from './model-gateway-response.js';
import type { LoaderLogger } from './logger.js';
export const TASK_TOKEN_HEADER = 'x-lifemodel-task-token';
interface Options {
  gateway: ReturnType<typeof createModelGateway>;
  access: ReturnType<typeof createTaskIdentity>;
  logger: LoaderLogger;
  tls: {
    cert: string;
    key: string;
    read?: () => Promise<{ cert: string; key: string }>;
    reloadMs?: number;
  };
}
function token(req: IncomingMessage, start: boolean): string {
  const name = start ? 'authorization' : TASK_TOKEN_HEADER;
  const count = req.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name
  ).length;
  const value = req.headers[name];
  if (count !== 1 || typeof value !== 'string' || (start && !/^Bearer [^\s]+$/.test(value)))
    throw new StorageAccessError(403, 'identity_denied');
  const result = start ? value.slice(7) : value;
  if (!result || result.length > 16_384 || /\s/.test(result))
    throw new StorageAccessError(403, 'identity_denied');
  return result;
}
async function body(req: IncomingMessage, signal: AbortSignal): Promise<TaskStart> {
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => req.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of req) {
      const part: unknown = chunk;
      if (!Buffer.isBuffer(part)) throw new StorageAccessError(400, 'invalid_request');
      size += part.length;
      if (size > 4096) throw new StorageAccessError(413, 'request_too_large');
      chunks.push(part);
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as TaskStart;
  } catch (error) {
    if (error instanceof StorageAccessError) throw error;
    throw new StorageAccessError(400, 'invalid_request');
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export function createTaskModelGateway(options: Options) {
  const controllers = new Set<AbortController>();
  async function serve(req: IncomingMessage, res: ServerResponse) {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    const start = req.method === 'POST' && req.url === '/task/start';
    const model =
      (req.method === 'POST' && req.url === '/v1/chat/completions') ||
      (req.method === 'GET' && req.url === '/v1/models');
    if (!start && !model) {
      res.writeHead(404);
      res.end();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => {
      controller.abort();
    }, 10_000);
    timer.unref();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', disconnect);
    req.on('aborted', disconnect);
    let taskContext: { taskId: string; traceId: string } | undefined;
    try {
      const credential = token(req, start);
      if (start) {
        const result = await options.access.start(
          await body(req, controller.signal),
          credential,
          controller.signal
        );
        controller.signal.throwIfAborted();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result));
      } else {
        const trusted = await options.access.authorize(credential, controller.signal);
        taskContext = { taskId: trusted.taskId, traceId: trusted.traceId };
        controller.signal.throwIfAborted();
        clearTimeout(timer); // ADR-013 owns its own complete forwarding deadline.
        await options.gateway.serveTask(
          req,
          res,
          trusted.taskId,
          async (signal) => {
            try {
              const fresh = await options.access.authorize(credential, signal);
              if (fresh.taskId !== trusted.taskId) throw new StorageAccessError(403, 'task_denied');
            } catch (error) {
              const failure =
                error instanceof StorageAccessError
                  ? error
                  : new StorageAccessError(503, 'task_unavailable');
              throw new TaskAuthorizationError(failure.code, failure.status);
            }
          },
          taskContext
        );
      }
    } catch (error) {
      const failure =
        error instanceof StorageAccessError
          ? error
          : new StorageAccessError(503, 'task_unavailable');
      const id = randomUUID();
      options.logger.warn(
        { id, code: failure.code, status: failure.status, ...taskContext },
        'Task gateway request refused'
      );
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(failure.status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          connection: 'close',
        });
        res.end(JSON.stringify({ error: { id, code: failure.code, start: false } }));
      } else if (!res.writableEnded) res.destroy();
    } finally {
      clearTimeout(timer);
      res.removeListener('close', disconnect);
      req.removeListener('aborted', disconnect);
      controllers.delete(controller);
    }
  }
  const server = createServer(
    { cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' },
    (req, res) => {
      void serve(req, res).catch(() => res.destroy());
    }
  );
  server.on('error', () => undefined);
  server.on('connection', (socket) => socket.on('error', () => undefined));
  server.on('secureConnection', (socket) => socket.on('error', () => undefined));
  server.on('tlsClientError', () => undefined);
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  let closed = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  async function reload(): Promise<void> {
    try {
      const certificate = await options.tls.read?.();
      if (certificate && !closed) server.setSecureContext(certificate);
    } catch {
      options.logger.warn({ code: 'certificate_reload_failed' }, 'Task gateway TLS reload failed');
    }
  }
  function schedule(): void {
    if (closed || !options.tls.read) return;
    reloadTimer = setTimeout(() => {
      void reload().finally(schedule);
    }, options.tls.reloadMs ?? 60_000);
    reloadTimer.unref();
  }
  schedule();
  return {
    server,
    reload,
    close: () => {
      closed = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}
