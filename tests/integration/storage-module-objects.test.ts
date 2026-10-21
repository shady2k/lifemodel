import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import { Pool } from 'pg';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStorageCli } from '../../loader/src/storage-cli.js';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createStorageObjects } from '../../loader/src/storage-objects.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { storageObjectIdentity } from '../helpers/storage-object-identity.js';
import { createFakeStorageS3 } from '../helpers/storage-s3-server.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let stores: TestStores;
let identity: Awaited<ReturnType<typeof storageObjectIdentity>>;
let backend: Awaited<ReturnType<typeof createFakeStorageS3>>;
let app: ReturnType<typeof createStorageModule>;
let objects: ReturnType<typeof createStorageObjects>;
let s3: ReturnType<typeof createStorageObjectS3>;
let access: ReturnType<typeof createStorageAccess>;
let port: number;
async function start() {
  access = createStorageAccess({
    connectionString: workerDatabaseUrl(),
    identity: identity.identity,
  });
  s3 = createStorageObjectS3({
    endpoint: backend.endpoint,
    bucket: 'task-output',
    custody: { read: async () => backend.credentials },
    timeoutMs: 1000,
  });
  objects = createStorageObjects({ connectionString: workerDatabaseUrl(), s3, timeoutMs: 2000 });
  app = createStorageModule({
    bucket: 'task-output',
    catalog: createCatalog({ connectionString: workerDatabaseUrl() }),
    access,
    objects,
    custody: { read: async () => backend.credentials },
    check: async () => ({ ok: true }),
    logger: createRecordingLogger([]),
    tls: { ...identity.certificate, read: async () => identity.certificate },
  });
  await new Promise<void>((resolve) => app.task.server.listen(0, '127.0.0.1', resolve));
  const address = app.task.server.address();
  if (!address || typeof address === 'string') throw Error('no listener');
  port = address.port;
}
async function stop() {
  app.task.close();
  app.control.close();
  app.read.close();
  await objects.close();
  s3.close();
}
async function call(
  method: string,
  path: string,
  body = Buffer.alloc(0),
  headers: Record<string, string> = {},
  token = 'a'
) {
  return new Promise<{ status: number; body: Buffer; json: any }>((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        port,
        method,
        path,
        ca: identity.certificate.ca,
        headers: { authorization: `Bearer ${token}`, ...headers },
      },
      (res) => {
        res.on('error', reject);
        const chunks: Buffer[] = [];
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json;
          try {
            json = JSON.parse(bytes.toString());
          } catch {}
          resolve({ status: res.statusCode!, body: bytes, json });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}
const put = (
  id: string,
  bytes: Buffer,
  name = `out/${id}.txt`,
  extra: Record<string, string> = {}
) =>
  call('PUT', `/spaces/a/objects/${id}`, bytes, {
    'x-storage-name': Buffer.from(name).toString('base64url'),
    'x-storage-length': String(bytes.length),
    'x-storage-sha256': hash(bytes),
    ...extra,
  });
const list = () => call('GET', '/spaces/a/objects?limit=100');
beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  await applyTestMigrations(stores.postgres);
  identity = await storageObjectIdentity();
  backend = await createFakeStorageS3({ bucket: 'task-output' });
});
afterAll(async () => {
  await backend.close();
  await identity.close();
  await stores.postgres.end();
  await stores.redis.quit();
  // This file owns this worker's database. Do not retain a whole migrated
  // database until suite exit: the disposable store has a finite tmpfs.
  const database = new URL(workerDatabaseUrl());
  const databaseName = database.pathname.slice(1);
  if (!/^lifemodel_test_worker_[0-9]+$/.test(databaseName)) throw Error('invalid test database');
  database.pathname = '/postgres';
  const admin = new Pool({ connectionString: database.toString(), max: 1 });
  admin.on('error', () => undefined);
  admin.on('connect', (client) => client.on('error', () => undefined));
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
});
beforeEach(async () => {
  await stores.postgres.query(
    'TRUNCATE task_access.projections,task_access.intents,storage.spaces CASCADE'
  );
  for (const id of ['a', 'b']) {
    await stores.postgres.query('INSERT INTO storage.spaces(id) VALUES($1)', [id]);
    await stores.postgres.query(
      "INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at) VALUES($1,$1,$1,0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')",
      [id]
    );
    await stores.postgres.query(
      "INSERT INTO task_access.projections SELECT task_id,attempt_id,launch_id,$2,$3,$1,0,0,'active',soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id=$1",
      [id, `job-${id}`, `pod-${id}`]
    );
  }
  backend.reset();
  identity.setReviewHook(undefined);
  await start();
});
import { afterEach } from 'vitest';
afterEach(stop);
describe('task immutable object API', () => {
  it('puts, reads, lists and marks 32 durable objects; retries lost ACK and survives restart', async () => {
    const receipts = [];
    for (let n = 0; n < 32; n++) {
      const bytes = Buffer.from(`object ${n}`);
      const reply = await put(`upload-${n}`, bytes);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        name: `out/upload-${n}.txt`,
        size: bytes.length,
        sha256: hash(bytes),
        mark: null,
      });
      receipts.push(reply.json);
      const marked = await call(
        'POST',
        `/spaces/a/objects/${reply.json.id}/mark`,
        Buffer.from('{"role":"artifact"}')
      );
      expect(marked.status).toBe(200);
      expect((await call('GET', `/spaces/a/objects/${reply.json.id}`)).body).toEqual(bytes);
    }
    const retry = await put('upload-0', Buffer.from('object 0'));
    expect(retry.status).toBe(200);
    expect(retry.json.id).toBe(receipts[0].id);
    await stop();
    await start();
    const page = await list();
    expect(page.status).toBe(200);
    expect(page.json.objects).toHaveLength(32);
    expect(page.json.objects.every((o: any) => o.mark === 'artifact')).toBe(true);
    expect(
      (
        await call(
          'POST',
          `/spaces/a/objects/${receipts[0].id}/mark`,
          Buffer.from('{"role":"artifact"}')
        )
      ).status
    ).toBe(200);
    expect((await put('upload-0', Buffer.from('object 0'))).json.id).toBe(receipts[0].id);
    expect(
      (
        await stores.postgres.query(
          "SELECT reserved_bytes::text,charged_bytes::text FROM storage.space_quota WHERE space_id='a'"
        )
      ).rows[0]
    ).toEqual({
      reserved_bytes: '0',
      charged_bytes: String(
        Array.from({ length: 32 }, (_, n) => Buffer.byteLength(`object ${n}`)).reduce(
          (a, b) => a + b,
          0
        )
      ),
    });
  }, 30_000);
  it.each(['name', 'length', 'hash'])('rejects conflicting uploadId %s', async (field) => {
    const bytes = Buffer.from('same');
    expect((await put('once', bytes)).status).toBe(200);
    const extra =
      field === 'length'
        ? { 'x-storage-length': '5' }
        : field === 'hash'
          ? { 'x-storage-sha256': '0'.repeat(64) }
          : {};
    expect(
      (await put('once', bytes, field === 'name' ? 'other.txt' : 'out/once.txt', extra)).status
    ).toBe(409);
    expect((await list()).json.objects).toHaveLength(1);
  });
  it.each(['short', 'surplus', 'hash'])('does not publish %s bytes', async (failure) => {
    const bytes = Buffer.from('payload');
    const extra =
      failure === 'short'
        ? { 'x-storage-length': '8' }
        : failure === 'surplus'
          ? { 'x-storage-length': '6' }
          : { 'x-storage-sha256': '0'.repeat(64) };
    const rejected = await put('bad', bytes, 'bad.txt', extra);
    expect(rejected.status).toBe(400);
    expect(rejected.json.error.code).toBe(failure === 'hash' ? 'hash_mismatch' : 'length_mismatch');
    expect((await list()).json.objects).toEqual([]);
  });
  it.each([
    '',
    '/absolute',
    '../escape',
    'a/../b',
    'a/./b',
    'a//b',
    'a/',
    'nul\0name',
    'control\nname',
    'a%2fb',
    'a%5Cb',
    'a\\b',
    'e\u0301.txt',
  ])('refuses unsafe display name %j', async (name) => {
    expect((await put('unsafe', Buffer.from('x'), name)).status).toBe(400);
    expect((await list()).json.objects).toEqual([]);
  });
  it('keeps both spaces confined and accepts only completed objects for mark', async () => {
    const reply = await put('own', Buffer.from('bytes'));
    expect(reply.status).toBe(200);
    expect(
      (await call('GET', `/spaces/b/objects/${reply.json.id}`, undefined, {}, 'b')).status
    ).toBe(404);
    expect((await call('GET', '/spaces/b/objects', undefined, {}, 'a')).status).toBe(403);
    expect(
      (await call('POST', '/spaces/a/objects/missing/mark', Buffer.from('{"role":"result"}')))
        .status
    ).toBe(404);
  });
  it('bounds ranges, cursors, listing and unknown selectors', async () => {
    const reply = await put('range', Buffer.from('0123456789'));
    expect(reply.status).toBe(200);
    const range = await call('GET', `/spaces/a/objects/${reply.json.id}`, undefined, {
      range: 'bytes=2-5',
    });
    expect(range.status).toBe(206);
    expect(range.body.toString()).toBe('2345');
    for (const range of ['bytes=0-4194304', 'bytes=-5', 'bytes=3-2', 'bytes=0-1,3-4'])
      expect(
        (await call('GET', `/spaces/a/objects/${reply.json.id}`, undefined, { range })).status
      ).toBe(416);
    for (const query of ['limit=101', 'limit=0', 'cursor=bad', 'bucket=other', 'prefix=root'])
      expect((await call('GET', `/spaces/a/objects?${query}`)).status).toBe(400);
    const first = await call('GET', '/spaces/a/objects?limit=1');
    expect(first.json.objects).toHaveLength(1);
    await put('second', Buffer.from('second'));
    const next = await call('GET', `/spaces/a/objects?limit=1&cursor=${first.json.nextCursor}`);
    expect(next.json.objects[0].id).not.toBe(reply.json.id);
  });
  it('reserves transactionally before accepting bytes, rejects quota and exposes tested lease expiry selection', async () => {
    await stores.postgres.query(
      "INSERT INTO storage.space_quota(space_id,limit_bytes) VALUES('a',5)"
    );
    const replies = await Promise.all([
      put('one', Buffer.from('1234')),
      put('two', Buffer.from('5678')),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 507]);
    expect((await list()).json.objects).toHaveLength(1);
    await stores.postgres.query(
      "UPDATE storage.space_quota SET limit_bytes=100 WHERE space_id='a'"
    );
    await put('incomplete', Buffer.from('x'), 'incomplete', { 'x-storage-length': '2' });
    expect(await objects.expiredUploads()).toEqual([]);
    await stores.postgres.query(
      "UPDATE storage.upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE upload_id='incomplete'"
    );
    expect((await objects.expiredUploads()).map((row) => row.uploadId)).toEqual(['incomplete']);
  });

  it('a crash after private S3 write never lists pending intents, and retry uses a fresh immutable key', async () => {
    let written!: () => void;
    const didWrite = new Promise<void>((resolve) => {
      written = resolve;
    });
    backend.hooks.afterWrite = () => {
      written();
      return 'hang';
    };
    const pending = put('crash', Buffer.from('surviving bytes'));
    void pending.catch(() => undefined);
    await didWrite;
    expect((await list()).json.objects).toEqual([]);
    const attempts = await stores.postgres.query(
      "SELECT s3_key FROM storage.upload_attempts WHERE upload_id='crash'"
    );
    expect(attempts.rows).toHaveLength(1);
    expect(backend.objects.has(attempts.rows[0].s3_key)).toBe(true);
    await stop();
    await expect(pending).rejects.toBeDefined();
    delete backend.hooks.afterWrite;
    await start();
    expect((await list()).json.objects).toEqual([]);
    const retry = await put('crash', Buffer.from('surviving bytes'));
    expect(retry.status).toBe(200);
    expect((await list()).json.objects).toHaveLength(1);
    const keys = (
      await stores.postgres.query(
        "SELECT s3_key FROM storage.upload_attempts WHERE upload_id='crash'"
      )
    ).rows.map((row) => row.s3_key);
    expect(new Set(keys).size).toBe(2);
  });
  it('a failed persistence/checksum check cannot publish or ACK', async () => {
    backend.hooks.beforeHead = () => ({
      status: 200,
      headers: { 'x-amz-checksum-sha256': Buffer.alloc(32).toString('base64') },
    });
    const failed = await put('verify', Buffer.from('private bytes'));
    expect(failed.status).toBe(503);
    expect((await list()).json.objects).toEqual([]);
    delete backend.hooks.beforeHead;
    expect((await put('verify', Buffer.from('private bytes'))).status).toBe(200);
  });
  it('a lost application ACK replays exactly the committed receipt without another backend PUT', async () => {
    const bytes = Buffer.from('ack');
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port,
          method: 'PUT',
          path: '/spaces/a/objects/lost',
          ca: identity.certificate.ca,
          headers: {
            authorization: 'Bearer a',
            'x-storage-name': Buffer.from('lost.txt').toString('base64url'),
            'x-storage-length': String(bytes.length),
            'x-storage-sha256': hash(bytes),
          },
        },
        (res) => {
          res.on('error', () => undefined);
          res.destroy();
          resolve();
        }
      );
      req.on('error', reject);
      req.end(bytes);
    });
    const saved = (
      await stores.postgres.query(
        "SELECT v.receipt FROM storage.object_versions v JOIN storage.upload_intents i ON i.object_id=v.object_id WHERE i.upload_id='lost'"
      )
    ).rows[0].receipt;
    const writes = backend.requests.filter((row) => row.method === 'PUT').length;
    const retry = await put('lost', bytes, 'lost.txt');
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual(saved);
    expect(backend.requests.filter((row) => row.method === 'PUT')).toHaveLength(writes);
  });
  it('rechecks authority on GET dispatch after a backend delay; no denied bytes escape', async () => {
    const bytes = Buffer.from('protected');
    const saved = await put('guarded', bytes);
    expect(saved.status).toBe(200);
    backend.hooks.beforeGet = async () => {
      await stores.postgres.query(
        "UPDATE task_access.intents SET mode='revoked',revision=revision+1 WHERE task_id='a'"
      );
    };
    const read = await call('GET', `/spaces/a/objects/${saved.json.id}`);
    expect(read.status).toBe(403);
    expect(read.body.includes(bytes)).toBe(false);
  });
  it('serializes simultaneous same-upload reservations and returns one receipt', async () => {
    const replies = await Promise.all([
      put('concurrent', Buffer.from('same')),
      put('concurrent', Buffer.from('same')),
    ]);
    expect(replies.map((row) => row.status)).toEqual([200, 200]);
    expect(replies[0].json).toEqual(replies[1].json);
    expect((await list()).json.objects).toHaveLength(1);
    expect(
      (
        await stores.postgres.query(
          "SELECT charged_bytes::text,reserved_bytes::text FROM storage.space_quota WHERE space_id='a'"
        )
      ).rows[0]
    ).toEqual({ charged_bytes: '4', reserved_bytes: '0' });
  });
  it('bounds request headers and mark body before consuming unbounded input', async () => {
    const reply = await put('body', Buffer.from('a'));
    expect(reply.status).toBe(200);
    expect(
      (await call('POST', `/spaces/a/objects/${reply.json.id}/mark`, Buffer.alloc(129, 32))).status
    ).toBe(413);
    expect((await put('longname', Buffer.from('a'), 'a'.repeat(1025))).status).toBe(400);
    expect(
      (
        await put('invalidutf', Buffer.from('a'), 'name', {
          'x-storage-name': Buffer.from([0xff]).toString('base64url'),
        })
      ).status
    ).toBe(400);
  });

  it('survives a real dropped Postgres TCP connection and reports unavailable, never empty', async () => {
    const upstream = new URL(workerDatabaseUrl());
    const sockets = new Set<Socket>();
    const upstreamHost = upstream.hostname;
    const upstreamPort = Number(upstream.port || 5432);
    let drop = false;
    const proxy = createTcpServer((front) => {
      sockets.add(front);
      front.on('error', () => undefined);
      front.on('close', () => sockets.delete(front));
      const back = connect({ host: upstreamHost, port: upstreamPort });
      sockets.add(back);
      back.on('error', () => front.destroy());
      back.on('close', () => {
        sockets.delete(back);
        front.destroy();
      });
      front.on('data', (bytes) => {
        if (drop) {
          front.destroy();
          back.destroy();
        } else back.write(bytes);
      });
      back.on('data', (bytes) => front.write(bytes));
    });
    proxy.on('error', () => undefined);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw Error('no proxy');
    upstream.hostname = '127.0.0.1';
    upstream.port = String(address.port);
    const broken = createStorageObjects({
      connectionString: upstream.toString(),
      s3,
      timeoutMs: 200,
    });
    try {
      expect(await broken.expiredUploads()).toEqual([]);
      drop = true;
      await expect(broken.expiredUploads()).rejects.toMatchObject({
        status: 503,
        code: 'catalog_unavailable',
        id: expect.any(String),
      });
      expect((await list()).status).toBe(200);
    } finally {
      await broken.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('streams a large GET across bounded guarded chunks without losing a drain event', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 97);
    const saved = await put('large', bytes);
    expect(saved.status).toBe(200);
    const before = identity.reviews;
    const read = await call('GET', `/spaces/a/objects/${saved.json.id}`);
    expect(read.status).toBe(200);
    expect(read.body.length).toBe(bytes.length);
    expect(hash(read.body)).toBe(hash(bytes));
    expect(identity.reviews - before).toBeGreaterThan(2);
  }, 30_000);
  it('revoke cancels a stalled mark body rather than waiting for the client', async () => {
    const saved = await put('stalled', Buffer.from('a'));
    expect(saved.status).toBe(200);
    const before = identity.reviews;
    const requestBody = new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port,
          method: 'POST',
          path: `/spaces/a/objects/${saved.json.id}/mark`,
          ca: identity.certificate.ca,
          headers: { authorization: 'Bearer a', 'content-length': '10' },
        },
        (res) => {
          res.on('error', () => undefined);
          res.resume();
          res.on('end', () => reject(Error('unexpected ACK')));
        }
      );
      req.on('error', () => resolve());
      req.write('{');
      void (async () => {
        await expect.poll(() => identity.reviews).toBeGreaterThan(before);
        await access.revoke('a', '0', 'stalled-mark');
      })().catch(reject);
    });
    await requestBody;
  });

  it('readiness requires object DDL, including publication functions', async () => {
    expect(await objects.check(new AbortController().signal)).toBe(true);
    await stores.postgres.query(
      'ALTER FUNCTION storage.complete_upload(text,text,uuid) RENAME TO unavailable_complete_upload'
    );
    try {
      expect(await objects.check(new AbortController().signal)).toBe(false);
    } finally {
      await stores.postgres.query(
        'ALTER FUNCTION storage.unavailable_complete_upload(text,text,uuid) RENAME TO complete_upload'
      );
    }
  });
  it('rejects cursor overflow as input error, not a failed catalog', async () => {
    const cursor = Buffer.from(JSON.stringify(['a', '9999999999999999999'])).toString('base64url');
    expect((await call('GET', `/spaces/a/objects?cursor=${cursor}`)).status).toBe(400);
  });

  it('the shipped CLI puts, lists, marks and gets through the real module and catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'storage-cli-module-'));
    try {
      await writeFile(join(directory, 'token'), 'a');
      await writeFile(join(directory, 'ca'), identity.certificate.ca);
      await writeFile(join(directory, 'input.txt'), 'cli bytes');
      let output = '';
      let error = '';
      const options = {
        cwd: directory,
        env: {
          LIFEMODEL_STORAGE_ENDPOINT: `https://localhost:${port}`,
          LIFEMODEL_STORAGE_SPACE: 'a',
          LIFEMODEL_STORAGE_TOKEN_FILE: join(directory, 'token'),
          LIFEMODEL_STORAGE_CA_FILE: join(directory, 'ca'),
        },
        stdout: (text: string) => {
          output = text;
        },
        stderr: (text: string) => {
          error = text;
        },
      };
      expect(await runStorageCli(['put', 'input.txt', '--upload-id', 'cli'], options), error).toBe(
        0
      );
      const receipt = JSON.parse(output);
      expect(await runStorageCli(['mark', receipt.id, 'result'], options), error).toBe(0);
      expect(await runStorageCli(['list'], options), error).toBe(0);
      expect(JSON.parse(output).objects).toEqual([{ ...receipt, mark: 'result' }]);
      expect(await runStorageCli(['get', receipt.id, 'download.txt'], options), error).toBe(0);
      expect(await readFile(join(directory, 'download.txt'), 'utf8')).toBe('cli bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('no second GET chunk dispatches after revoke ACK', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 120);
    const saved = await put('mid-read', bytes);
    expect(saved.status).toBe(200);
    let reads = 0;
    backend.hooks.beforeGet = async () => {
      reads++;
      if (reads === 2) await access.revoke('a', '0', 'get-after-first');
    };
    const seen: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port,
          method: 'GET',
          path: `/spaces/a/objects/${saved.json.id}`,
          ca: identity.certificate.ca,
          headers: { authorization: 'Bearer a' },
        },
        (res) => {
          res.on('data', (part) => seen.push(Buffer.from(part)));
          res.on('error', () => resolve());
          res.on('aborted', () => resolve());
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(reads).toBe(2);
    expect(Buffer.concat(seen).length).toBe(4 * 1024 * 1024);
  }, 30_000);

  it('coalesces incoming TCP fragments into bounded PUT authorization chunks', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 121);
    const before = identity.reviews;
    const saved = await put('bounded-put', bytes);
    expect(saved.status).toBe(200);
    // Initial operation, reservation, attempt, two chunks, publication, ACK.
    expect(identity.reviews - before).toBe(7);
  }, 30_000);

  it('supports an empty immutable object and never turns its display name into a backend key', async () => {
    const saved = await put('empty', Buffer.alloc(0), 'quote".txt');
    expect(saved.status).toBe(200);
    expect((await call('GET', `/spaces/a/objects/${saved.json.id}`)).body).toEqual(Buffer.alloc(0));
    expect([...backend.objects.keys()].every((key) => /^private\/[0-9a-f-]+$/.test(key))).toBe(
      true
    );
    expect(
      (await call('POST', `/spaces/a/objects/${saved.json.id}/mark`, Buffer.from('{"role":"log"}')))
        .status
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/spaces/a/objects/${saved.json.id}/mark`,
          Buffer.from('{"role":"result"}')
        )
      ).status
    ).toBe(409);
  });
});
