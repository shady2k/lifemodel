import { createServer, type Server } from 'node:http';

export interface CoreHealth {
  isRunning(): boolean;
  getLastCommitAt(): number;
}

export async function startCoreHealthServer(
  core: CoreHealth,
  port: number,
  freshnessMs = 10_000
): Promise<Server> {
  const server = createServer((request, response) => {
    const healthy =
      request.url === '/healthz' &&
      core.isRunning() &&
      core.getLastCommitAt() > 0 &&
      Date.now() - core.getLastCommitAt() < freshnessMs;
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
