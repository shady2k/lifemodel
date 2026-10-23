import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageObjectS3, type StorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { StorageAccessError } from '../../loader/src/storage-access-error.js';
import { createStorageS3Server } from '../helpers/storage-s3-server.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const dispatch = async (_bytes: number, send: () => undefined): Promise<void> => {
  send();
};
async function* source(bytes: Buffer) {
  yield bytes;
}
async function read(source: AsyncIterable<Buffer>) {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(chunk);
  return Buffer.concat(parts);
}
async function setup(extra: { chunkBytes?: number; timeoutMs?: number } = {}) {
  const server = await createStorageS3Server();
  cleanup.push(() => server.close());
  let reads = 0;
  const client = createStorageObjectS3({
    endpoint: server.endpoint,
    bucket: server.bucket,
    custody: {
      async read() {
        reads++;
        return server.credentials;
      },
    },
    ...extra,
  });
  cleanup.push(() => client.close());
  return {
    server,
    client,
    get reads() {
      return reads;
    },
  };
}
async function put(
  client: StorageObjectS3,
  bytes = Buffer.from('verified immutable bytes'),
  key = 'private-001'
) {
  await client.put(
    'space-a',
    key,
    bytes.length,
    hash(bytes),
    source(bytes),
    new AbortController().signal,
    dispatch
  );
  return bytes;
}

