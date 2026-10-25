/** Loopback transport glue. No provider keys or catalog discovery. Only model-list connects can retry. */
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import {
  StartupConnectionRetry,
  connectionState,
  connectionFailure,
} from './task-connection-retry.js';

export interface TaskModelRelayOptions {
  modelEndpoint: string;
  modelTokenFile: string;
  modelCaFile: string;
  timeoutMs?: number;
  startupWindowMs?: number;
  onError?: () => void;
}

export async function createTaskModelRelay(options: TaskModelRelayOptions): Promise<{
  baseURL: string;
  close(): Promise<void>;
}> {
  const origin = new URL(options.modelEndpoint);
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('model_endpoint_invalid');
  }
  const retry = new StartupConnectionRetry(options.startupWindowMs);
  const sockets = new Set<Socket>();
  const upstreams = new Set<ReturnType<typeof request>>();
  const server: Server = createServer((incoming, outgoing) => {
    incoming.on('error', () => undefined);
    outgoing.on('error', () => undefined);
    const path = incoming.url ?? '';
    if (
      !(
        (incoming.method === 'POST' && path === '/v1/chat/completions') ||
        (incoming.method === 'GET' && path === '/v1/models')
      )
    ) {
      outgoing.writeHead(404).end();
      return;
    }
    const cancellation = new AbortController();
    const deadline = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 300_000),
      cancellation.signal,
    ]);
    const timedOut = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    deadline.addEventListener('abort', timedOut, { once: true });
    outgoing.on('close', () => {
      deadline.removeEventListener('abort', timedOut);
      cancellation.abort();
    });
    void (async () => {
      try {
        await retry.run(
          async (signal) => {
            const [rawToken, ca] = await Promise.all([
              readFile(options.modelTokenFile, { encoding: 'utf8', signal }),
              readFile(options.modelCaFile, { signal }),
            ]);
            const token = rawToken.trim();
            if (!token || /[\r\n]/.test(token)) throw new Error('token_invalid');
            signal.throwIfAborted();
            if (outgoing.destroyed) return;
            // Ignore caller auth. Every connection attempt reads projected files afresh.
            await new Promise<void>((resolve, reject) => {
              const upstream = request(new URL(path, origin), {
                method: incoming.method,
                ca,
                headers: {
                  'content-type': 'application/json',
                  'x-lifemodel-task-token': token,
                },
                signal,
              });
              const connected = connectionState(upstream);
              const abort = () => upstream.destroy();
              incoming.once('aborted', abort);
              upstream.on('error', (error) => {
                if (outgoing.headersSent) {
                  options.onError?.();
                  outgoing.destroy();
                }
                reject(connectionFailure(error, connected(), signal.aborted));
              });
              upstreams.add(upstream);
              upstream.once('close', () => {
                upstreams.delete(upstream);
                incoming.off('aborted', abort);
              });
              upstream.on('response', (response) => {
                response.on('error', () => outgoing.destroy());
                if ((response.statusCode ?? 500) >= 400) options.onError?.();
                outgoing.writeHead(response.statusCode ?? 502, {
                  'content-type': response.headers['content-type'] ?? 'application/json',
                });
                response.pipe(outgoing);
                resolve();
              });
              // Only GET is replayable. Never buffer or resend a streamed completion.
              if (incoming.method === 'GET') upstream.end();
              else incoming.pipe(upstream);
            });
          },
          options.timeoutMs ?? 300_000,
          { retry: incoming.method === 'GET', signal: deadline }
        );
      } catch {
        options.onError?.();
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
        outgoing.end('{"error":{"message":"model_transport_failed"}}');
      }
    })();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = options.timeoutMs ?? 300_000;
  server.maxHeadersCount = 32;
  server.on('error', () => undefined);
  server.on('connection', (socket) => {
    socket.on('error', () => undefined);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay_bind_failed');
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    async close() {
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    },
  };
}
