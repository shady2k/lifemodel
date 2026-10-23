/** Body ownership must end at the admitted chunk boundary, not a TCP fragment. */
import { createHash } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createStorageAdmission } from '../../loader/src/storage-admission.js';
import { createStorageObjects } from '../../loader/src/storage-objects.js';
import type { StorageTaskStream } from '../../loader/src/storage-access.js';
import type { StorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import type { StorageUploadOwner } from '../../loader/src/storage-upload-owner.js';

const catalog = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    query = catalog.query;
    async end() {}
  },
}));

const CHUNK = 16;
function request(body: Buffer) {
  const req = new Readable({ read() {} });
  req.on('error', () => undefined);
  req.push(body);
  let pulled = 0;
  const read = req.read.bind(req);
  vi.spyOn(req, 'read').mockImplementation((size?: number) => {
    const value = read(size) as Buffer | null;
    if (value) pulled += value.length;
    return value;
  });
  return { req, pulled: () => pulled };
}

describe('storage PUT body byte budget', () => {
  it('bounds request-buffer reservations even while admission is unresolved', async () => {
    const controller = new AbortController();
    const admission = createStorageAdmission({
      transferWorkers: 3,
      reservedReadWorkers: 1,
      perSpaceWorkers: 1,
      queueRequests: 1,
    });
    const acquire = vi.spyOn(admission, 'acquire').mockImplementation(async () => {
      controller.signal.throwIfAborted();
      return new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        })
      );
    });
    const s3 = { put: vi.fn() } as unknown as StorageObjectS3;
    const owner = { close: async () => undefined } as StorageUploadOwner;
    const stream = { signal: controller.signal } as StorageTaskStream;
    const objects = createStorageObjects({ connectionString: 'unused', s3, owner, admission });
    const requests = Array.from({ length: 5 }, () =>
      Object.assign(new Readable({ read() {} }), {
        method: 'PUT',
        url: '/upload-a',
        rawHeaders: [],
        headers: {},
      })
    );
    const pending = requests
      .slice(0, 3)
      .map((req) =>
        objects
          .handle(req as IncomingMessage, {} as ServerResponse, 'a', '/upload-a', stream)
          .catch(() => undefined)
      );
    try {
      await expect(
        objects.handle(
          requests[3] as IncomingMessage,
          {} as ServerResponse,
          'a',
          '/upload-a',
          stream
        )
      ).rejects.toMatchObject({ status: 429, code: 'storage_overloaded' });
      expect(acquire).toHaveBeenCalledTimes(3);
      // Task request buffers cannot consume the reserved read transport slot.
      const readPending = objects
        .handle(
          requests[4] as IncomingMessage,
          {} as ServerResponse,
          'reader',
          '/upload-a',
          stream,
          undefined,
          undefined,
          false,
          { admission, role: 'read' }
        )
        .catch(() => undefined);
      pending.push(readPending);
      expect(acquire).toHaveBeenCalledTimes(4);
      await expect(
        objects.handle(
          requests[3] as IncomingMessage,
          {} as ServerResponse,
          'reader',
          '/upload-a',
          stream,
          undefined,
          undefined,
          false,
          { admission, role: 'read' }
        )
      ).rejects.toMatchObject({ status: 429, code: 'storage_overloaded' });
      controller.abort();
      await Promise.all(pending);
      // A handler's rejection is not proof its unread HTTP buffers vanished.
      // Keep every reservation until the associated request actually closes.
      await expect(
        objects.handle(
          requests[3] as IncomingMessage,
          {} as ServerResponse,
          'a',
          '/upload-a',
          stream
        )
      ).rejects.toMatchObject({ status: 429, code: 'storage_overloaded' });
      expect(acquire).toHaveBeenCalledTimes(4);
    } finally {
      controller.abort();
      await Promise.all(pending);
      for (const req of requests) req.destroy();
      await objects.close();
    }
  });

  it.each(['high water mark', 'prebuffered body'] as const)(
    'refuses an unbudgeted %s before pulling or queueing a body',
    async (kind) => {
      const req = Object.assign(
        new Readable({
          highWaterMark: kind === 'high water mark' ? 4 * 1024 * 1024 : 64 * 1024,
          read() {},
        }),
        { method: 'PUT', url: '/upload-a', rawHeaders: [], headers: {} }
      );
      req.on('error', () => undefined);
      if (kind === 'prebuffered body') req.push(Buffer.alloc(128 * 1024 + 1));
      const admission = createStorageAdmission();
      const s3 = { put: vi.fn() } as unknown as StorageObjectS3;
      const owner = { close: async () => undefined } as StorageUploadOwner;
      const stream = { signal: new AbortController().signal } as StorageTaskStream;
      const objects = createStorageObjects({ connectionString: 'unused', s3, owner, admission });
      try {
        await expect(
          objects.handle(req as IncomingMessage, {} as ServerResponse, 'a', '/upload-a', stream)
        ).rejects.toMatchObject({ status: 429, code: 'storage_overloaded' });
        expect(admission.snapshot().active).toBe(0);
        expect(admission.snapshot().queued).toBe(0);
        expect(s3.put).not.toHaveBeenCalled();
      } finally {
        req.destroy();
        await objects.close();
      }
    }
  );

  it('counts real HTTP request buffers as well as admitted chunks during multi-chunk stalls and queueing', async () => {
    const admission = createStorageAdmission();
    const chunkBytes = admission.settings.chunkBytes;
    // IncomingMessage uses 64 KiB in Node 24. One further parser push may
    // cross that high-water mark. Reserve this even for queued requests.
    const requestBytes = 2 * 64 * 1024;
    const controller = new AbortController();
    const body = Buffer.alloc(3 * chunkBytes, 120);
    const sha256 = createHash('sha256').update(body).digest('hex');
    catalog.query.mockResolvedValue({
      rows: [
        {
          object_id: 'object-a',
          name: 'body.txt',
          size: String(body.length),
          sha256,
          state: 'pending',
          reserved: true,
        },
      ],
    });
    const requests: IncomingMessage[] = [];
    const held = new Map<string, number>();
    const releases = new Map<string, () => void>();
    const stalled = new Map<string, Promise<void>>();
    for (let index = 0; index < 8; index += 1) {
      const space = `space-${String(index)}`;
      stalled.set(
        space,
        new Promise<void>((resolve) => {
          releases.set(space, resolve);
        })
      );
    }
    const s3: StorageObjectS3 = {
      put: async (space, _key, _size, _hash, source) => {
        for await (const bytes of source) {
          held.set(space, bytes.length);
          await stalled.get(space);
          held.delete(space);
          controller.signal.throwIfAborted();
        }
      },
      get: vi.fn(),
      verify: vi.fn(),
      delete: vi.fn(),
      settle: vi.fn(),
      listPrivate: vi.fn(),
      close: vi.fn(),
    };
    const owner: StorageUploadOwner = {
      bootId: 'boot',
      ready: async () => undefined,
      assertActive: () => undefined,
      register: () => controller.signal,
      unregister: vi.fn(),
      isLive: () => true,
      close: async () => undefined,
    };
    const objects = createStorageObjects({ connectionString: 'unused', s3, owner, admission });
    const handling: Promise<void>[] = [];
    const server = createServer((req, res) => {
      requests.push(req);
      const space = req.url?.slice(1) ?? 'missing';
      const stream: StorageTaskStream = {
        signal: controller.signal,
        chunk: async (_bytes, dispatch) => {
          dispatch({ space, revision: '0', mode: 'active' });
        },
        publish: async () => ({ rows: [{ accepted: true }] }),
        close: () => undefined,
      };
      handling.push(
        objects.handle(req, res, space, '/upload-a', stream).catch(() => {
          res.writeHead(503);
          res.end();
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP address');
    const clients = Array.from({ length: 8 }, (_, index) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: 'PUT',
        path: `/space-${String(index)}`,
        agent: false,
        headers: {
          'content-length': body.length,
          'x-storage-name': Buffer.from('body.txt').toString('base64url'),
          'x-storage-length': String(body.length),
          'x-storage-sha256': sha256,
        },
      });
      req.on('error', () => undefined);
      req.on('response', (res) => res.resume());
      req.end(body);
      return req;
    });
    try {
      await vi.waitFor(() => {
        expect(requests).toHaveLength(8);
        expect(held.size).toBe(6);
        expect(admission.snapshot().queued).toBe(2);
        expect(requests.every((req) => req.readableLength >= 64 * 1024)).toBe(true);
      });
      const assertBudget = (): void => {
        const assembled = [...held.values()].reduce((sum, bytes) => sum + bytes, 0);
        const bufferedRequests = requests.reduce((sum, req) => sum + req.readableLength, 0);
        expect(assembled).toBe(6 * chunkBytes);
        expect(requests.every((req) => req.readableHighWaterMark <= 64 * 1024)).toBe(true);
        expect(requests.every((req) => req.readableLength <= requestBytes)).toBe(true);
        // No request is exempt: includes active transports and queued requests.
        // Kernel socket memory is not counted as JS buffers.
        expect(assembled + bufferedRequests).toBeLessThanOrEqual(
          admission.snapshot().bufferedBytes + requests.length * requestBytes
        );
      };
      assertBudget();
      // Let one first chunk dispatch. An initially queued request takes its
      // allocation; the original multi-chunk upload must now rejoin the queue.
      const advanced = held.keys().next().value as string;
      releases.get(advanced)?.();
      await vi.waitFor(() => {
        expect(held.has(advanced)).toBe(false);
        expect(held.size).toBe(6);
        expect(admission.snapshot().queued).toBe(2);
      });
      assertBudget();
      const parked = requests.find((req) => req.url === `/${advanced}`);
      expect(parked?.readableLength).toBeGreaterThan(0);
      expect(parked?.readableLength).toBeLessThanOrEqual(requestBytes);
    } finally {
      controller.abort();
      for (const release of releases.values()) release();
      for (const req of clients) req.destroy();
      for (const req of requests) req.destroy();
      server.closeAllConnections();
      await Promise.all(handling);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await objects.close();
    }
  });

  it('leaves a cross-boundary fragment in the paused request while chunk reacquisition is blocked', async () => {
    const admission = createStorageAdmission({
      chunkBytes: CHUNK,
      transferWorkers: 3,
      reservedReadWorkers: 1,
      perSpaceWorkers: 1,
      bufferBytes: 2 * CHUNK,
    });
    const controller = new AbortController();
    const readLease = await admission.acquire({
      space: 'reader',
      role: 'read',
      bytes: CHUNK,
      signal: controller.signal,
    });
    // One source fragment deliberately crosses the first chunk boundary.
    const input = request(Buffer.alloc(CHUNK + 3, 120));
    const completeBody = Buffer.alloc(2 * CHUNK, 120);
    const sha256 = createHash('sha256').update(completeBody).digest('hex');
    const req = Object.assign(input.req, {
      method: 'PUT',
      url: '/spaces/a/objects/upload-a',
      headers: {
        'x-storage-name': Buffer.from('body.txt').toString('base64url'),
        'x-storage-length': String(completeBody.length),
        'x-storage-sha256': sha256,
      },
      rawHeaders: [
        'x-storage-name',
        Buffer.from('body.txt').toString('base64url'),
        'x-storage-length',
        String(completeBody.length),
        'x-storage-sha256',
        sha256,
      ],
    }) as IncomingMessage;
    catalog.query.mockResolvedValue({
      rows: [
        {
          object_id: 'object-a',
          name: 'body.txt',
          size: String(completeBody.length),
          sha256,
          state: 'pending',
          reserved: true,
        },
      ],
    });
    let dispatched = 0;
    const s3: StorageObjectS3 = {
      put: async (_space, _key, _size, _hash, source) => {
        for await (const bytes of source) dispatched += bytes.length;
      },
      get: vi.fn(),
      verify: vi.fn(),
      delete: vi.fn(),
      settle: vi.fn(),
      listPrivate: vi.fn(),
      close: vi.fn(),
    };
    const owner: StorageUploadOwner = {
      bootId: 'boot',
      ready: async () => undefined,
      assertActive: () => undefined,
      register: () => controller.signal,
      unregister: vi.fn(),
      isLive: () => true,
      close: async () => undefined,
    };
    const stream: StorageTaskStream = {
      signal: controller.signal,
      chunk: async (_bytes, dispatch) => {
        dispatch({ space: 'a', revision: '0', mode: 'active' });
      },
      publish: async () => ({ rows: [{ accepted: true }] }),
      close: () => undefined,
    };
    const objects = createStorageObjects({ connectionString: 'unused', s3, owner, admission });
    // Hold the sole task byte allocation until this upload is queued. Nothing
    // should be pulled from its already available body before initial admission.
    const initialBlocker = await admission.acquire({
      space: 'blocker',
      role: 'task',
      bytes: CHUNK,
      signal: controller.signal,
    });
    const handled = objects.handle(req, {} as ServerResponse, 'a', '/upload-a', stream);
    const settled = handled.catch(() => undefined);
    let nextLease: Awaited<ReturnType<typeof admission.acquire>> | undefined;
    try {
      await vi.waitFor(() => expect(admission.snapshot().queued).toBe(1));
      expect(input.pulled()).toBe(0);
      // B is already waiting when A releases its first chunk, so B wins the
      // next allocation and A must wait with metadata only.
      const next = admission.acquire({
        space: 'b',
        role: 'task',
        bytes: CHUNK,
        signal: controller.signal,
      });
      initialBlocker.release();
      nextLease = await next;
      await vi.waitFor(() => {
        expect(dispatched).toBe(CHUNK);
        expect(admission.snapshot().queued).toBe(1);
      });
      const residual = input.pulled() - dispatched;
      const observedBufferedBytes =
        admission.snapshot().bufferedBytes + residual + input.req.readableLength;
      // Queued transport payload is not metadata and is not free. It uses its
      // explicit 128 KiB request-buffer reserve, outside artifact chunk leases.
      expect(observedBufferedBytes).toBeLessThanOrEqual(
        admission.settings.bufferBytes + 128 * 1024
      );
      expect(residual).toBe(0);
      expect(input.req.readableLength).toBe(3);
      // Failure/cancel teardown also wakes a paused request-body reader.
    } finally {
      controller.abort();
      input.req.destroy();
      initialBlocker.release();
      nextLease?.release();
      readLease.release();
      await settled;
      await objects.close();
    }
  });

  it.each([
    ['short', CHUNK - 1, CHUNK, false, 'length_mismatch'],
    ['surplus', CHUNK + 1, CHUNK, false, 'length_mismatch'],
    ['wrong hash', CHUNK, CHUNK, true, 'hash_mismatch'],
    ['empty', 0, 0, false, undefined],
    ['exact multi-chunk', 2 * CHUNK + 3, 2 * CHUNK + 3, false, undefined],
  ] as const)(
    'settles a %s body without waiting for another fragment',
    async (_name, actual, size, badHash, error) => {
      const controller = new AbortController();
      const input = request(Buffer.alloc(actual, 120));
      input.req.push(null);
      const sha256 = badHash
        ? '0'.repeat(64)
        : createHash('sha256').update(Buffer.alloc(size, 120)).digest('hex');
      const req = Object.assign(input.req, {
        method: 'PUT',
        url: '/spaces/a/objects/upload-a',
        headers: {
          'x-storage-name': Buffer.from('body.txt').toString('base64url'),
          'x-storage-length': String(size),
          'x-storage-sha256': sha256,
        },
        rawHeaders: [
          'x-storage-name',
          Buffer.from('body.txt').toString('base64url'),
          'x-storage-length',
          String(size),
          'x-storage-sha256',
          sha256,
        ],
      }) as IncomingMessage;
      catalog.query.mockResolvedValue({
        rows: [
          {
            object_id: 'object-a',
            name: 'body.txt',
            size: String(size),
            sha256,
            state: 'pending',
            reserved: true,
            receipt: { id: 'object-a' },
          },
        ],
      });
      const publish = vi.fn(async (statement: { text: string }) => ({
        rows: [
          statement.text.includes('complete_upload') ? { status: 'completed' } : { accepted: true },
        ],
      }));
      const stream: StorageTaskStream = {
        signal: controller.signal,
        chunk: async (_bytes, dispatch) => {
          dispatch({ space: 'a', revision: '0', mode: 'active' });
        },
        publish,
        close: () => undefined,
      };
      const chunks: number[] = [];
      const s3: StorageObjectS3 = {
        put: async (_space, _key, _size, _hash, source) => {
          for await (const bytes of source) chunks.push(bytes.length);
        },
        get: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
        settle: vi.fn(),
        listPrivate: vi.fn(),
        close: vi.fn(),
      };
      const owner: StorageUploadOwner = {
        bootId: 'boot',
        ready: async () => undefined,
        assertActive: () => undefined,
        register: () => controller.signal,
        unregister: vi.fn(),
        isLive: () => true,
        close: async () => undefined,
      };
      const admission = createStorageAdmission({ chunkBytes: CHUNK });
      const objects = createStorageObjects({ connectionString: 'unused', s3, owner, admission });
      const res = { writeHead: vi.fn(), end: vi.fn() };
      try {
        const handled = objects.handle(
          req,
          res as unknown as ServerResponse,
          'a',
          '/upload-a',
          stream
        );
        if (error) await expect(handled).rejects.toMatchObject({ code: error });
        else {
          await handled;
          expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
          expect(chunks.reduce((sum, bytes) => sum + bytes, 0)).toBe(size);
          expect(chunks.every((bytes) => bytes <= CHUNK)).toBe(true);
        }
        expect(
          publish.mock.calls.some(([statement]) => statement.text.includes('complete_upload'))
        ).toBe(!error);
        expect(admission.snapshot().bufferedBytes).toBe(0);
        expect(input.req.listenerCount('readable')).toBe(0);
      } finally {
        controller.abort();
        input.req.destroy();
        await objects.close();
      }
    }
  );
});
