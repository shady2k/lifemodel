import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

/**
 * A stand-in for the platform ingress with ForwardAuth in front of the web
 * module (ADR-011 D3, ADR-012).
 *
 * - While `refuse` is set it answers a 503, what the owner's browser gets from
 *   Traefik while the loader pod that answers `/_auth/verify` is being
 *   replaced: the module is not the problem, the answer is nobody's.
 * - While `redirectToLogin` is set it answers the loader's own answer to a GET
 *   without a session: a 303 to the login page, carrying where it was going
 *   (`loader/src/auth.ts` `loginLocation`). The session is gone.
 * - It can drop the connections it holds, as replacing the upstream does.
 */
export interface ForwardAuthProxy {
  base: string;
  refuse: boolean;
  redirectToLogin: boolean;
  /** Ends every open connection: the rolled-out upstream is gone. */
  dropConnections(): void;
  close(): Promise<void>;
}

export async function createForwardAuthProxy(targetPort: number): Promise<ForwardAuthProxy> {
  const sockets = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const proxy: ForwardAuthProxy = {
    base: '',
    refuse: false,
    redirectToLogin: false,
    dropConnections: () => {
      for (const socket of [...sockets, ...upstreams]) socket.destroy();
      sockets.clear();
      upstreams.clear();
    },
    close: async () => {
      proxy.dropConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    if (proxy.refuse) {
      outgoing.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      outgoing.end('<html><body>Service Unavailable</body></html>');
      return;
    }
    if (proxy.redirectToLogin && incoming.method === 'GET') {
      const location = new URL(
        'https://boot-lifemodel.local/login?next=https%3A%2F%2Flifemodel.local%2F'
      );
      outgoing.writeHead(303, { Location: location.toString(), 'Cache-Control': 'no-store' });
      outgoing.end();
      return;
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      }
    );
    upstream.on('socket', (socket) => {
      upstreams.add(socket);
      socket.on('close', () => upstreams.delete(socket));
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the proxy has no address');
  proxy.base = `http://127.0.0.1:${address.port}`;
  return proxy;
}
