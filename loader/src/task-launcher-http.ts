/** Bounded task-only JSON transport. Identity and trust files rotate per call. */
import { request, Agent } from 'node:https';
import { readFile } from 'node:fs/promises';

export interface TaskEndpoint {
  endpoint: string;
  tokenFile: string;
  caFile: string;
}
export class LauncherError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number
  ) {
    super(code);
  }
}
export class TaskJsonClient {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 });
  constructor(
    private readonly config: TaskEndpoint,
    private readonly timeoutMs = 5_000
  ) {
    const url = new URL(config.endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new LauncherError('invalid_endpoint');
    this.agent.on('error', () => undefined);
  }
  close(): void {
    this.agent.destroy();
  }
  async call(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const [token, ca] = await Promise.all([
        readFile(this.config.tokenFile, { encoding: 'utf8', signal: controller.signal }),
        readFile(this.config.caFile, { signal: controller.signal }),
      ]);
      if (!token.trim() || /\s/.test(token.trim())) throw new LauncherError('identity_unavailable');
      controller.signal.throwIfAborted();
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = request(new URL(path, this.config.endpoint), {
          method: bytes === undefined ? 'GET' : 'POST',
          agent: this.agent,
          ca,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token.trim()}`,
            ...(bytes
              ? {
                  'content-type': 'application/json',
                  'content-length': String(bytes.length),
                }
              : {}),
          },
        });
        req.on('error', () => reject(new LauncherError('request_unavailable')));
        req.on('socket', (socket) => socket.on('error', () => undefined));
        req.on('response', (res) => {
          res.on('error', () => reject(new LauncherError('request_unavailable')));
          const chunks: Buffer[] = [];
          let length = 0;
          res.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 1024 * 1024) {
              reject(new LauncherError('response_too_large'));
              res.destroy();
            } else chunks.push(chunk);
          });
          res.on('end', () => {
            // A queued timer is not proof a late start ACK was timely.
            if (controller.signal.aborted || performance.now() >= deadline) {
              reject(new LauncherError('request_unavailable'));
              return;
            }
            if (res.statusCode !== 200) {
              reject(
                new LauncherError(
                  res.statusCode === 409 && path === '/task/start'
                    ? 'start_consumed'
                    : 'request_refused',
                  res.statusCode
                )
              );
              return;
            }
            try {
              const parsed: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
              );
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
              resolve(parsed as Record<string, unknown>);
            } catch {
              reject(new LauncherError('response_invalid'));
            }
          });
        });
        req.end(bytes);
      });
    } catch (error) {
      throw error instanceof LauncherError ? error : new LauncherError('request_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}
