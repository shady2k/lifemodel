import { createServer, type Server } from 'node:http';

export interface CoreHealth {
  isRunning(): boolean;
  getTickCount(): number;
  getLastTickAt(): number;
}

export async function startCoreHealthServer(core: CoreHealth, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const healthy =
      request.url === '/healthz' &&
      core.isRunning() &&
      core.getTickCount() > 0 &&
      Date.now() - core.getLastTickAt() < 10_000;
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(healthy ? 'ok\n' : 'not ready\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
