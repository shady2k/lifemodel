import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createStorageSeal } from '../../loader/src/storage-seal.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createSealIdentity } from '../helpers/storage-seal-identity.js';
import { createSealS3 } from '../helpers/storage-seal-s3.js';
import { createSealSqlProxy } from '../helpers/storage-seal-sql-proxy.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Reply = { status: number; body: Buffer; json: any };
type ObjectReceipt = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: string | null;
};
let stores: TestStores;
let identity: Awaited<ReturnType<typeof createSealIdentity>>;
let backend: Awaited<ReturnType<typeof createSealS3>>;
let sqlProxy: Awaited<ReturnType<typeof createSealSqlProxy>>;
let root: string;
let configFile: string;
let child: ChildProcess | undefined;
let ports: Record<'task' | 'control' | 'read', number>;
let spaces: Record<string, string>;
const children = new Set<ChildProcess>();
const releases: Array<() => void> = [];
const lockers = new Set<PoolClient>();

async function start() {
  const processChild = fork(
    fileURLToPath(new URL('../fixtures/storage-seal-child.ts', import.meta.url)),
    [configFile],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
  processChild.on('error', () => undefined);
  processChild.stdout?.on('error', () => undefined);
  processChild.stderr?.on('error', () => undefined);
  children.add(processChild);
  processChild.once('exit', () => children.delete(processChild));
  child = processChild;
  ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('storage child startup deadline')), 15_000);
    processChild.once('message', (message: any) => {
      clearTimeout(timer);
      resolve(message.ready);
    });
    processChild.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(Error(`storage child exited ${code ?? signal}`));
    });
    processChild.once('error', () => {
      clearTimeout(timer);
      reject(Error('storage child start failed'));
    });
  });
}
async function kill() {
  if (!child) return;
  const processChild = child;
  child = undefined;
  if (processChild.exitCode !== null || processChild.signalCode !== null) return;
  const exited = once(processChild, 'exit');
  expect(processChild.kill('SIGKILL')).toBe(true);
  const [, signal] = await exited;
  expect(signal).toBe('SIGKILL');
}
async function call(
  listener: keyof typeof ports,
  method: string,
  path: string,
  value?: unknown,
  token = listener === 'control' ? 'core' : listener === 'read' ? 'coreRead' : 'a',
  headers: Record<string, string> = {}
): Promise<Reply> {
  const body = Buffer.isBuffer(value)
    ? value
    : value === undefined
      ? undefined
      : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        port: ports[listener],
        path,
        method,
        ca: identity.certificate.ca,
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-length': String(body.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        res.on('error', reject);
        const chunks: Buffer[] = [];
        res.on('data', (b) => chunks.push(Buffer.from(b)));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json: any;
          try {
            json = JSON.parse(bytes.toString());
          } catch {
            /* object bytes */
          }
          resolve({ status: res.statusCode!, body: bytes, json });
        });
      }
    );
    req.on('socket', (socket) => socket.on('error', () => undefined));
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(Error('test request deadline')));
    req.end(body);
  });
}
const allocateInput = (task: string, effectKey = `allocate-${task}`) => ({
  taskId: task,
  launchId: task,
  effectKey,
  retentionRevision: 'retention-1',
});
const bindInput = (task: string, effectKey = `bind-${task}`) => ({
  space: spaces[task],
  taskId: task,
  attemptId: task,
  launchId: task,
  effectKey,
});
const sealInput = (task = 'a', outcome = 'completed', effectKey = `seal-${task}`) => ({
  space: spaces[task],
  effectKey,
  expectedRevision: '0',
  outcome,
});
const marked = (data: Awaited<ReturnType<typeof populate>>, task = 'a') =>
  data[task]
    .slice(0, 4)
    .map((o) => o.receipt)
    .sort((a, b) => a.id.localeCompare(b.id));
