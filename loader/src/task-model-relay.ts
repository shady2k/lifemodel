/** Loopback transport glue. No provider keys, catalog discovery or retries. */
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';

export interface TaskModelRelayOptions {
  modelEndpoint: string;
  modelTokenFile: string;
  modelCaFile: string;
  timeoutMs?: number;
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
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 300_000);
    const timedOut = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    deadline.addEventListener('abort', timedOut, { once: true });
    outgoing.on('close', () => deadline.removeEventListener('abort', timedOut));
    void (async () => {
      try {
        const [rawToken, ca] = await Promise.all([
          readFile(options.modelTokenFile, { encoding: 'utf8', signal: deadline }),
          readFile(options.modelCaFile, { signal: deadline }),
        ]);
        const token = rawToken.trim();
        if (!token || /[\r\n]/.test(token)) throw new Error('token_invalid');
        if (outgoing.destroyed) return;
        // Ignore all caller authentication and forwarding headers. Token is read
        // afresh, never placed in OpenCode configuration or its environment.
        const upstream = request(new URL(path, origin), {
          method: incoming.method,
          ca,
          headers: {
            'content-type': 'application/json',
            'x-lifemodel-task-token': token,
          },
          signal: deadline,
        });
        upstream.on('socket', (socket) => socket.on('error', () => undefined));
        incoming.on('aborted', () => upstream.destroy());
        upstream.on('error', () => {
          options.onError?.();
          if (!outgoing.headersSent)
            outgoing.writeHead(502, { 'content-type': 'application/json' });
          outgoing.end('{"error":{"message":"model_transport_failed"}}');
        });
        upstreams.add(upstream);
        upstream.on('close', () => upstreams.delete(upstream));
        outgoing.on('close', () => upstream.destroy());
        upstream.on('response', (response) => {
          response.on('error', () => outgoing.destroy());
          if ((response.statusCode ?? 500) >= 400) options.onError?.();
          outgoing.writeHead(response.statusCode ?? 502, {
            'content-type': response.headers['content-type'] ?? 'application/json',
          });
          response.pipe(outgoing);
        });
        incoming.pipe(upstream);
      } catch {
        options.onError?.();
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
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
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
