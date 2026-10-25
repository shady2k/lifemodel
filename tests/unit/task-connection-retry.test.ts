/** Connection classification at the HTTP/socket boundary, without replacing application logic. */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import {
  connectionState,
  connectionFailure,
  StartupConnectionRetry,
} from '../../loader/src/task-connection-retry.js';

describe('task startup connection retry', () => {
  it.each(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT'])(
    'retries %s only before TCP connect, not even during the TLS handshake',
    (code) => {
      const request = Object.assign(new EventEmitter(), { reusedSocket: false });
      const socket = Object.assign(new EventEmitter(), { connecting: true });
      const connected = connectionState(request as unknown as ClientRequest);
      request.emit('socket', socket);
      expect(connectionFailure({ code }, connected(), false).retryable).toBe(true);
      socket.emit('connect');
      expect(connectionFailure({ code }, connected(), false).retryable).toBe(false);
      request.emit('close');
      expect(socket.listenerCount('connect')).toBe(0);
      expect(socket.listenerCount('secureConnect')).toBe(0);
    }
  );
  it('never treats a reused socket or a TLS error as never-connected', () => {
    const request = Object.assign(new EventEmitter(), { reusedSocket: true });
    expect(
      connectionFailure(
        { code: 'ECONNRESET' },
        connectionState(request as unknown as ClientRequest)(),
        false
      ).retryable
    ).toBe(false);
    expect(connectionFailure({ code: 'CERT_HAS_EXPIRED' }, false, false).retryable).toBe(false);
  });
  it('caps a hung first connect by the startup window, then ends without another attempt', async () => {
    vi.useFakeTimers();
    try {
      const operation = vi.fn(
        (signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(connectionFailure({ code: 'ABORT_ERR' }, false, true)),
              { once: true }
            );
          })
      );
      // AbortSignal.timeout is a native timer; capture its requested bound and
      // deliver the same timeout via a controllable boundary signal.
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
      const work = new StartupConnectionRetry(200).run(operation, 5000);
      const rejected = expect(work).rejects.toMatchObject({ attempts: 1 });
      await vi.advanceTimersByTimeAsync(200);
      await rejected;
      expect(timeout).toHaveBeenCalledWith(200);
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