async function allocate(task: string) {
  const reply = await call('control', 'POST', '/allocate', allocateInput(task));
  expect(reply.status).toBe(200);
  expect(reply.json).toMatchObject({
    id: expect.any(String),
    space: expect.any(String),
    effectKey: `allocate-${task}`,
  });
  spaces[task] = reply.json.space;
  return reply.json;
}
async function project(task: string) {
  await stores.postgres.query(
    `INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at)
    VALUES($1,$1,$1,0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')`,
    [task]
  );
  await stores.postgres.query(
    `INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at,pod_name,job_name)
    SELECT task_id,attempt_id,launch_id,$2,$3,$4,0,0,'active',soft_due_at,hard_stop_at,$1,$2 FROM task_access.intents WHERE task_id=$1`,
    [task, `job-${task}`, `pod-${task}`, spaces[task]]
  );
}
async function bind(task: string) {
  const reply = await call('control', 'POST', '/bind', bindInput(task));
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return reply.json;
}
async function prepare() {
  for (const task of ['a', 'b']) {
    await allocate(task);
    await project(task);
    await bind(task);
  }
}
async function put(task: string, id: string, bytes: Buffer) {
  return call('task', 'PUT', `/spaces/${spaces[task]}/objects/${id}`, bytes, task, {
    'x-storage-name': Buffer.from(`${task}/${id}.txt`).toString('base64url'),
    'x-storage-length': String(bytes.length),
    'x-storage-sha256': hash(bytes),
  });
}
async function populate() {
  const data: Record<string, Array<{ receipt: ObjectReceipt; bytes: Buffer }>> = { a: [], b: [] };
  for (let n = 0; n < 8; n++)
    for (const task of ['a', 'b']) {
      const bytes = Buffer.from(`${task} private immutable bytes ${n}`);
      const uploaded = await put(task, `upload-${n}`, bytes);
      expect(uploaded.status).toBe(200);
      let receipt = uploaded.json;
      if (n < 4) {
        const marked = await call(
          'task',
          'POST',
          `/spaces/${spaces[task]}/objects/${receipt.id}/mark`,
          { role: n === 0 ? 'result' : 'artifact' },
          task
        );
        expect(marked.status).toBe(200);
        receipt = marked.json;
      }
      data[task].push({ receipt, bytes });
    }
  return data;
}
async function lock(sql: string, values: unknown[] = []) {
  const client = await stores.postgres.connect();
  client.on('error', () => undefined);
  lockers.add(client);
  await client.query('BEGIN');
  await client.query(sql, values);
  return client;
}
async function unlock(client: PoolClient) {
  await client.query('ROLLBACK');
  lockers.delete(client);
  client.release();
}
async function waitBlocked(client: PoolClient) {
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await expect
    .poll(
      async () =>
        (
          await stores.postgres.query(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
            [pid]
          )
        ).rows[0].n,
      { timeout: 4000 }
    )
    .toBeGreaterThan(0);
}
async function manifest(task = 'a') {
  return (
    await stores.postgres.query(
      'SELECT id,version::float8 AS version,sha256,objects,reason FROM storage.seal_manifests WHERE space_id=$1',
      [spaces[task]]
    )
  ).rows[0];
}
async function assertFrozen(task = 'a') {
  const row = (
    await stores.postgres.query(
      'SELECT mode,access_revision::text AS revision FROM storage.spaces WHERE id=$1',
      [spaces[task]]
    )
  ).rows[0];
  expect(['frozen', 'sealed']).toContain(row.mode);
  expect(row.revision).toBe('1');
  for (const method of ['GET', 'POST']) {
    const path =
      method === 'GET'
        ? `/spaces/${spaces[task]}/objects`
        : `/spaces/${spaces[task]}/objects/missing/mark`;
    expect(
      (await call('task', method, path, method === 'POST' ? { role: 'artifact' } : undefined, task))
        .status
    ).toBe(403);
  }
  expect((await put(task, 'late-write', Buffer.from('late'))).status).toBe(403);
}
async function assertSealed(receipt: any, data: Awaited<ReturnType<typeof populate>>, task = 'a') {
  expect(receipt).toMatchObject({
    id: expect.any(String),
    space: spaces[task],
    effectKey: `seal-${task}`,
    revision: '1',
    outcome: 'completed',
    state: 'sealed',
    reason: null,
    manifest: {
      id: expect.any(String),
      version: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
  });
  expect(receipt.manifest.objects).toEqual(marked(data, task));
  const canonicalObjects = receipt.manifest.objects.map((o: ObjectReceipt) => ({
    id: o.id,
    name: o.name,
    size: o.size,
    sha256: o.sha256,
    mark: o.mark,
  }));
  expect(receipt.manifest.sha256).toBe(
    hash(Buffer.from(JSON.stringify({ version: 1, objects: canonicalObjects })))
  );
  expect(await manifest(task)).toMatchObject(receipt.manifest);
  await assertFrozen(task);
  const listed = await call('read', 'GET', `/spaces/${spaces[task]}/objects?limit=100`);
  expect(listed.status).toBe(200);
  expect(listed.json.objects).toEqual(data[task].slice(0, 4).map((o) => o.receipt));
  for (let n = 0; n < 8; n++) {
    const item = data[task][n];
    const read = await call('read', 'GET', `/spaces/${spaces[task]}/objects/${item.receipt.id}`);
    expect(read.status).toBe(n < 4 ? 200 : 404);
    if (n < 4) expect(read.body).toEqual(item.bytes);
    expect(
      (
        await call(
          'task',
          'GET',
          `/spaces/${spaces[task]}/objects/${item.receipt.id}`,
          undefined,
          task
        )
      ).status
    ).toBe(403);
  }
  const quota = (
    await stores.postgres.query(
      'SELECT reserved_bytes::text,charged_bytes::text FROM storage.space_quota WHERE space_id=$1',
      [spaces[task]]
    )
  ).rows[0];
  expect(quota).toEqual({
    reserved_bytes: '0',
    charged_bytes: String(data[task].slice(0, 4).reduce((n, o) => n + o.bytes.length, 0)),
  });
}

beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
  identity = await createSealIdentity();
  backend = await createSealS3({ bucket: 'task-output' });
  sqlProxy = await createSealSqlProxy(workerDatabaseUrl());
  root = await mkdtemp(join(tmpdir(), 'storage-seal-process-'));
  configFile = join(root, 'config.json');
  await writeFile(
    configFile,
    JSON.stringify({
      connectionString: sqlProxy.connectionString,
      identity: identity.options,
      endpoint: backend.endpoint,
      credentials: backend.credentials,
      certificate: identity.certificate,
    }),
    { mode: 0o600 }
  );
}, 30_000);
beforeEach(async () => {
  await stores.postgres.query(
    'TRUNCATE task_access.projections,task_access.intents,storage.spaces CASCADE'
  );
  spaces = {};
  sqlProxy.restore();
  backend.reset();
  identity.deadPods.clear();
  identity.deadJobs.clear();
  identity.calls.splice(0);
  await start();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await kill();
  for (const client of [...lockers]) await unlock(client);
}, 20_000);
afterAll(async () => {
  for (const processChild of children) processChild.kill('SIGKILL');
  await sqlProxy?.close();
  await backend?.close();
  await identity?.close();
  await stores?.postgres.end();
  await stores?.redis.quit();
  if (root) await rm(root, { recursive: true, force: true });
}, 20_000);

