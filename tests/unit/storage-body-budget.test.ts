/** Body ownership must end at the admitted chunk boundary, not a TCP fragment. */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
      const observedBufferedBytes = admission.snapshot().bufferedBytes + residual;
      expect(observedBufferedBytes).toBeLessThanOrEqual(admission.settings.bufferBytes);
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
