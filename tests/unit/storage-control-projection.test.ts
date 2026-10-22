import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:https';
import type { Socket } from 'node:net';
import {
  createStorageControlClient,
  StorageControlError,
  type StorageControlClient,
} from '../../src/core/storage-control-client.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('storage-control projection cancellation', () => {
  let cert: TestStorageCertificate;
  let server: Server;
  let origin: string;
  const sockets = new Set<Socket>();
  const clients: StorageControlClient[] = [];
  const tokenFile = '/projection/private-token';
  const caFile = '/projection/private-ca';
  const timeoutMs = 5000;
  let requests = 0;

  beforeAll(async () => {
    cert = await createStorageCertificate(['localhost']);
    server = createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
      requests++;
      expect(req.headers.authorization).toBe('Bearer fresh-token');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ plans: [], nextCursor: null }));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    origin = `https://localhost:${address.port}`;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cert.cleanup();
  });

  function client(readProjection: (path: string, signal: AbortSignal) => Promise<Buffer>) {
    const result = createStorageControlClient({
      origin,
      tokenFile,
      caFile,
      requestTimeoutMs: timeoutMs,
      readProjection,
    });
    clients.push(result);
    return result;
  }

  function projection(path: string) {
    return Buffer.from(path === tokenFile ? 'fresh-token\n' : cert.ca);
  }

  for (const stuck of ['token', 'CA'] as const) {
    it.each(['timeout', 'caller abort', 'close'] as const)(
      `settles on %s while the ${stuck} read never settles, recovers, and discards late data`,
      async (cancel) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const held = deferred<Buffer>();
        const stuckPath = stuck === 'token' ? tokenFile : caFile;
        let hold = true;
        const readProjection = vi.fn((path: string, _signal: AbortSignal) =>
          hold && path === stuckPath ? held.promise : Promise.resolve(projection(path))
        );
        const transport = client(readProjection);
        const caller = new AbortController();
        let result: unknown = 'pending';
        const pending = transport.plans(undefined, caller.signal).then(
          () => {
            result = 'resolved';
          },
          (error: unknown) => {
            result = error;
          }
        );
        expect(readProjection.mock.calls.map(([path]) => path)).toEqual([tokenFile, caFile]);
        expect(vi.mocked(request)).not.toHaveBeenCalled();
        if (cancel === 'timeout') await vi.advanceTimersByTimeAsync(timeoutMs);
        else {
          if (cancel === 'caller abort') caller.abort();
          else transport.close();
          await vi.advanceTimersByTimeAsync(0);
        }

        // Do not release the read to make this assertion pass: public settlement is
        // required even when the filesystem operation never returns.
        expect(result).toBeInstanceOf(StorageControlError);
        expect(result).toMatchObject({ route: '/retention/plans', status: undefined });
        expect(String(result)).not.toMatch(/private-token|private-ca|fresh-token/);
        expect(readProjection.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
        expect(vi.mocked(request)).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await pending;

        vi.useRealTimers();
        hold = false;
        const recovered = cancel === 'close' ? client(readProjection) : transport;
        const before = requests;
        await expect(recovered.plans()).resolves.toEqual({ plans: [], nextCursor: null });
        expect(requests).toBe(before + 1);
        expect(vi.mocked(request)).toHaveBeenCalledTimes(1);

        held.resolve(projection(stuckPath));
        await held.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
        expect(requests).toBe(before + 1);
        if (cancel === 'close') {
          await expect(transport.plans()).rejects.toBeInstanceOf(StorageControlError);
          expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
        }
      }
    );
  }

  it('handles a late projection rejection after cancellation without leaking its secret cause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = deferred<Buffer>();
    const transport = client((path) =>
      path === tokenFile ? held.promise : Promise.resolve(projection(path))
    );
    const caller = new AbortController();
    let error: unknown;
    const pending = transport.plans(undefined, caller.signal).catch((reason: unknown) => {
      error = reason;
    });
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toBeInstanceOf(StorageControlError);
    await pending;
    held.reject(new Error('private-token secret cause'));
    await vi.advanceTimersByTimeAsync(0);
    expect(String(error)).not.toContain('secret');
    expect(vi.mocked(request)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