describe('module-owned allocation, verified binding and marked core reads', () => {
  it('core read decisions carry the actual locked revision and storage mode', async () => {
    await prepare();
    const s3 = createStorageObjectS3({
      endpoint: backend.endpoint,
      bucket: backend.bucket,
      custody: { read: async () => backend.credentials },
    });
    const access = createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: createKubernetesStorageIdentity(identity.options),
    });
    const seal = createStorageSeal({ connectionString: workerDatabaseUrl(), s3, access });
    const stream = seal.openCoreStream({ token: 'coreRead', space: spaces.a });
    try {
      for (const mode of ['wrapping', 'frozen', 'sealed']) {
        await stores.postgres.query(
          'UPDATE storage.spaces SET access_revision=7,mode=$2 WHERE id=$1',
          [spaces.a, mode]
        );
        let decision: unknown;
        await stream.chunk(0, (value) => {
          decision = value;
          return undefined;
        });
        expect(decision).toEqual({ space: spaces.a, revision: '7', mode });
      }
    } finally {
      stream.close();
      await seal.close();
      s3.close();
    }
  });

  it('allocates once per launch, replays exact receipts and conflicts on changed keyed inputs', async () => {
    const first = await allocate('a');
    expect((await call('control', 'POST', '/allocate', allocateInput('a'))).json).toEqual(first);
    const anotherKey = await call('control', 'POST', '/allocate', allocateInput('a', 'other-key'));
    expect(anotherKey.status).toBe(200);
    expect(anotherKey.json.space).toBe(first.space);
    expect(
      (await call('control', 'POST', '/allocate', { ...allocateInput('a'), taskId: 'other' }))
        .status
    ).toBe(409);
    expect(
      (
        await call('control', 'POST', '/allocate', {
          ...allocateInput('a', 'changed-retention'),
          retentionRevision: 'retention-2',
        })
      ).status
    ).toBe(409);
    expect(
      (await stores.postgres.query('SELECT count(*)::int AS n FROM storage.spaces')).rows[0].n
    ).toBe(1);
    await kill();
    await start();
    expect((await call('control', 'POST', '/allocate', allocateInput('a'))).json).toEqual(first);
  });
  it('binds only a verified live projection, once, without trusting core names or UIDs', async () => {
    await allocate('a');
    expect((await call('control', 'POST', '/bind', bindInput('a'))).status).toBe(403);
    await project('a');
    for (const dead of [identity.deadPods, identity.deadJobs]) {
      dead.add(dead === identity.deadPods ? 'a' : 'job-a');
      expect((await call('control', 'POST', '/bind', bindInput('a'))).status).toBe(403);
      dead.clear();
    }
    await stores.postgres.query(
      'UPDATE task_access.projections SET pod_name=NULL WHERE space_id=$1',
      [spaces.a]
    );
    expect((await call('control', 'POST', '/bind', bindInput('a'))).status).toBe(403);
    await stores.postgres.query(
      "UPDATE task_access.projections SET pod_name='a' WHERE space_id=$1",
      [spaces.a]
    );
    for (const [column, value] of [
      ['pod_name', '../a'],
      ['job_name', 'JOB-A'],
      ['pod_uid', 'replacement-pod'],
      ['job_uid', 'replacement-job'],
    ] as const) {
      const original =
        column === 'pod_name'
          ? 'a'
          : column === 'job_name' || column === 'job_uid'
            ? 'job-a'
            : 'pod-a';
      // Test-owned SQL column names are fixed literals, never supplied to the module.
      await stores.postgres.query(
        `UPDATE task_access.projections SET ${column}=$1 WHERE space_id=$2`,
        [value, spaces.a]
      );
      expect((await call('control', 'POST', '/bind', bindInput('a'))).status).toBe(403);
      await stores.postgres.query(
        `UPDATE task_access.projections SET ${column}=$1 WHERE space_id=$2`,
        [original, spaces.a]
      );
    }
    await stores.postgres.query(
      'UPDATE task_access.projections SET access_revision=1 WHERE space_id=$1',
      [spaces.a]
    );
    expect((await call('control', 'POST', '/bind', bindInput('a'))).status).toBe(403);
    await stores.postgres.query(
      'UPDATE task_access.projections SET access_revision=0 WHERE space_id=$1',
      [spaces.a]
    );
    const first = await bind('a');
    expect((await call('control', 'POST', '/bind', bindInput('a'))).json).toEqual(first);
    expect(
      (await call('control', 'POST', '/bind', { ...bindInput('a'), attemptId: 'other' })).status
    ).toBe(409);
    expect(
      (
        await call('control', 'POST', '/bind', {
          ...bindInput('a', 'second-bind'),
          attemptId: 'other',
        })
      ).status
    ).toBe(409);
    expect(
      (await call('control', 'POST', '/bind', { ...bindInput('a'), podUid: 'pod-a' })).status
    ).toBe(400);
    expect(
      (
        await call('control', 'POST', '/bind', {
          ...bindInput('a'),
          podName: 'a',
          jobName: 'job-a',
        })
      ).status
    ).toBe(400);
    await kill();
    await start();
    expect((await call('control', 'POST', '/bind', bindInput('a'))).json).toEqual(first);
    expect(identity.calls).toContain('GET /api/v1/namespaces/lifemodel-motor/pods/a');
    expect(identity.calls).toContain('GET /apis/batch/v1/namespaces/lifemodel-motor/jobs/job-a');
  }, 30_000);
  it('rechecks the database deadline after a bind waits for the locked intent', async () => {
    await allocate('a');
    await project('a');
    const locked = await lock("SELECT 1 FROM task_access.intents WHERE task_id='a' FOR UPDATE");
    const binding = call('control', 'POST', '/bind', bindInput('a'));
    void binding.catch(() => undefined);
    await waitBlocked(locked);
    await locked.query(
      "UPDATE task_access.intents SET soft_due_at=clock_timestamp()-interval '2 seconds',hard_stop_at=clock_timestamp()-interval '1 second' WHERE task_id='a'"
    );
    await locked.query('COMMIT');
    lockers.delete(locked);
    locked.release();
    expect((await binding).status).toBe(403);
    expect(
      (
        await stores.postgres.query(
          'SELECT count(*)::int AS n FROM storage.bindings WHERE space_id=$1',
          [spaces.a]
        )
      ).rows[0].n
    ).toBe(0);
  }, 30_000);
  it.each(['a', 'web'])('denies %s on every control and core-read route', async (token) => {
    await prepare();
    for (const [path, body] of [
      ['/allocate', allocateInput('a')],
      ['/bind', bindInput('a')],
      ['/seal', sealInput()],
    ] as const)
      expect((await call('control', 'POST', path, body, token)).status).toBe(403);
    expect(
      (await call('read', 'GET', `/spaces/${spaces.a}/objects`, undefined, token)).status
    ).toBe(403);
  });
  it('re-authorizes core identity before each output chunk, not only at GET admission', async () => {
    await prepare();
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 8, 97);
    const uploaded = await put('a', 'large-output', bytes);
    expect(uploaded.status).toBe(200);
    expect(
      (
        await call('task', 'POST', `/spaces/${spaces.a}/objects/${uploaded.json.id}/mark`, {
          role: 'result',
        })
      ).status
    ).toBe(200);
    const reached = deferred();
    const release = deferred();
    releases.push(release.resolve);
    let gets = 0;
    backend.hooks.beforeGet = async () => {
      if (++gets === 2) {
        reached.resolve();
        await release.promise;
      }
    };
    const chunks: Buffer[] = [];
    const reading = new Promise<{ complete: boolean; bytes: Buffer }>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port: ports.read,
          method: 'GET',
          path: `/spaces/${spaces.a}/objects/${uploaded.json.id}`,
          ca: identity.certificate.ca,
          headers: { authorization: 'Bearer coreRead' },
          agent: false,
        },
        (res) => {
          const finish = (complete: boolean) => resolve({ complete, bytes: Buffer.concat(chunks) });
          res.on('data', (part) => chunks.push(Buffer.from(part)));
          res.on('error', () => finish(false));
          res.on('aborted', () => finish(false));
          res.on('end', () => finish(true));
        }
      );
      req.on('socket', (socket) => socket.on('error', () => undefined));
      req.on('error', reject);
      req.end();
    });
    void reading.catch(() => undefined);
    await reached.promise;
    await expect.poll(() => Buffer.concat(chunks).length).toBe(4 * 1024 * 1024);
    identity.deadPods.add('core');
    release.resolve();
    const result = await reading;
    expect(result.complete).toBe(false);
    expect(result.bytes).toEqual(bytes.subarray(0, 4 * 1024 * 1024));
    identity.deadPods.clear();
    expect(
      (await call('read', 'GET', `/spaces/${spaces.a}/objects/${uploaded.json.id}`)).body
    ).toEqual(bytes);
  }, 30_000);
  it('lets core read only marks while running, denies unmarked bytes and rejects stale seal revisions', async () => {
    await prepare();
    const data = await populate();
    const listed = await call('read', 'GET', `/spaces/${spaces.a}/objects?limit=100`);
    expect(listed.status).toBe(200);
    expect(listed.json.objects).toEqual(data.a.slice(0, 4).map((o) => o.receipt));
    expect(
      (await call('read', 'GET', `/spaces/${spaces.a}/objects/${data.a[4].receipt.id}`)).status
    ).toBe(404);
    expect(
      (await call('read', 'GET', `/spaces/${spaces.a}/objects/${data.b[0].receipt.id}`)).status
    ).toBe(404);
    expect(
      (await call('control', 'POST', '/seal', { ...sealInput(), expectedRevision: '99' })).status
    ).toBe(409);
    expect((await put('a', 'still-open', Buffer.from('valid'))).status).toBe(200);
  }, 30_000);
});

