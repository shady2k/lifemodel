import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import {
  createKubernetesStorageIdentity,
  STORAGE_AUDIENCES,
} from '../../loader/src/storage-identity.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createStorageCertificate } from '../helpers/storage-certificate.js';

let stores: TestStores;
beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
  await stores.postgres.query("INSERT INTO storage.spaces(id) VALUES ('connections')");
  await stores.postgres.query(`INSERT INTO task_access.intents
    (task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at)
    VALUES ('connections','connections','connections',0,'active',
    clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')`);
  await stores.postgres.query(`INSERT INTO task_access.projections
    (task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at)
    SELECT task_id,attempt_id,launch_id,'job-connections','pod-connections','connections',0,0,
    'active',soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id='connections'`);
});
afterAll(async () => {
  await stores.postgres.end();
  await stores.redis.quit();
});

async function identityFixture(maxSockets = 2) {
  const certificate = await createStorageCertificate(['localhost']);
  const directory = mkdtempSync(join(tmpdir(), 'storage-connections-'));
  const tokenFile = join(directory, 'token');
  const caFile = join(directory, 'ca');
  writeFileSync(tokenFile, 'module-token');
  writeFileSync(caFile, certificate.ca);
  let connections = 0;
  let reviews = 0;
  let pods = 0;
  let jobs = 0;
  let podDeleting = false;
  let jobDeleting = false;
  let hook: (() => Promise<void>) | undefined;
  const api: Server = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void (async () => {
      for await (const part of req) void part;
      await hook?.();
      let value: unknown;
      if (req.url?.endsWith('/tokenreviews')) {
        reviews++;
        value = {
          status: {
            authenticated: true,
            audiences: STORAGE_AUDIENCES.task,
            user: {
              username: 'system:serviceaccount:lifemodel-motor:task',
              uid: 'sa',
              extra: {
                'authentication.kubernetes.io/pod-name': ['connections'],
                'authentication.kubernetes.io/pod-uid': ['pod-connections'],
              },
            },
          },
        };
      } else if (req.url?.includes('/pods/')) {
        pods++;
        value = {
          metadata: {
            name: 'connections',
            namespace: 'lifemodel-motor',
            uid: 'pod-connections',
            ...(podDeleting ? { deletionTimestamp: 'now' } : {}),
            ownerReferences: [
              {
                apiVersion: 'batch/v1',
                kind: 'Job',
                name: 'job-connections',
                uid: 'job-connections',
                controller: true,
              },
            ],
          },
          spec: { serviceAccountName: 'task' },
        };
      } else {
        jobs++;
        value = {
          metadata: {
            name: 'job-connections',
            namespace: 'lifemodel-motor',
            uid: 'job-connections',
            ...(jobDeleting ? { deletionTimestamp: 'now' } : {}),
          },
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    })().catch(() => res.destroy());
  });
  api.on('connection', (socket) => socket.on('error', () => undefined));
  api.on('secureConnection', () => {
    connections++;
  });
  api.on('error', () => undefined);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('no API');
  const identity = createKubernetesStorageIdentity({
    apiServer: `https://localhost:${address.port}`,
    tokenFile,
    caFile,
    maxSockets,
  });
  return {
    identity,
    get counts() {
      return { connections, reviews, pods, jobs };
    },
    deletePod() {
      podDeleting = true;
    },
    deleteJob() {
      podDeleting = false;
      jobDeleting = true;
    },
    setHook(value: (() => Promise<void>) | undefined) {
      hook = value;
    },
    async close() {
      identity.close?.();
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      certificate.cleanup();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function activity() {
  return (
    await stores.postgres.query<{ pid: number; wait_event_type: string }>(
      `SELECT pid,wait_event_type FROM pg_stat_activity
     WHERE application_name='lifemodel-storage-access' AND datname=current_database()`
    )
  ).rows;
}
const fakeIdentity = {
  verify: async () => ({
    role: 'task' as const,
    podUid: 'pod-connections',
    jobUid: 'job-connections',
  }),
  verifyBinding: async () => undefined,
};

describe('bounded fresh storage access connections', () => {
  it.each([0, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid connection bounds %s before opening a socket',
    (bound) => {
      expect(() =>
        createStorageAccess({
          connectionString: workerDatabaseUrl(),
          identity: fakeIdentity,
          poolMax: bound,
        })
      ).toThrow();
      expect(() => createKubernetesStorageIdentity({ maxSockets: bound })).toThrow();
    }
  );

  it('handles an idle pooled backend failure and serves a later valid chunk', async () => {
    const access = createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: fakeIdentity,
      poolMax: 1,
    });
    const stream = access.openTaskStream({ token: 'task-token', space: 'connections' });
    try {
      await stream.chunk(1, () => undefined);
      const pid = (await activity())[0]!.pid;
      await stores.postgres.query('SELECT pg_terminate_backend($1)', [pid]);
      await expect.poll(async () => (await activity()).length).toBe(0);
      // PostgreSQL termination and the client's error event travel on different
      // sockets. Wait for an observed successful health operation, not a timer.
      await expect.poll(() => access.check(new AbortController().signal)).toBe(true);
      await stream.chunk(1, () => undefined);
      expect((await activity())[0]!.pid).not.toBe(pid);
    } finally {
      stream.close();
      await access.close?.();
    }
  });

  it('reuses TLS connections but repeats TokenReview, Pod and Job proof for every chunk', async () => {
    const f = await identityFixture();
    const access = createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: f.identity,
    });
    const stream = access.openTaskStream({ token: 'task-token', space: 'connections' });
    try {
      for (let index = 0; index < 4; index++) await stream.chunk(1, () => undefined);
      expect(f.counts).toEqual({ connections: 1, reviews: 4, pods: 4, jobs: 4 });
      f.deletePod();
      await expect(stream.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
      f.deleteJob();
      await expect(stream.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
      expect(f.counts).toEqual({ connections: 1, reviews: 6, pods: 6, jobs: 5 });
    } finally {
      stream.close();
      await access.close?.();
      await f.close();
    }
  });

  it('caps concurrent TLS handshakes while every queued proof remains fresh', async () => {
    const f = await identityFixture(2);
    const entered = deferred();
    const release = deferred();
    let active = 0;
    f.setHook(async () => {
      if (++active === 2) entered.resolve();
      await release.promise;
    });
    const pending = Array.from({ length: 6 }, () =>
      f.identity.verify('task-token', STORAGE_AUDIENCES.task)
    );
    void Promise.all(pending).catch(() => undefined);
    try {
      await entered.promise;
      expect(f.counts.connections).toBe(2);
      release.resolve();
      await Promise.all(pending);
      expect(f.counts).toEqual({ connections: 2, reviews: 6, pods: 6, jobs: 6 });
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await f.close();
    }
  });

  it('bounds pg_stat_activity at the pool maximum, then reuses the same backends', async () => {
    const access = createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: fakeIdentity,
      poolMax: 2,
    });
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query("SELECT id FROM storage.spaces WHERE id='connections' FOR UPDATE");
    const streams = Array.from({ length: 8 }, () =>
      access.openTaskStream({ token: 'task-token', space: 'connections' })
    );
    const pending = streams.map((stream) => stream.chunk(1, () => undefined));
    void Promise.all(pending).catch(() => undefined);
    try {
      await expect
        .poll(async () => (await activity()).filter((row) => row.wait_event_type === 'Lock').length)
        .toBe(2);
      expect(await activity()).toHaveLength(2);
      const pids = (await activity()).map((row) => row.pid).sort();
      await locker.query('COMMIT');
      await Promise.all(pending);
      for (const stream of streams) await stream.chunk(1, () => undefined);
      expect((await activity()).map((row) => row.pid).sort()).toEqual(pids);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      for (const stream of streams) stream.close();
      await Promise.allSettled(pending);
      await access.close?.();
    }
    // Pool shutdown closes local sockets before the server removes their rows.
    await expect.poll(async () => (await activity()).length).toBe(0);
  });

  it('retires an aborted SQL client before its replacement can execute; a queued acquire aborts too', async () => {
    const access = createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: fakeIdentity,
      poolMax: 1,
    });
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query("SELECT id FROM storage.spaces WHERE id='connections' FOR UPDATE");
    const first = access.openTaskStream({ token: 'task-token', space: 'connections' });
    const queued = new AbortController();
    const replacement = access.openTaskStream({ token: 'task-token', space: 'connections' });
    const pending = first.chunk(1, () => undefined);
    void pending.catch(() => undefined);
    try {
      await expect
        .poll(async () => (await activity()).filter((row) => row.wait_event_type === 'Lock').length)
        .toBe(1);
      const pid = (await activity())[0]!.pid;
      const waiting = access.check(queued.signal);
      queued.abort();
      expect(await waiting).toBe(false);
      // Acquisition has its own deadline even while the only backend is busy.
      expect(await access.check(AbortSignal.timeout(100))).toBe(false);
      expect(await activity()).toHaveLength(1);
      first.close();
      await expect(pending).rejects.toMatchObject({ status: 503 });
      await locker.query('COMMIT');
      await replacement.chunk(1, () => undefined);
      const fresh = await activity();
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.pid).not.toBe(pid);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      first.close();
      queued.abort();
      replacement.close();
      await access.close?.();
    }
  });

  it('keeps the maintenance fence transaction-local on a reused client', async () => {
    const access = createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: fakeIdentity,
      poolMax: 1,
    });
    const stream = access.openTaskStream({ token: 'task-token', space: 'connections' });
    try {
      await stream.chunk(1, () => undefined);
      const pid = (await activity())[0]!.pid;
      await stores.postgres.query("UPDATE storage.maintenance SET state='held' WHERE id=true");
      await expect(stream.chunk(1, () => undefined)).rejects.toMatchObject({
        code: 'maintenance_unavailable',
      });
      await stores.postgres.query("UPDATE storage.maintenance SET state='normal' WHERE id=true");
      await stream.chunk(1, () => undefined);
      expect((await activity())[0]!.pid).toBe(pid);
    } finally {
      await stores.postgres.query("UPDATE storage.maintenance SET state='normal' WHERE id=true");
      stream.close();
      await access.close?.();
    }
  });
});
