/** Bounded task-only JSON transport. Identity and trust files rotate per call. */
import { request, Agent } from 'node:https';
import { readFile } from 'node:fs/promises';
import {
  ConnectionFailure,
  StartupConnectionRetry,
  connectionState,
  connectionFailure,
} from './task-connection-retry.js';

export interface TaskEndpoint {
  endpoint: string;
  tokenFile: string;
  caFile: string;
}
export class LauncherError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly connectionAttempts?: number
  ) {
    super(code);
  }
}
export class TaskJsonClient {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 });
  private readonly retry: StartupConnectionRetry;
  hardStopAt?: number;
  constructor(
    private readonly config: TaskEndpoint,
    private readonly timeoutMs = 5_000,
    startupWindowMs = 30_000
  ) {
    this.retry = new StartupConnectionRetry(startupWindowMs);
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
  async call(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return await this.retry.run(
        (signal) => this.attempt(path, body, signal),
        this.timeoutMs,
        // The once-only start contract deliberately remains stricter than transport safety.
        {
          retry: path !== '/task/start' && path !== '/task/trace',
          hardStopAt: this.hardStopAt,
          signal,
        }
      );
    } catch (error) {
      if (error instanceof ConnectionFailure)
        throw new LauncherError('request_unavailable', undefined, error.attempts);
      throw error instanceof LauncherError ? error : new LauncherError('request_unavailable');
    }
  }
  private async attempt(
    path: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const deadline = performance.now() + this.timeoutMs;
    try {
      const [token, ca] = await Promise.all([
        readFile(this.config.tokenFile, { encoding: 'utf8', signal: signal }),
        readFile(this.config.caFile, { signal: signal }),
      ]);
      if (!token.trim() || /\s/.test(token.trim())) throw new LauncherError('identity_unavailable');
      signal.throwIfAborted();
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = request(new URL(path, this.config.endpoint), {
          method: bytes === undefined ? 'GET' : 'POST',
          agent: this.agent,
          ca,
          signal: signal,
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
        const connected = connectionState(req);
        req.on('error', (error) => {
          reject(connectionFailure(error, connected(), signal.aborted));
        });
        req.on('response', (res) => {
          res.on('error', () => {
            reject(new LauncherError('request_unavailable'));
          });
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
            if (
              signal.aborted ||
              performance.now() >= deadline ||
              (this.hardStopAt !== undefined && Date.now() >= this.hardStopAt)
            ) {
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
      if (error instanceof ConnectionFailure || error instanceof LauncherError) throw error;
      throw new LauncherError('request_unavailable');
    }
  }
}