describe('durable seal recovery at real process and store boundaries', () => {
  it('seals while a foreign space has a live core read transport', async () => {
    await prepare();
    const data = await populate();
    const reached = deferred();
    const release = deferred();
    releases.push(release.resolve);
    backend.hooks.beforeGet = async () => {
      reached.resolve();
      await release.promise;
    };
    const downloading = call(
      'read',
      'GET',
      `/spaces/${spaces.b}/objects/${data.b[0].receipt.id}`
    ).catch(() => undefined);
    await reached.promise;
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    expect(sealed.json.state).toBe('sealed');
    release.resolve();
    expect((await downloading)?.body).toEqual(data.b[0].bytes);
  }, 30_000);

  it.each(['failed', 'stopped'] as const)(
    'recovers a frozen checksum mismatch as %s using only persisted candidates',
    async (outcome) => {
      await prepare();
      const data = await populate();
      const candidate = (
        await stores.postgres.query(
          'SELECT a.s3_key FROM storage.object_versions v JOIN storage.upload_attempts a ON a.id=v.attempt_id WHERE v.object_id=$1',
          [data.a[0].receipt.id]
        )
      ).rows[0];
      backend.objects.get(candidate.s3_key)!.sha256 = '0'.repeat(64);
      const first = await call('control', 'POST', '/seal', sealInput());
      expect(first.status).toBe(503);
      expect(await manifest()).toBeUndefined();
      // A new completed key must never hide corrupt marked bytes.
      expect(
        (
          await call('control', 'POST', '/seal', {
            ...sealInput('a', 'completed', 'still-completed'),
            expectedRevision: '1',
          })
        ).status
      ).toBe(409);
      // Poison fresh catalog metadata: recovery must use the frozen candidate list.
      await stores.postgres.query(
        "UPDATE storage.objects SET mark='artifact',name='not-the-frozen-name' WHERE id=$1",
        [data.a[1].receipt.id]
      );
      const request = { ...sealInput('a', outcome, 'repair-hash'), expectedRevision: '1' };
      await kill();
      await start();
      const sealed = await call('control', 'POST', '/seal', request);
      expect(sealed.status).toBe(200);
      expect(sealed.json).toMatchObject({ outcome, state: 'sealed', reason: 'checksum_mismatch' });
      expect(sealed.json.manifest.objects).toEqual(
        marked(data).filter((o) => o.id !== data.a[0].receipt.id)
      );
      expect(sealed.json.manifest.excluded).toEqual([
        { ...data.a[0].receipt, reason: 'checksum_mismatch' },
      ]);
      expect(sealed.json.manifest.sha256).toBe(
        hash(
          Buffer.from(
            JSON.stringify({
              version: 1,
              objects: sealed.json.manifest.objects.map((o: ObjectReceipt) => ({
                id: o.id,
                name: o.name,
                size: o.size,
                sha256: o.sha256,
                mark: o.mark,
              })),
              excluded: sealed.json.manifest.excluded.map((o: ObjectReceipt) => ({
                id: o.id,
                name: o.name,
                size: o.size,
                sha256: o.sha256,
                mark: o.mark,
                reason: 'checksum_mismatch',
              })),
            })
          )
        )
      );
      expect(backend.objects.has(candidate.s3_key)).toBe(false);
      expect(
        (await call('read', 'GET', `/spaces/${spaces.a}/objects/${data.a[0].receipt.id}`)).status
      ).toBe(404);
      expect((await call('control', 'POST', '/seal', request)).json).toEqual(sealed.json);
      expect((await call('control', 'POST', '/seal', sealInput())).status).toBe(409);
    },
    30_000
  );
  it('normal seal does not await a slow own-file task download', async () => {
    await prepare();
    const data = await populate();
    const reached = deferred();
    const release = deferred();
    releases.push(release.resolve);
    backend.hooks.beforeGet = async () => {
      reached.resolve();
      await release.promise;
    };
    const downloading = call(
      'task',
      'GET',
      `/spaces/${spaces.a}/objects/${data.a[0].receipt.id}`
    ).catch(() => undefined);
    await reached.promise;
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    expect(sealed.json.state).toBe('sealed');
    release.resolve();
    await downloading;
  }, 30_000);
  it('scopes a seal effect key per space and separately from allocate and bind', async () => {
    await prepare();
    await populate();
    for (const task of ['a', 'b']) {
      const reply = await call(
        'control',
        'POST',
        '/seal',
        sealInput(task, 'completed', 'allocate-a')
      );
      expect(reply.status).toBe(200);
      expect(
        (await call('control', 'POST', '/seal', sealInput(task, 'completed', 'allocate-a'))).json
      ).toEqual(reply.json);
    }
  }, 30_000);

  it('aborts and settles a live mid-body PUT before completing seal cleanup', async () => {
    await prepare();
    const result = await put('a', 'ready-result', Buffer.from('result'));
    expect(result.status).toBe(200);
    expect(
      (
        await call('task', 'POST', `/spaces/${spaces.a}/objects/${result.json.id}/mark`, {
          role: 'result',
        })
      ).status
    ).toBe(200);
    let heldKey: string | undefined;
    let socketClosed = false;
    const closedBeforeDelete: boolean[] = [];
    backend.hooks.duringPut = async (record, closed) => {
      heldKey = record.key;
      void closed.then(() => {
        socketClosed = true;
      });
    };
    backend.hooks.beforeDelete = () => {
      closedBeforeDelete.push(socketClosed);
    };
    const bytes = Buffer.alloc(8 * 1024 * 1024, 97);
    // Send one complete authorization chunk, but never finish the task body.
    // The fake backend keeps reading, so remote cancellation is observable;
    // waiting for close while pausing reads would hide TCP FIN behind buffers.
    const pending = new Promise<void>((resolve) => {
      const req = request(
        {
          hostname: 'localhost',
          port: ports.task,
          method: 'PUT',
          path: `/spaces/${spaces.a}/objects/mid-body`,
          ca: identity.certificate.ca,
          agent: false,
          headers: {
            authorization: 'Bearer a',
            'content-length': String(bytes.length),
            'x-storage-name': Buffer.from('a/mid-body.txt').toString('base64url'),
            'x-storage-length': String(bytes.length),
            'x-storage-sha256': hash(bytes),
          },
        },
        (res) => {
          res.on('error', () => resolve());
          res.on('end', () => resolve());
          res.resume();
        }
      );
      req.on('socket', (socket) => socket.on('error', () => undefined));
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      releases.push(() => req.destroy());
      req.write(bytes.subarray(0, 4 * 1024 * 1024));
    });
    await expect
      .poll(() => heldKey, { timeout: 5000, message: 'mid-body S3 boundary reached' })
      .toBeTypeOf('string');
    const incomplete = (
      await stores.postgres.query(
        'SELECT object_id::text FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2',
        [spaces.a, 'mid-body']
      )
    ).rows[0];
    const sealed = await call('control', 'POST', '/seal', sealInput('a', 'stopped'));
    await pending;
    await expect
      .poll(() => socketClosed, { timeout: 5000, message: 'mid-body backend socket closed' })
      .toBe(true);
    expect(closedBeforeDelete).toEqual([true]);
    expect(sealed.status).toBe(200);
    expect(sealed.json).toMatchObject({ state: 'sealed', outcome: 'stopped' });
    expect(sealed.json.manifest.objects.map((o: ObjectReceipt) => o.id)).toEqual([result.json.id]);
    expect(backend.objects.has(heldKey!)).toBe(false);
    const reads = await call('read', 'GET', `/spaces/${spaces.a}/objects`);
    expect(reads.json.objects.map((o: ObjectReceipt) => o.id)).toEqual([result.json.id]);
    expect(
      (await call('read', 'GET', `/spaces/${spaces.a}/objects/${incomplete.object_id}`)).status
    ).toBe(404);
    expect(
      (
        await stores.postgres.query(
          'SELECT reserved_bytes::text FROM storage.space_quota WHERE space_id=$1',
          [spaces.a]
        )
      ).rows[0].reserved_bytes
    ).toBe('0');
  }, 30_000);
  it('keeps a post-crash late full-body backend commit inaccessible as an explicit capacity-only orphan', async () => {
    await prepare();
    const result = await put('a', 'ready-result', Buffer.from('result'));
    expect(result.status).toBe(200);
    expect(
      (
        await call('task', 'POST', `/spaces/${spaces.a}/objects/${result.json.id}/mark`, {
          role: 'result',
        })
      ).status
    ).toBe(200);
    const reached = deferred();
    const release = deferred();
    const committed = deferred();
    releases.push(release.resolve);
    let heldKey: string | undefined;
    backend.hooks.beforeCommit = async (record) => {
      heldKey = record.key;
      reached.resolve();
      await release.promise;
    };
    backend.hooks.afterWrite = (record) => {
      if (record.key === heldKey) committed.resolve();
    };
    const pending = put('a', 'crash-ambiguous', Buffer.from('accepted before process crash')).catch(
      () => undefined
    );
    await reached.promise;
    const incomplete = (
      await stores.postgres.query(
        'SELECT object_id::text FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2',
        [spaces.a, 'crash-ambiguous']
      )
    ).rows[0];
    await kill();
    await pending;
    await start();
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    expect(sealed.json.manifest.objects.map((o: ObjectReceipt) => o.id)).toEqual([result.json.id]);
    release.resolve();
    await committed.promise;
    // Accepted residual from .decision-2.md: physical capacity is reconciled by
    // 653.7.3. A private orphan grants no catalog visibility or read authority.
    expect(backend.objects.has(heldKey!)).toBe(true);
    expect(
      (await call('read', 'GET', `/spaces/${spaces.a}/objects/${incomplete.object_id}`)).status
    ).toBe(404);
    expect(
      (await call('task', 'GET', `/spaces/${spaces.a}/objects/${incomplete.object_id}`)).status
    ).toBe(403);
    expect(
      (await call('read', 'GET', `/spaces/${spaces.a}/objects`)).json.objects.map(
        (o: ObjectReceipt) => o.id
      )
    ).toEqual([result.json.id]);
    expect((await call('control', 'POST', '/seal', sealInput())).json).toEqual(sealed.json);
  }, 30_000);
  it('survives a real dropped SQL connection at hash, fails closed and replays after repair', async () => {
    await prepare();
    const data = await populate();
    const reached = deferred();
    const release = deferred();
    releases.push(release.resolve);
    backend.hooks.beforeHead = async () => {
      reached.resolve();
      await release.promise;
    };
    const pending = call('control', 'POST', '/seal', sealInput());
    void pending.catch(() => undefined);
    await reached.promise;
    const original = child;
    sqlProxy.drop();
    release.resolve();
    const failed = await pending;
    expect(failed.status).toBe(503);
    expect(failed.json.error).toMatchObject({ id: expect.any(String), code: expect.any(String) });
    expect(child).toBe(original);
    expect(child?.exitCode).toBeNull();
    expect(child?.signalCode).toBeNull();
    sqlProxy.restore();
    delete backend.hooks.beforeHead;
    // Same process, not a supervisor restart, must accept fresh pooled connections.
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    await assertSealed(sealed.json, data);
  }, 30_000);

  it.each(['freeze', 'hash', 'manifest', 'delete', 'receipt'] as const)(
    'SIGKILL at %s replays one immutable manifest and receipt for two eight-object spaces',
    async (step) => {
      await prepare();
      const data = await populate();
      let locked: PoolClient | undefined;
      let savedManifest: any;
      const reached = deferred();
      const release = deferred();
      releases.push(release.resolve);
      if (step === 'freeze')
        locked = await lock('SELECT 1 FROM storage.spaces WHERE id=$1 FOR UPDATE', [spaces.a]);
      else if (step === 'hash' || step === 'manifest')
        backend.hooks.beforeHead = async () => {
          reached.resolve();
          await release.promise;
        };
      else
        backend.hooks.beforeDelete = async () => {
          reached.resolve();
          await release.promise;
        };
      const pending = call('control', 'POST', '/seal', sealInput()).catch(() => undefined);
      if (step === 'freeze') await waitBlocked(locked!);
      else {
        await reached.promise;
        await assertFrozen();
        // A mark requested after freeze cannot enter the already-defined output set.
        expect(
          (
            await call('task', 'POST', `/spaces/${spaces.a}/objects/${data.a[4].receipt.id}/mark`, {
              role: 'result',
            })
          ).status
        ).toBe(403);
        if (step === 'manifest') {
          locked = await lock('LOCK TABLE storage.seal_manifests IN ACCESS EXCLUSIVE MODE');
          release.resolve();
          await waitBlocked(locked);
          expect(backend.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
        } else if (step === 'delete' || step === 'receipt') {
          savedManifest = await manifest();
          expect(savedManifest.objects).toEqual(marked(data));
          if (step === 'receipt') {
            locked = await lock('LOCK TABLE storage.seal_receipts IN ACCESS EXCLUSIVE MODE');
            release.resolve();
            await waitBlocked(locked);
          }
        }
      }
      await kill();
      await pending;
      release.resolve();
      if (locked) await unlock(locked);
      delete backend.hooks.beforeHead;
      delete backend.hooks.beforeDelete;
      await start();
      const sealed = await call('control', 'POST', '/seal', sealInput());
      expect(sealed.status).toBe(200);
      await assertSealed(sealed.json, data);
      if (savedManifest) expect(await manifest()).toEqual(savedManifest);
      const verified = backend.requests.filter((r) => r.method === 'HEAD').length;
      await kill();
      await start();
      expect((await call('control', 'POST', '/seal', sealInput())).json).toEqual(sealed.json);
      expect(backend.requests.filter((r) => r.method === 'HEAD')).toHaveLength(verified);
      expect(
        (await call('control', 'POST', '/seal', { ...sealInput(), outcome: 'failed' })).status
      ).toBe(409);
      const other = await call('control', 'POST', '/seal', sealInput('b'));
      expect(other.status).toBe(200);
      await assertSealed(other.json, data, 'b');
      expect([...backend.objects.values()].map((o) => o.bytes.toString()).sort()).toEqual(
        [...data.a.slice(0, 4), ...data.b.slice(0, 4)].map((o) => o.bytes.toString()).sort()
      );
      expect(
        (await stores.postgres.query('SELECT count(*)::int AS n FROM storage.seal_receipts'))
          .rows[0].n
      ).toBe(2);
      expect(
        (await stores.postgres.query('SELECT count(*)::int AS n FROM storage.object_tombstones'))
          .rows[0].n
      ).toBe(8);
      expect(backend.requests.every((r) => r.authorized)).toBe(true);
    },
    60_000
  );

  it('lets an already-authorized mark commit before normal freeze, but never accepts a later mark', async () => {
    await prepare();
    const data = await populate();
    const item = data.a[4];
    const locked = await lock('SELECT 1 FROM storage.objects WHERE id=$1 FOR UPDATE', [
      item.receipt.id,
    ]);
    const marking = call('task', 'POST', `/spaces/${spaces.a}/objects/${item.receipt.id}/mark`, {
      role: 'artifact',
    });
    void marking.catch(() => undefined);
    await waitBlocked(locked);
    const priorReviews = identity.reviews.filter((token) => token === 'core').length;
    const sealing = call('control', 'POST', '/seal', sealInput());
    void sealing.catch(() => undefined);
    // Observe the seal request at the Kubernetes boundary. A normal seal waits
    // for the existing mark handler's ACK before acquiring the freeze lock.
    await expect
      .poll(() => identity.reviews.filter((token) => token === 'core').length)
      .toBeGreaterThan(priorReviews);
    await unlock(locked);
    expect((await marking).status).toBe(200);
    const sealed = await sealing;
    expect(sealed.status).toBe(200);
    expect(sealed.json.manifest.objects.map((o: ObjectReceipt) => o.id)).toContain(item.receipt.id);
    expect(sealed.json.manifest.objects).toHaveLength(5);
    expect(
      (
        await call('task', 'POST', `/spaces/${spaces.a}/objects/${data.a[5].receipt.id}/mark`, {
          role: 'artifact',
        })
      ).status
    ).toBe(403);
  }, 30_000);
  it('seals promptly while another space has an unfinished task transfer', async () => {
    await prepare();
    const data = await populate();
    let reached = false;
    backend.hooks.duringPut = async () => {
      reached = true;
    };
    const bytes = Buffer.alloc(8 * 1024 * 1024, 98);
    const pending = new Promise<void>((resolve) => {
      const req = request(
        {
          hostname: 'localhost',
          port: ports.task,
          method: 'PUT',
          path: `/spaces/${spaces.b}/objects/unrelated-transfer`,
          ca: identity.certificate.ca,
          agent: false,
          headers: {
            authorization: 'Bearer b',
            'content-length': String(bytes.length),
            'x-storage-name': Buffer.from('b/unrelated.txt').toString('base64url'),
            'x-storage-length': String(bytes.length),
            'x-storage-sha256': hash(bytes),
          },
        },
        (res) => {
          res.on('error', () => resolve());
          res.on('end', () => resolve());
          res.resume();
        }
      );
      req.on('socket', (socket) => socket.on('error', () => undefined));
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      releases.push(() => req.destroy());
      req.write(bytes.subarray(0, 4 * 1024 * 1024));
    });
    await expect.poll(() => reached, { timeout: 5000 }).toBe(true);
    const began = performance.now();
    const replay = await call('control', 'POST', '/seal', sealInput());
    expect(replay.status).toBe(200);
    expect(replay.json.state).toBe('sealed');
    expect(performance.now() - began).toBeLessThan(4000);
    // The slow foreign transfer remains active and writable until its own stop.
    expect((await call('task', 'GET', `/spaces/${spaces.b}/objects`, undefined, 'b')).status).toBe(
      200
    );
    for (const release of releases.splice(0)) release();
    await pending;
    expect((await call('read', 'GET', `/spaces/${spaces.a}/objects`)).json.objects).toEqual(
      data.a.slice(0, 4).map((o) => o.receipt)
    );
  }, 30_000);
  it('replays a sealed receipt immediately while another space has an unfinished task transfer', async () => {
    await prepare();
    const data = await populate();
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    let reached = false;
    backend.hooks.duringPut = async () => {
      reached = true;
    };
    const bytes = Buffer.alloc(8 * 1024 * 1024, 98);
    const pending = new Promise<void>((resolve) => {
      const req = request(
        {
          hostname: 'localhost',
          port: ports.task,
          method: 'PUT',
          path: `/spaces/${spaces.b}/objects/unrelated-transfer`,
          ca: identity.certificate.ca,
          agent: false,
          headers: {
            authorization: 'Bearer b',
            'content-length': String(bytes.length),
            'x-storage-name': Buffer.from('b/unrelated.txt').toString('base64url'),
            'x-storage-length': String(bytes.length),
            'x-storage-sha256': hash(bytes),
          },
        },
        (res) => {
          res.on('error', () => resolve());
          res.on('end', () => resolve());
          res.resume();
        }
      );
      req.on('socket', (socket) => socket.on('error', () => undefined));
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      releases.push(() => req.destroy());
      req.write(bytes.subarray(0, 4 * 1024 * 1024));
    });
    await expect.poll(() => reached, { timeout: 5000 }).toBe(true);
    const before = backend.requests.length;
    const replay = await call('control', 'POST', '/seal', sealInput());
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(sealed.json);
    expect(backend.requests).toHaveLength(before);
    // The slow foreign transfer remains active and writable until its own stop.
    expect((await call('task', 'GET', `/spaces/${spaces.b}/objects`, undefined, 'b')).status).toBe(
      200
    );
    for (const release of releases.splice(0)) release();
    await pending;
    expect((await call('read', 'GET', `/spaces/${spaces.a}/objects`)).json.objects).toEqual(
      data.a.slice(0, 4).map((o) => o.receipt)
    );
  }, 30_000);
  it('fails a completed outcome with no marked result instead of inventing success', async () => {
    await prepare();
    expect((await put('a', 'unmarked-result', Buffer.from('unmarked'))).status).toBe(200);
    const failed = await call('control', 'POST', '/seal', sealInput());
    expect(failed.status).toBe(409);
    expect(failed.json.error.code).toBe('missing_result');
    expect(
      (
        await stores.postgres.query(
          'SELECT mode,access_revision::text AS revision FROM storage.spaces WHERE id=$1',
          [spaces.a]
        )
      ).rows[0]
    ).toEqual({ mode: 'open', revision: '0' });
    expect(await manifest()).toBeUndefined();
    expect(
      (await stores.postgres.query('SELECT count(*)::int AS n FROM storage.seal_operations'))
        .rows[0].n
    ).toBe(0);
    expect(
      (await stores.postgres.query('SELECT count(*)::int AS n FROM storage.seal_receipts')).rows[0]
        .n
    ).toBe(0);
    const recovered = await call(
      'control',
      'POST',
      '/seal',
      sealInput('a', 'failed', 'recover-missing')
    );
    expect(recovered.status).toBe(200);
    expect(recovered.json).toMatchObject({
      outcome: 'failed',
      reason: 'missing_result',
      state: 'sealed',
    });
  });
  it('persists the manifest before delete, remains read-only on cleanup failure, then retries without rescanning', async () => {
    await prepare();
    const data = await populate();
    backend.hooks.beforeDelete = () => ({ status: 503 });
    const failed = await call('control', 'POST', '/seal', sealInput());
    expect(failed.status).toBe(503);
    expect(failed.json.error).toMatchObject({ id: expect.any(String), code: 'cleanup_pending' });
    await assertFrozen();
    const saved = await manifest();
    expect(saved.objects).toEqual(marked(data));
    expect(
      (await stores.postgres.query('SELECT count(*)::int AS n FROM storage.seal_receipts')).rows[0]
        .n
    ).toBe(0);
    expect(
      (await stores.postgres.query('SELECT mode FROM storage.spaces WHERE id=$1', [spaces.a]))
        .rows[0].mode
    ).not.toBe('sealed');
    const heads = backend.requests.filter((r) => r.method === 'HEAD').length;
    delete backend.hooks.beforeDelete;
    await kill();
    await start();
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    await assertSealed(sealed.json, data);
    expect(await manifest()).toEqual(saved);
    expect(backend.requests.filter((r) => r.method === 'HEAD')).toHaveLength(heads);
  }, 30_000);
  it('fails visibly on a marked checksum mismatch without a manifest or destructive cleanup', async () => {
    await prepare();
    await populate();
    backend.hooks.beforeHead = () => ({
      status: 200,
      headers: { 'x-amz-checksum-sha256': Buffer.alloc(32).toString('base64') },
    });
    const failed = await call('control', 'POST', '/seal', sealInput());
    expect(failed.status).toBe(503);
    expect(failed.json.error).toMatchObject({ id: expect.any(String), code: expect.any(String) });
    await assertFrozen();
    expect(await manifest()).toBeUndefined();
    expect(backend.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    expect(backend.objects.size).toBe(16);
  }, 30_000);
  it('cleans an incomplete upload without waiting for its future lease deadline', async () => {
    await prepare();
    const data = await populate();
    const objectId = randomUUID();
    const attemptId = randomUUID();
    const key = `inflight/${attemptId}`;
    await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,$7)', [
      spaces.a,
      'inflight',
      objectId,
      'pending.txt',
      7,
      hash(Buffer.from('pending')),
      60,
    ]);
    await stores.postgres.query(
      'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
      [attemptId, spaces.a, 'inflight', key]
    );
    backend.objects.set(key, {
      bytes: Buffer.from('pending'),
      sha256: hash(Buffer.from('pending')),
    });
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    await assertSealed(sealed.json, data);
    expect(backend.objects.has(key)).toBe(false);
  }, 30_000);
  it('cleans abandoned attempts and reservations, keeps tombstones and tolerates a lost delete ACK', async () => {
    await prepare();
    const data = await populate();
    const objectId = randomUUID();
    const attemptId = randomUUID();
    const key = `abandoned/${attemptId}`;
    await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,$7)', [
      spaces.a,
      'abandoned',
      objectId,
      'partial.txt',
      7,
      hash(Buffer.from('partial')),
      60,
    ]);
    await stores.postgres.query(
      "UPDATE storage.upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1 AND upload_id='abandoned'",
      [spaces.a]
    );
    await stores.postgres.query(
      'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
      [attemptId, spaces.a, 'abandoned', key]
    );
    backend.objects.set(key, {
      bytes: Buffer.from('partial'),
      sha256: hash(Buffer.from('partial')),
    });
    let lost = false;
    backend.hooks.afterDelete = () => {
      if (!lost) {
        lost = true;
        return 'lose-response';
      }
    };
    const first = await call('control', 'POST', '/seal', sealInput());
    expect(first.status).toBe(503);
    delete backend.hooks.afterDelete;
    await kill();
    await start();
    const sealed = await call('control', 'POST', '/seal', sealInput());
    expect(sealed.status).toBe(200);
    await assertSealed(sealed.json, data);
    expect(backend.objects.has(key)).toBe(false);
    expect(
      (
        await stores.postgres.query(
          'SELECT count(*)::int AS n FROM storage.seal_gc WHERE space_id=$1 AND NOT deleted',
          [spaces.a]
        )
      ).rows[0].n
    ).toBe(0);
  }, 30_000);
  it.each([
    ['failed', 'missing_result'],
    ['stopped', 'stopped_missing_result'],
  ] as const)('records %s without inventing a successful result', async (outcome, reason) => {
    await prepare();
    const uploaded = await put('a', 'partial', Buffer.from('partial'));
    expect(uploaded.status).toBe(200);
    const sealed = await call('control', 'POST', '/seal', sealInput('a', outcome));
    expect(sealed.status).toBe(200);
    expect(sealed.json).toMatchObject({
      outcome,
      reason,
      state: 'sealed',
      manifest: { objects: [] },
    });
    expect((await call('control', 'POST', '/seal', sealInput('a', outcome))).json).toEqual(
      sealed.json
    );
  });
});