describe('the module private S3 byte backend', () => {
  it('keeps GET independent of the fully occupied forty-socket PUT pool', async () => {
    const { server, client } = await setup({ timeoutMs: 10_000 });
    const bytes = Buffer.from('readable');
    await put(client, bytes, 'readable');
    const controllers = Array.from({ length: 40 }, () => new AbortController());
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploads = controllers.map((controller, n) =>
      client
        .put(
          `space-${n}`,
          `held-${n}`,
          bytes.length,
          hash(bytes),
          (async function* () {
            entered++;
            await gate;
            controller.signal.throwIfAborted();
            yield bytes;
          })(),
          controller.signal,
          dispatch
        )
        .catch(() => undefined)
    );
    try {
      await expect.poll(() => entered).toBe(40);
      // Wait for real socket assignment, not only source entry or the configured
      // read-pool limit. A GET routed to the unchanged forty-socket PUT agent
      // must queue here even if telemetry still labels that request as a read.
      await expect.poll(() => client.transportSnapshot().put.sockets).toBe(40);
      expect(client.transportSnapshot().put.limit).toBe(40);
      const started = performance.now();
      const body = await client.get(
        'reader',
        'readable',
        0,
        bytes.length - 1,
        AbortSignal.timeout(1000)
      );
      expect(performance.now() - started).toBeLessThan(500);
      expect((await read(body)).equals(bytes)).toBe(true);
      expect(server.requests.some((request) => request.method === 'GET')).toBe(true);
    } finally {
      controllers.forEach((controller) => controller.abort());
      release();
      await Promise.all(uploads);
    }
    // A queued, canceled request can need the adapter's five-second transport
    // settlement deadline. Preserve that specific failure instead of masking
    // it with Vitest's default five-second test timeout.
  }, 15_000);

  it('settles only the selected space while another space has an open upload', async () => {
    const { client } = await setup();
    const bytes = Buffer.from('held upload');
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const guarded = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upload = client.put(
      'space-a',
      'private-held',
      bytes.length,
      hash(bytes),
      source(bytes),
      new AbortController().signal,
      async (_size, send) => {
        entered();
        await released;
        send();
      }
    );
    try {
      await guarded;
      let ownSettled = false;
      const own = client.settle('space-a', AbortSignal.timeout(1000)).then(() => {
        ownSettled = true;
      });
      await client.settle('space-b', AbortSignal.timeout(1000));
      expect(ownSettled).toBe(false);
      release();
      await upload;
      await own;
    } finally {
      release();
      await upload.catch(() => undefined);
    }
  });
  it('tracks operations before custody resolves so same-space settlement cannot miss a request', async () => {
    const { server } = await setup();
    const bytes = Buffer.from('held custody');
    server.objects.set('private-held', { bytes, sha256: hash(bytes) });
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createStorageObjectS3({
      endpoint: server.endpoint,
      bucket: server.bucket,
      custody: {
        async read() {
          entered();
          await released;
          return server.credentials;
        },
      },
    });
    cleanup.push(() => client.close());
    const verification = client.verify(
      'space-a',
      'private-held',
      bytes.length,
      hash(bytes),
      new AbortController().signal
    );
    try {
      await reading;
      let ownSettled = false;
      const own = client.settle('space-a', AbortSignal.timeout(1000)).then(() => {
        ownSettled = true;
      });
      await client.settle('space-b', AbortSignal.timeout(1000));
      expect(ownSettled).toBe(false);
      expect(server.requests).toHaveLength(0);
      release();
      await verification;
      await own;
      expect(server.requests.map((entry) => entry.method)).toEqual(['HEAD']);
    } finally {
      release();
      await verification.catch(() => undefined);
    }
  });
  it.each([404, 500])(
    'distinguishes HEAD integrity failure from backend status %s',
    async (status) => {
      const { client, server } = await setup();
      const bytes = Buffer.from('x');
      server.objects.set('private-missing', { bytes, sha256: hash(bytes) });
      server.hooks.beforeHead = () => ({ status });
      await expect(
        client.verify(
          'space-a',
          'private-missing',
          1,
          hash(Buffer.from('x')),
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        status: 503,
        code: status === 404 ? 'checksum_mismatch' : 'object_store_unavailable',
      });
    }
  );
  it('signs PUT and checksum-enabled HEAD and verifies durable bytes before resolving', async () => {
    const fixture = await setup({ chunkBytes: 7 });
    const bytes = Buffer.from('verified immutable bytes');
    const guarded: number[] = [];
    await fixture.client.put(
      'space-a',
      'private-001',
      bytes.length,
      hash(bytes),
      source(bytes),
      new AbortController().signal,
      async (size, send) => {
        guarded.push(size);
        expect(send()).toBeUndefined();
      }
    );
    expect(guarded).toEqual([7, 7, 7, 3]);
    expect(fixture.server.objects.get('private-001')?.bytes).toEqual(bytes);
    expect(fixture.server.requests.map((r) => [r.method, r.authorized])).toEqual([
      ['PUT', true],
      ['HEAD', true],
    ]);
    expect(fixture.server.requests[0]?.headers['if-none-match']).toBe('*');
    expect(fixture.server.requests[0]?.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(hash(bytes), 'hex').toString('base64')
    );
    expect(fixture.server.requests[1]?.headers['x-amz-checksum-mode']).toBe('ENABLED');
    expect(fixture.reads).toBe(2);
    // PUT and checksum HEAD have independent bounded transport pools.
    expect(fixture.server.connections).toBe(2);
  });
  it('never overwrites an immutable private key', async () => {
    const { client, server } = await setup();
    const bytes = await put(client);
    await expect(put(client, Buffer.from('other bytes'))).rejects.toMatchObject({
      status: 503,
      code: 'object_store_unavailable',
    });
    expect(server.objects.get('private-001')?.bytes).toEqual(bytes);
  });
  it.each(['length', 'checksum', 'missing-checksum'])(
    'rejects HEAD %s disagreement after accepted PUT',
    async (kind) => {
      const { client, server } = await setup();
      server.hooks.beforeHead = () => ({
        status: 200,
        headers:
          kind === 'length'
            ? { 'content-length': '999' }
            : { 'x-amz-checksum-sha256': kind === 'checksum' ? 'wrong' : '' },
      });
      await expect(put(client)).rejects.toMatchObject({
        status: 503,
        code: 'checksum_mismatch',
      });
      expect(server.objects.size).toBe(1);
    }
  );
  it.each(['length', 'hash'])(
    'rejects source %s disagreement without storing an object',
    async (kind) => {
      const { client, server } = await setup();
      const bytes = Buffer.from('bytes');
      await expect(
        client.put(
          'space-a',
          'private-001',
          kind === 'length' ? 2 : bytes.length,
          kind === 'hash' ? '0'.repeat(64) : hash(bytes),
          source(bytes),
          new AbortController().signal,
          dispatch
        )
      ).rejects.toBeInstanceOf(StorageAccessError);
      expect(server.objects.size).toBe(0);
    }
  );
  it('awaits each guard and never sends a refused chunk', async () => {
    const { client, server } = await setup({ chunkBytes: 2 });
    let guards = 0;
    await expect(
      client.put(
        'space-a',
        'private-001',
        6,
        hash(Buffer.from('secret')),
        source(Buffer.from('secret')),
        new AbortController().signal,
        async (_size, send) => {
          guards++;
          if (guards === 2) throw new StorageAccessError(403, 'access_revoked');
          send();
        }
      )
    ).rejects.toMatchObject({ status: 403, code: 'access_revoked' });
    expect(guards).toBe(2);
    expect(server.objects.size).toBe(0);
  });
  it('gets a signed bounded range with bounded output chunks', async () => {
    const { client, server } = await setup({ chunkBytes: 3 });
    const bytes = await put(client);
    const chunks: Buffer[] = [];
    for await (const chunk of await client.get(
      'space-a',
      'private-001',
      1,
      13,
      new AbortController().signal
    ))
      chunks.push(chunk);
    expect(chunks.every((c) => c.length <= 3)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(bytes.subarray(1, 14));
    expect(server.requests.at(-1)?.headers.range).toBe('bytes=1-13');
    expect(server.requests.at(-1)?.authorized).toBe(true);
  });
  it.each(['hang', 'lose-response', 'fail'] as const)(
    'contains backend %s and never returns private error data',
    async (failure) => {
      const { client, server } = await setup({ timeoutMs: 60 });
      server.hooks.afterWrite = () => (failure === 'fail' ? { status: 500 } : failure);
      let caught: unknown;
      try {
        await put(client);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageAccessError);
      expect(caught).toMatchObject({ status: 503, code: 'object_store_unavailable' });
      expect(String(caught)).not.toMatch(/private backend|storageTest|http|private-001/);
      expect(server.objects.size).toBe(1);
    }
  );
  it('bounds a source that never yields and cancels a hanging response', async () => {
    const { client, server } = await setup({ timeoutMs: 60 });
    const stalled: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    };
    await expect(
      client.put(
        'space-a',
        'private-001',
        1,
        '0'.repeat(64),
        stalled,
        new AbortController().signal,
        dispatch
      )
    ).rejects.toMatchObject({ status: 503 });
    server.objects.set('private-002', { bytes: Buffer.from('x'), sha256: hash(Buffer.from('x')) });
    const controller = new AbortController();
    server.hooks.beforeGet = () => {
      controller.abort();
      return 'hang';
    };
    await expect(
      client.get('space-a', 'private-002', 0, 0, controller.signal)
    ).rejects.toBeInstanceOf(StorageAccessError);
  });
  it('aborts GET streams and can make another request after a dropped socket', async () => {
    const { client, server } = await setup();
    await put(client, Buffer.alloc(200_000, 3));
    const controller = new AbortController();
    const stream = await client.get('space-a', 'private-001', 0, 199_999, controller.signal);
    controller.abort();
    await expect(read(stream)).rejects.toBeInstanceOf(StorageAccessError);
    server.hooks.beforeGet = () => 'lose-response';
    await expect(
      client.get('space-a', 'private-001', 0, 1, new AbortController().signal)
    ).rejects.toBeInstanceOf(StorageAccessError);
    delete server.hooks.beforeGet;
    expect(
      (await read(await client.get('space-a', 'private-001', 0, 1, new AbortController().signal)))
        .length
    ).toBe(2);
  });
  it('rejects preaborted requests, unbounded settings, and unsafe keys locally', async () => {
    const { client, server } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.get('space-a', 'private-001', 0, 1, controller.signal)
    ).rejects.toBeInstanceOf(StorageAccessError);
    for (const key of ['../escape', '/root', 'a%2fb', 'a?b'])
      await expect(
        client.get('space-a', key, 0, 1, new AbortController().signal)
      ).rejects.toBeInstanceOf(StorageAccessError);
    expect(server.requests).toHaveLength(0);
    expect(() =>
      createStorageObjectS3({
        endpoint: server.endpoint,
        bucket: server.bucket,
        custody: { read: async () => server.credentials },
        chunkBytes: 4 * 1024 * 1024 + 1,
      })
    ).toThrow();
  });
  it('coalesces network fragments into one bounded authorization chunk per 4 MiB', async () => {
    const { client, server } = await setup({ chunkBytes: 4 * 1024 * 1024 });
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 31);
    server.objects.set('private-large', { bytes, sha256: hash(bytes) });
    const sizes: number[] = [];
    const chunks: Buffer[] = [];
    for await (const chunk of await client.get(
      'space-a',
      'private-large',
      0,
      bytes.length - 1,
      new AbortController().signal
    )) {
      sizes.push(chunk.length);
      chunks.push(chunk);
    }
    expect(sizes).toEqual([4 * 1024 * 1024, 17]);
    const received = Buffer.concat(chunks);
    expect(received.length).toBe(bytes.length);
    expect(hash(received)).toBe(hash(bytes));
  }, 30_000);
  it('fake S3 rejects an invalid signature independently', async () => {
    const { server } = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${server.endpoint}/${server.bucket}/private-001`,
        { method: 'GET', headers: { authorization: 'invalid' } },
        (res) => {
          res.on('error', reject);
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(server.requests.at(-1)?.authorized).toBe(false);
  });
});
