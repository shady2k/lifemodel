import { Agent, request } from 'node:http';
import type { OwnerDownloadSessions } from '../ports/task-artifact-download.js';

/** Uses the loader's existing verification operation over its private Service. */
export class LoaderDownloadSessions implements OwnerDownloadSessions {
  private readonly socketErrors = new WeakSet<import('node:net').Socket>();
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
  constructor(
    private readonly instanceName: string,
    private readonly endpoint = 'http://loader.lifemodel-system.svc.cluster.local:7000/_auth/verify'
  ) {}
  close(): void {
    this.agent.destroy();
  }
  verify(cookie: string | undefined, signal: AbortSignal): Promise<boolean> {
    if (!cookie) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const req = request(this.endpoint, {
        agent: this.agent,
        signal,
        headers: {
          cookie,
          'x-forwarded-method': 'POST',
          'x-forwarded-host': `${this.instanceName}.local`,
        },
      });
      req.on('error', () => reject(new Error('owner_auth_unavailable')));
      req.on('socket', (socket) => {
        if (!this.socketErrors.has(socket)) {
          this.socketErrors.add(socket);
          socket.on('error', () => undefined);
        }
      });
      const timer = setTimeout(() => req.destroy(new Error('owner_auth_deadline')), 2_000);
      timer.unref();
      req.on('close', () => clearTimeout(timer));
      req.on('response', (res) => {
        res.on('error', () => undefined);
        const status = res.statusCode;
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) req.destroy(new Error('owner_auth_response'));
        });
        res.once('end', () => {
          if (!res.complete) {
            reject(new Error('owner_auth_unavailable'));
            return;
          }
          if (status === 200) resolve(true);
          else if (status === 401 || status === 302 || status === 303) resolve(false);
          else reject(new Error('owner_auth_unavailable'));
        });
        res.once('close', () => {
          if (!res.complete) reject(new Error('owner_auth_unavailable'));
        });
      });
      req.end();
    });
  }
}
