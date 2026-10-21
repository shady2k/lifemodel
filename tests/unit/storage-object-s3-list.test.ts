import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createSealS3 } from '../helpers/storage-seal-s3.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const key = (id: number) => `private/00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const signal = () => new AbortController().signal;
async function setup(timeoutMs = 1000) {
  const server = await createSealS3();
  cleanup.push(() => server.close());
  const client = createStorageObjectS3({
    endpoint: server.endpoint,
    bucket: server.bucket,
    custody: { read: async () => server.credentials },
    timeoutMs,
  });
  cleanup.push(() => client.close());
  return { client, server };
}
const page = (contents = '', extra = '', truncated = 'false') =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
  `<Prefix>private/</Prefix><MaxKeys>100</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
  contents +
  extra +
  '</ListBucketResult>';
const object = (privateKey = key(1), size = '12', date = '2026-01-01T00:00:00.000Z') =>
  `<Contents><Key>${privateKey}</Key><Size>${size}</Size><LastModified>${date}</LastModified></Contents>`;

describe('bounded private S3 ListObjectsV2', () => {
  it('signs a fixed-prefix bounded GET, pages opaque keys and reuses the pooled socket', async () => {
    const { client, server } = await setup();
    const bytes = Buffer.from('sealed bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const lastModified = Date.parse('2026-01-01T00:00:00.000Z');
    for (let id = 0; id < 101; id++) server.objects.set(key(id), { bytes, sha256, lastModified });
    server.objects.set('other/key', { bytes, sha256, lastModified });
    const first = await client.listPrivate(undefined, signal());
    expect(first.objects).toHaveLength(100);
    expect(first.objects[0]).toEqual({ key: key(0), size: bytes.length, lastModified });
    expect(first.nextCursor).not.toBeNull();
    const second = await client.listPrivate(first.nextCursor ?? undefined, signal());
    expect(second).toEqual({
      objects: [{ key: key(100), size: bytes.length, lastModified }],
      nextCursor: null,
    });
    expect(
      server.requests.map((request) => ({
        method: request.method,
        authorized: request.authorized,
        key: request.key,
      }))
    ).toEqual([
      { method: 'GET', authorized: true, key: '' },
      { method: 'GET', authorized: true, key: '' },
    ]);
    expect(server.connections).toBe(1);
  });

  it('returns an empty page and supplies stable default modification metadata in the S3 double', async () => {
    const { client, server } = await setup();
    expect(await client.listPrivate(undefined, signal())).toEqual({
      objects: [],
      nextCursor: null,
    });
    server.objects.set(key(1), { bytes: Buffer.alloc(0), sha256: '' });
    const first = await client.listPrivate(undefined, signal());
    const second = await client.listPrivate(undefined, signal());
    expect(first).toEqual(second);
    expect(first.objects[0]?.lastModified).toBeGreaterThan(0);
  });

  it('decodes XML entities in an opaque token and signs the next request without leaking the token', async () => {
    const { client, server } = await setup();
    const token = 'opaque+/=&token';
    server.hooks.beforeList = () => ({
      status: 200,
      body: page('', '<NextContinuationToken>opaque+/=&amp;token</NextContinuationToken>', 'true'),
    });
    expect((await client.listPrivate(undefined, signal())).nextCursor).toBe(token);
    server.hooks.beforeList = (request) => {
      expect(request.authorized).toBe(true);
      return { status: 200, body: page() };
    };
    expect(await client.listPrivate(token, signal())).toEqual({ objects: [], nextCursor: null });
  });

  it.each(['', 'x'.repeat(4097), 'private cursor', 'cursor\n', '\ud800'])(
    'rejects an invalid input cursor before dispatch',
    async (cursor) => {
      const { client, server } = await setup();
      await expect(client.listPrivate(cursor, signal())).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      expect(server.requests).toHaveLength(0);
    }
  );

  it.each([
    ['DTD', '<!DOCTYPE ListBucketResult [<!ENTITY file SYSTEM "file:///secret">]>' + page()],
    ['undefined entity', page(object().replace(key(1), '&secret;'))],
    ['duplicate field', page(object().replace('</Size>', '</Size><Size>12</Size>'))],
    ['malformed nesting', page(object()).replace('</Contents>', '</Other>')],
    ['second document', page() + page()],
    ['unsafe key', page(object('private/../../secret'))],
    ['non UUID private key', page(object('private/readable-name'))],
    ['non private key', page(object('public/00000000-0000-4000-8000-000000000001'))],
    ['duplicate key', page(object() + object())],
    ['negative size', page(object(key(1), '-1'))],
    ['fractional size', page(object(key(1), '1.5'))],
    ['unsafe size', page(object(key(1), '9007199254740992'))],
    ['invalid date', page(object(key(1), '12', '2026-02-30T00:00:00Z'))],
    ['missing date', page(object().replace(/<LastModified>.*<\/LastModified>/, ''))],
    ['unknown truncation', page('', '', 'yes')],
    ['missing token', page('', '', 'true')],
    ['unexpected token', page('', '<NextContinuationToken>token</NextContinuationToken>')],
    [
      'oversized token',
      page('', `<NextContinuationToken>${'x'.repeat(4097)}</NextContinuationToken>`, 'true'),
    ],
    ['too many objects', page(Array.from({ length: 101 }, (_, id) => object(key(id))).join(''))],
    ['wrong prefix', page().replace('<Prefix>private/</Prefix>', '<Prefix>public/</Prefix>')],
    ['wrong count', page(object(), '<KeyCount>0</KeyCount>')],
  ])('fails safely on %s', async (_name, body) => {
    const { client, server } = await setup();
    server.hooks.beforeList = () => ({ status: 200, body });
    await expect(client.listPrivate(undefined, signal())).rejects.toMatchObject({
      status: 503,
      code: 'object_store_unavailable',
    });
  });

  it('rejects an unchanged continuation token rather than allowing a non-progressing scan', async () => {
    const { client, server } = await setup();
    server.hooks.beforeList = () => ({
      status: 200,
      body: page('', '<NextContinuationToken>same-token</NextContinuationToken>', 'true'),
    });
    await expect(client.listPrivate('same-token', signal())).rejects.toMatchObject({
      code: 'object_store_unavailable',
    });
  });

  it.each([undefined, String(128 * 1024 + 1)])(
    'bounds response bytes with content-length %s',
    async (length) => {
      const { client, server } = await setup();
      server.hooks.beforeList = () => ({
        status: 200,
        headers:
          length === undefined ? { 'transfer-encoding': 'chunked' } : { 'content-length': length },
        body: 'x'.repeat(128 * 1024 + 1),
      });
      await expect(client.listPrivate(undefined, signal())).rejects.toMatchObject({
        code: 'object_store_unavailable',
      });
    }
  );

  it('cancels a held list without holding a space settlement barrier', async () => {
    const { client, server } = await setup();
    let entered: () => void = () => undefined;
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    server.hooks.beforeList = () => {
      entered();
      return 'hang';
    };
    const controller = new AbortController();
    const listing = client.listPrivate(undefined, controller.signal);
    const outcome = expect(listing).rejects.toMatchObject({ code: 'object_store_unavailable' });
    await received;
    await client.settle('space-a', AbortSignal.timeout(1000));
    controller.abort();
    await outcome;
  });

  it('times out and sanitizes backend failures and dropped transport', async () => {
    const { client, server } = await setup(30);
    for (const action of [
      'hang',
      'lose-response',
      { status: 403, body: 'secret-backend-token' },
    ] as const) {
      server.hooks.beforeList = () => action;
      await expect(client.listPrivate(undefined, signal())).rejects.toMatchObject({
        code: 'object_store_unavailable',
        message: 'object_store_unavailable',
      });
    }
  });
});
