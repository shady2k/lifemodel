/** Real TCP loss boundary. No replacement pg client or pool. */
import { createServer, connect, type Socket } from 'node:net';
export async function createSealSqlProxy(connectionString: string) {
  const target = new URL(connectionString);
  const upstreamHost = target.hostname;
  const upstreamPort = Number(target.port || '5432');
  const sockets = new Set<Socket>();
  let blocked = false;
  const server = createServer((downstream) => {
    downstream.on('error', () => undefined);
    if (blocked) {
      downstream.destroy();
      return;
    }
    const upstream = connect({ host: upstreamHost, port: upstreamPort });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => {
        sockets.delete(socket);
        downstream.destroy();
        upstream.destroy();
      });
    }
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('SQL proxy startup failed');
  target.hostname = '127.0.0.1';
  target.port = String(address.port);
  return {
    connectionString: target.toString(),
    drop() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    restore() {
      blocked = false;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
