import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
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
const payload = Buffer.from('payload');
let stores: TestStores;
let identity: Awaited<ReturnType<typeof storageObjectIdentity>>;
let backend: Awaited<ReturnType<typeof createFakeStorageS3>>;
let app: ReturnType<typeof createStorageModule>;
let objects: ReturnType<typeof createStorageObjects>;
let s3: ReturnType<typeof createStorageObjectS3>;
let port: number;

async function put(id: string, bytes = payload, name = 'output.txt') {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        port,
        method: 'PUT',
        path: `/spaces/a/objects/${id}`,
        ca: identity.certificate.ca,
        headers: {
          authorization: 'Bearer a',
          'x-storage-name': Buffer.from(name).toString('base64url'),
          'x-storage-length': String(payload.length),
          'x-storage-sha256': hash(payload),
        },
      },
      (res) => {
        res.on('error', reject);
        const chunks: Buffer[] = [];
        res.on('data', (part) => chunks.push(part));
        res.on('end', () =>
          resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString()) })
        );
      }
    );
    req.on('error', reject);
    req.end(bytes);
  });
}
async function ledger() {
  return (
    await stores.postgres.query(
      "SELECT reserved_bytes::text,charged_bytes::text FROM storage.space_quota WHERE space_id='a'"
    )
  ).rows[0];
}
async function pending(id: string) {
  await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,$7)', [
    'a',
    id,
    randomUUID(),
    'output.txt',
    payload.length,
    hash(payload),
    3600,
  ]);
}
async function attempt(id: string) {
  const value = randomUUID();
  await stores.postgres.query(
    'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
    [value, 'a', id, `private/${randomUUID()}`]
  );
  return value;
}
async function complete(id: string, value: string) {
  return (
    await stores.postgres.query('SELECT storage.complete_upload($1,$2,$3) AS status', [
      'a',
      id,
      value,
    ])
  ).rows[0].status;
}
async function release(id: string) {
  await stores.postgres.query('SELECT storage.release_upload($1,$2)', ['a', id]);
}

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
beforeEach(async ({ task }) => {
  await stores.postgres.query(
    'TRUNCATE task_access.projections,task_access.intents,storage.spaces CASCADE'
  );
  await stores.postgres.query("INSERT INTO storage.spaces(id) VALUES('a')");
  await stores.postgres.query(
    "INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at) VALUES('a','a','a',0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')"
  );
  await stores.postgres.query(
    "INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) SELECT task_id,attempt_id,launch_id,'job-a','pod-a','a',0,0,'active',soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id='a'"
  );
  await stores.postgres.query(
    "INSERT INTO storage.space_quota(space_id,limit_bytes) VALUES('a',7)"
  );
  backend.reset();
  identity.setReviewHook(undefined);
  const access = createStorageAccess({
    connectionString: workerDatabaseUrl(),
    identity: identity.identity,
  });
  s3 = createStorageObjectS3({
    endpoint: backend.endpoint,
    bucket: 'task-output',
    custody: { read: async () => backend.credentials },
    timeoutMs: task.name.includes('request deadline') ? 10_000 : 300,
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
});
afterEach(async () => {
  app.task.close();
  app.control.close();
  app.read.close();
  await objects.close();
  s3.close();
  await stores.postgres.query('DROP TRIGGER IF EXISTS reject_object ON storage.objects');
  await stores.postgres.query('DROP TRIGGER IF EXISTS notify_release ON storage.space_quota');
});

describe('failed object upload quota recovery', () => {
  it.each(['short', 'surplus', 'hash', 's3', 'head', 'publish', 'timeout'] as const)(
    'releases a %s failure, preserves conflicts and re-reserves the same upload ID',
    async (failure) => {
      let sent = payload;
      if (failure === 'short') sent = payload.subarray(1);
      if (failure === 'surplus') sent = Buffer.concat([payload, Buffer.from('!')]);
      if (failure === 'hash') sent = Buffer.from('PAYLOAD');
      if (failure === 's3') backend.hooks.beforePut = () => ({ status: 503 });
      if (failure === 'head') backend.hooks.beforeHead = () => ({ status: 503 });
      if (failure === 'timeout') backend.hooks.beforeHead = () => 'hang';
      if (failure === 'publish') {
        await stores.postgres.query(
          "CREATE OR REPLACE FUNCTION storage.test_reject_object() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected publication failure'; END $$"
        );
        await stores.postgres.query(
          'CREATE TRIGGER reject_object BEFORE INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.test_reject_object()'
        );
      }
      const rejected = await put('retry', sent);
      expect(rejected.status).toBe(['short', 'surplus', 'hash'].includes(failure) ? 400 : 503);
      expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '0' });
      expect((await stores.postgres.query('SELECT id FROM storage.objects')).rows).toEqual([]);
      // A released intent still owns its original immutable metadata. A conflicting
      // retry must not take quota before the conflict is detected.
      expect((await put('retry', payload, 'changed.txt')).status).toBe(409);
      expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '0' });
      backend.reset();
      await stores.postgres.query('DROP TRIGGER IF EXISTS reject_object ON storage.objects');
      expect((await put('retry')).status).toBe(200);
      expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '7' });
      expect((await put('retry')).status).toBe(200);
      expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '7' });
    }
  );

  it('releases after the HTTP request aborts using fresh guarded authority', async () => {
    // Observe the committed release, not a timer or a fixed number of polls.
    const observer = await stores.postgres.connect();
    observer.on('error', () => undefined);
    await observer.query('LISTEN storage_quota_released');
    await stores.postgres.query(
      "CREATE OR REPLACE FUNCTION storage.test_notify_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.reserved_bytes > 0 AND NEW.reserved_bytes = 0 THEN PERFORM pg_notify('storage_quota_released','released'); END IF; RETURN NEW; END $$"
    );
    await stores.postgres.query(
      'CREATE TRIGGER notify_release AFTER UPDATE ON storage.space_quota FOR EACH ROW EXECUTE FUNCTION storage.test_notify_release()'
    );
    const released = once(observer, 'notification', { signal: AbortSignal.timeout(3000) });
    void released.catch(() => undefined);
    let abort!: () => void;
    backend.hooks.beforeHead = () => {
      abort();
      return 'hang';
    };
    const before = identity.reviews;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            hostname: 'localhost',
            port,
            method: 'PUT',
            path: '/spaces/a/objects/aborted',
            ca: identity.certificate.ca,
            headers: {
              authorization: 'Bearer a',
              'x-storage-name': Buffer.from('output.txt').toString('base64url'),
              'x-storage-length': String(payload.length),
              'x-storage-sha256': hash(payload),
            },
          },
          (res) => {
            res.resume();
            reject(Error('unexpected ACK'));
          }
        );
        req.on('error', () => resolve());
        abort = () => req.destroy();
        req.end(payload);
      });
      await released;
      expect(identity.reviews).toBeGreaterThan(before + 3);
      expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '0' });
      backend.reset();
      expect((await put('aborted')).status).toBe(200);
    } finally {
      await observer.query('UNLISTEN storage_quota_released');
      observer.release();
    }
  }, 15_000);

  it('recovers when disconnect races the original guarded release', async () => {
    const observer = await stores.postgres.connect();
    observer.on('error', () => undefined);
    await observer.query('LISTEN storage_quota_released');
    await stores.postgres.query(
      "CREATE OR REPLACE FUNCTION storage.test_notify_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.reserved_bytes > 0 AND NEW.reserved_bytes = 0 THEN PERFORM pg_notify('storage_quota_released','released'); END IF; RETURN NEW; END $$"
    );
    await stores.postgres.query(
      'CREATE TRIGGER notify_release AFTER UPDATE ON storage.space_quota FOR EACH ROW EXECUTE FUNCTION storage.test_notify_release()'
    );
    const released = once(observer, 'notification', { signal: AbortSignal.timeout(3000) });
    void released.catch(() => undefined);
    const before = identity.reviews;
    let disconnected!: Promise<unknown[]>;
    app.task.server.once('request', (_req, res) => {
      disconnected = once(res, 'close', { signal: AbortSignal.timeout(3000) });
    });
    let input: ReturnType<typeof request> | undefined;
    identity.setReviewHook(async () => {
      // Opening authorization, reservation, attempt, byte dispatch, then release.
      // Disconnect after release chose the live original stream, during its fresh
      // identity proof. The catch must retry through a new guarded stream once.
      if (identity.reviews === before + 5) {
        input?.destroy();
        await disconnected;
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        input = request(
          {
            hostname: 'localhost',
            port,
            method: 'PUT',
            path: '/spaces/a/objects/raced',
            ca: identity.certificate.ca,
            headers: {
              authorization: 'Bearer a',
              'x-storage-name': Buffer.from('output.txt').toString('base64url'),
              'x-storage-length': String(payload.length),
              'x-storage-sha256': hash(payload),
            },
          },
          (res) => {
            res.resume();
            reject(Error('unexpected response'));
          }
        );
        input.on('error', () => resolve());
        input.end(Buffer.from('PAYLOAD'));
      });
      await released;
      expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '0' });
      identity.setReviewHook(undefined);
      expect((await put('raced')).status).toBe(200);
    } finally {
      input?.destroy();
      identity.setReviewHook(undefined);
      await observer.query('UNLISTEN storage_quota_released');
      observer.release();
    }
  });

  it('releases after the request deadline aborts a stalled upload body', async () => {
    const observer = await stores.postgres.connect();
    observer.on('error', () => undefined);
    await observer.query('LISTEN storage_quota_released');
    await stores.postgres.query(
      "CREATE OR REPLACE FUNCTION storage.test_notify_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.reserved_bytes > 0 AND NEW.reserved_bytes = 0 THEN PERFORM pg_notify('storage_quota_released','released'); END IF; RETURN NEW; END $$"
    );
    await stores.postgres.query(
      'CREATE TRIGGER notify_release AFTER UPDATE ON storage.space_quota FOR EACH ROW EXECUTE FUNCTION storage.test_notify_release()'
    );
    const released = once(observer, 'notification', { signal: AbortSignal.timeout(12_000) });
    void released.catch(() => undefined);
    const started = performance.now();
    let input: ReturnType<typeof request> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        input = request(
          {
            hostname: 'localhost',
            port,
            method: 'PUT',
            path: '/spaces/a/objects/deadline',
            ca: identity.certificate.ca,
            headers: {
              authorization: 'Bearer a',
              'content-length': String(payload.length),
              'x-storage-name': Buffer.from('output.txt').toString('base64url'),
              'x-storage-length': String(payload.length),
              'x-storage-sha256': hash(payload),
            },
          },
          (res) => {
            res.resume();
            reject(Error(`unexpected response ${String(res.statusCode)}`));
          }
        );
        input.on('error', () => resolve());
        // Never finish this authorization chunk. Only the module's request
        // no-progress deadline can close the caller without a 503 response.
        input.write(payload.subarray(0, 1));
      });
      await released;
      expect(performance.now() - started).toBeLessThan(12_000);
      expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '0' });
      expect((await put('deadline')).status).toBe(200);
    } finally {
      input?.destroy();
      await observer.query('UNLISTEN storage_quota_released');
      observer.release();
    }
  }, 15_000);

  it('checks the completion status instead of inferring success from a missing receipt', async () => {
    backend.hooks.beforeHead = async () => {
      await stores.postgres.query(
        "DELETE FROM storage.upload_intents WHERE space_id='a' AND upload_id='vanished'"
      );
      return undefined;
    };
    const rejected = await put('vanished');
    expect(rejected.status).toBe(503);
    expect(rejected.json.error.code).toBe('completion_failed');
  });

  it('makes release idempotent and refuses to charge without capacity after release', async () => {
    await pending('one');
    const value = await attempt('one');
    await release('one');
    await release('one');
    expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '0' });
    await pending('two');
    await expect(complete('one', value)).rejects.toBeDefined();
    expect(await ledger()).toEqual({ reserved_bytes: '7', charged_bytes: '0' });
    await release('two');
    expect(await complete('one', value)).toBe('completed');
    await release('one');
    expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '7' });
  });

  it('serializes concurrent release and completion without underflow or double charge', async () => {
    await pending('race');
    const value = await attempt('race');
    const [, status] = await Promise.all([release('race'), complete('race', value)]);
    expect(status).toBe('completed');
    expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '7' });
    expect(await complete('race', value)).toBe('already_completed');
    await release('race');
    expect(await ledger()).toEqual({ reserved_bytes: '0', charged_bytes: '7' });
  });

  it('returns explicit completion outcomes for unknown intents and mismatched attempts', async () => {
    expect(await complete('missing', randomUUID())).toBe('intent_unknown');
    await pending('one');
    expect(await complete('one', randomUUID())).toBe('attempt_unknown');
    const value = await attempt('one');
    expect(await complete('one', value)).toBe('completed');
    expect(await complete('one', value)).toBe('already_completed');
  });

  it('pins catalog function search paths and removes PUBLIC execute while the module owner retains execute', async () => {
    // The current module login owns migrations/functions (lifemodel-2t5 splits
    // roles later). Revoking PUBLIC leaves that owner permission intact.
    const rows = (
      await stores.postgres.query(`SELECT p.proname,p.proconfig,
      has_function_privilege(current_user,p.oid,'EXECUTE') AS owner_exec,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='storage' AND p.proname IN ('reserve_upload','release_upload','complete_upload') ORDER BY p.proname`)
    ).rows;
    expect(rows.map((row) => row.proname)).toEqual([
      'complete_upload',
      'release_upload',
      'reserve_upload',
    ]);
    for (const row of rows) {
      expect(row.proconfig).toContain('search_path=pg_catalog, pg_temp');
      expect(row.owner_exec).toBe(true);
      expect(row.public_exec).toBe(false);
    }
  });
});
