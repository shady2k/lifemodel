/** Retry only while TCP has never connected; no HTTP byte can have reached the peer. */
import type { ClientRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export class ConnectionFailure extends Error {
  attempts = 1;
  constructor(readonly retryable: boolean) {
    super('request_unavailable');
  }
}

/** TCP connect is deliberately more conservative than TLS secureConnect. */
export function connectionState(req: ClientRequest): () => boolean {
  let connected = req.reusedSocket;
  req.on('socket', (socket) => {
    connected ||= !socket.connecting;
    const mark = () => {
      connected = true;
    };
    socket.once('connect', mark);
    socket.once('secureConnect', mark);
    socket.on('error', () => undefined);
    req.once('close', () => {
      socket.off('connect', mark);
      socket.off('secureConnect', mark);
    });
  });
  return () => connected;
}

export function connectionFailure(
  error: unknown,
  connected: boolean,
  timedOut: boolean
): ConnectionFailure {
  const code = (error as NodeJS.ErrnoException).code;
  return new ConnectionFailure(
    !connected &&
      (timedOut ||
        ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT'].includes(
          code ?? ''
        ))
  );
}

export class StartupConnectionRetry {
  private readonly deadline: number;
  constructor(windowMs = 30_000) {
    this.deadline = performance.now() + windowMs;
  }
  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    options: {
      retry?: boolean;
      hardStopAt?: number | undefined;
      signal?: AbortSignal | undefined;
    } = {}
  ): Promise<T> {
    let attempts = 0;
    const startupDeadline = Math.min(this.deadline, performance.now() + 30_000);
    while (true) {
      // The startup window limits retries, not ordinary calls made later.
      const remaining = Math.min(
        options.hardStopAt === undefined ? Infinity : options.hardStopAt - Date.now(),
        attempts > 0 || (options.retry !== false && performance.now() < startupDeadline)
          ? startupDeadline - performance.now()
          : Infinity
      );
      if (remaining <= 0 || options.signal?.aborted) {
        const failure = new ConnectionFailure(false);
        failure.attempts = attempts;
        throw failure;
      }
      const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs, remaining))));
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      attempts++;
      try {
        return await operation(signal);
      } catch (error) {
        if (!(error instanceof ConnectionFailure)) throw error;
        error.attempts = attempts;
        const budget = Math.min(
          startupDeadline - performance.now(),
          options.hardStopAt === undefined ? Infinity : options.hardStopAt - Date.now()
        );
        const backoff =
          Math.min(2000, 100 * 2 ** Math.min(attempts - 1, 5)) * (0.5 + Math.random() * 0.5);
        if (
          !error.retryable ||
          options.retry === false ||
          options.signal?.aborted ||
          backoff >= budget
        )
          throw error;
        await delay(backoff, undefined, options.signal ? { signal: options.signal } : undefined);
      }
    }
  }
}
