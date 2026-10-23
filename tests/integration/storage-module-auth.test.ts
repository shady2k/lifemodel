import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:https';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { createStorageAccess, STORAGE_AUDIENCES } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';

let stores: TestStores;
let certificate: TestStorageCertificate;
let api: Server;
let root: string;
let apiServer: string;
let tokenFile: string;
let caFile: string;
let access: ReturnType<typeof createStorageAccess>;
const accessInstances = new Set<ReturnType<typeof createStorageAccess>>();
const identities = new Set<ReturnType<typeof createKubernetesStorageIdentity>>();
let invalid = false;
let audienceWrong = false;
let missingBoundUid = false;
let podUid = 'pod-a';
let podDeleting = false;
let jobMissing = false;
let podMissing = false;
let jobDeleting = false;
let wrongAccount = false;
let wrongNamespace = false;
let wrongOwner = false;
let jobUid = 'job-a';
let apiDown = false;
let apiFailure:
  | { kind: 'status' | 'transport' | 'timeout'; status?: number; path?: string }
  | undefined;
let reviewed = 0;
let podReads = 0;
let jobReads = 0;
let holdPod: (() => Promise<void>) | undefined;
const calls: string[] = [];
const tokens = {
  a: {
    namespace: 'lifemodel-motor',
    account: 'task',
    pod: 'a',
    audience: 'lifemodel-task-storage',
  },
  b: {
    namespace: 'lifemodel-motor',
    account: 'task',
    pod: 'b',
    audience: 'lifemodel-task-storage',
  },
  core: {
    namespace: 'lifemodel',
    account: 'core',
    pod: 'core',
    audience: 'lifemodel-core-storage-control',
  },
  coreRead: {
    namespace: 'lifemodel',
    account: 'core',
    pod: 'core',
    audience: 'lifemodel-core-storage-read',
  },
  web: {
    namespace: 'lifemodel',
    account: 'web',
    pod: 'web',
    audience: 'lifemodel-web-storage-read',
  },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
  certificate = await createStorageCertificate(['localhost']);
  root = mkdtempSync(join(tmpdir(), 'storage-identity-'));
  tokenFile = join(root, 'token');
  caFile = join(root, 'ca');
  writeFileSync(tokenFile, 'module-token');
  writeFileSync(caFile, certificate.ca);
  api = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void (async () => {
      calls.push(`${req.method} ${req.url}`);
      if (apiFailure && (!apiFailure.path || req.url?.includes(apiFailure.path))) {
        if (apiFailure.kind === 'transport') {
          req.socket.destroy();
          return;
        }
        if (apiFailure.kind === 'timeout') return;
        res.writeHead(apiFailure.status!);
        res.end('private upstream body');
        return;
      }
      if (apiDown) {
        res.writeHead(503);
        res.end('private upstream body');
        return;
      }
      if (req.headers.authorization !== 'Bearer module-token') {
        res.writeHead(401);
        res.end();
        return;
      }
      let body = '';
      for await (const part of req) body += part;
      let result: unknown;
      if (req.url === '/apis/authentication.k8s.io/v1/tokenreviews') {
        reviewed++;
        const spec = JSON.parse(body).spec;
        const value = tokens[spec.token as keyof typeof tokens];
        result = {
          status: {
            authenticated: !invalid && !!value && spec.audiences.includes(value.audience),
            audiences: [audienceWrong ? 'other' : value?.audience],
            user: {
              username: `system:serviceaccount:${value?.namespace}:${value?.account}`,
              uid: 'sa-uid',
              extra: missingBoundUid
                ? {}
                : {
                    'authentication.kubernetes.io/pod-name': [value?.pod],
                    'authentication.kubernetes.io/pod-uid': [`pod-${value?.pod}`],
                  },
            },
          },
        };
      } else if (req.url?.includes('/pods/')) {
        podReads++;
        if (podMissing) {
          res.writeHead(404);
          res.end();
          return;
        }
        await holdPod?.();
        const name = req.url.split('/').at(-1)!;
        const task = name === 'a' || name === 'b';
        result = {
          metadata: {
            name,
            namespace: wrongNamespace ? 'other' : task ? 'lifemodel-motor' : 'lifemodel',
            uid: name === 'a' ? podUid : `pod-${name}`,
            ...(podDeleting ? { deletionTimestamp: 'now' } : {}),
            ownerReferences: task
              ? [
                  {
                    apiVersion: 'batch/v1',
                    kind: wrongOwner ? 'ReplicaSet' : 'Job',
                    name: `job-${name}`,
                    uid: `job-${name}`,
                    controller: true,
                  },
                ]
              : [],
          },
          spec: { serviceAccountName: wrongAccount ? 'other' : task ? 'task' : name },
        };
      } else if (req.url?.includes('/jobs/')) {
        jobReads++;
        if (jobMissing) {
          res.writeHead(404);
          res.end();
          return;
        }
        const name = req.url.split('/').at(-1)!;
        result = {
          metadata: {
            name,
            namespace: 'lifemodel-motor',
            uid: name === 'job-a' ? jobUid : name,
            ...(jobDeleting ? { deletionTimestamp: 'now' } : {}),
          },
        };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('no API');
  apiServer = `https://localhost:${address.port}`;
});
afterAll(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  certificate.cleanup();
  rmSync(root, { recursive: true, force: true });
  await stores.postgres.end();
  await stores.redis.quit();
});
function makeIdentity(options: Parameters<typeof createKubernetesStorageIdentity>[0]) {
  const identity = createKubernetesStorageIdentity(options);
  identities.add(identity);
  return identity;
}
function makeAccess(connectionString = workerDatabaseUrl()) {
  const instance = createStorageAccess({
    connectionString,
    identity: makeIdentity({ apiServer, tokenFile, caFile }),
  });
  accessInstances.add(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all([...accessInstances].map((instance) => instance.close?.()));
  accessInstances.clear();
  for (const identity of identities) identity.close?.();
  identities.clear();
});
beforeEach(async () => {
  invalid = audienceWrong = missingBoundUid = podDeleting = jobMissing = apiDown = false;
  podUid = 'pod-a';
  jobUid = 'job-a';
  holdPod = undefined;
  apiFailure = undefined;
  podMissing = jobDeleting = wrongAccount = wrongNamespace = wrongOwner = false;
  reviewed = podReads = jobReads = 0;
  calls.length = 0;
  await stores.postgres.query(
    'TRUNCATE task_access.projections, task_access.intents, storage.revoke_receipts, storage.spaces CASCADE'
  );
  for (const id of ['a', 'b']) {
    await stores.postgres.query('INSERT INTO storage.spaces(id) VALUES ($1)', [id]);
    await stores.postgres.query(
      `INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at)
      VALUES ($1,$1,$1,0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')`,
      [id]
    );
    await stores.postgres.query(
      `INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at)
      SELECT task_id,attempt_id,launch_id,$2,$3,$1,0,0,'active',soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id=$1`,
      [id, `job-${id}`, `pod-${id}`]
    );
  }
  access = makeAccess();
});
const operation = (token = 'a', space = 'a') => access.openTaskStream({ token, space });
async function chunk(token = 'a', space = 'a') {
  const stream = operation(token, space);
  let dispatched = false;
  try {
    await stream.chunk(1, () => {
      dispatched = true;
    });
  } finally {
    stream.close();
  }
  return dispatched;
}
const denied = async () => {
  await expect(chunk()).rejects.toMatchObject({
    status: expect.any(Number),
    id: expect.any(String),
  });
};

describe('fresh task identity and independent SQL authorization', () => {
  it('allows each of two task spaces with no core connection, but never the other space', async () => {
    expect(await chunk()).toBe(true);
    expect(await chunk('b', 'b')).toBe(true);
    await expect(chunk('a', 'b')).rejects.toMatchObject({ status: 403 });
    await expect(chunk('b', 'a')).rejects.toMatchObject({ status: 403 });
    expect(reviewed).toBe(4);
    expect(podReads).toBe(4);
    expect(jobReads).toBe(4);
    expect(calls.every((call) => !call.includes('core'))).toBe(true);
  });
  it.each([
    'token',
    'audience',
    'bound UID',
    'Pod UID',
    'deleting Pod',
    'missing Job',
    'missing Pod',
    'deleting Job',
    'wrong account',
    'wrong namespace',
    'wrong controller',
    'Job UID',
    'API down',
    'missing projection',
    'missing intent',
    'missing binding',
  ])('refuses %s even immediately after successful access', async (failure) => {
    expect(await chunk()).toBe(true);
    if (failure === 'token') invalid = true;
    if (failure === 'audience') audienceWrong = true;
    if (failure === 'bound UID') missingBoundUid = true;
    if (failure === 'Pod UID') podUid = 'replacement';
    if (failure === 'deleting Pod') podDeleting = true;
    if (failure === 'missing Job') jobMissing = true;
    if (failure === 'missing Pod') podMissing = true;
    if (failure === 'deleting Job') jobDeleting = true;
    if (failure === 'wrong account') wrongAccount = true;
    if (failure === 'wrong namespace') wrongNamespace = true;
    if (failure === 'wrong controller') wrongOwner = true;
    if (failure === 'Job UID') jobUid = 'replacement';
    if (failure === 'API down') apiDown = true;
    if (failure === 'missing projection')
      await stores.postgres.query("DELETE FROM task_access.projections WHERE space_id='a'");
    if (failure === 'missing intent')
      await stores.postgres.query("DELETE FROM task_access.intents WHERE task_id='a'");
    if (failure === 'missing binding')
      await stores.postgres.query(
        "UPDATE task_access.projections SET pod_uid='unbound' WHERE space_id='a'"
      );
    await expect(chunk()).rejects.toMatchObject({
      status: failure === 'API down' ? 503 : 403,
      code: failure === 'API down' ? 'identity_unavailable' : expect.any(String),
    });
  });
  it.each([
    [
      'projection Job UID mismatch',
      "UPDATE task_access.projections SET job_uid='job-other' WHERE space_id='a'",
    ],
    [
      'projection intent revision ahead',
      "UPDATE task_access.projections SET intent_revision=2 WHERE space_id='a'",
    ],
    ['catalog access revision ahead', "UPDATE storage.spaces SET access_revision=1 WHERE id='a'"],
    [
      'projection access revision ahead',
      "UPDATE task_access.projections SET access_revision=1 WHERE space_id='a'",
    ],
  ])('SQL fence denies %s on an otherwise valid open space', async (_case, sql) => {
    expect(await chunk()).toBe(true);
    await stores.postgres.query(sql);
    expect(
      (await stores.postgres.query("SELECT mode FROM storage.spaces WHERE id='a'")).rows[0].mode
    ).toBe('open');
    await expect(chunk()).rejects.toMatchObject({ status: 403, code: 'access_denied' });
  });
  it.each([
    ['TokenReview 500', 'status', 500, 'tokenreviews'],
    ['TokenReview endpoint missing', 'status', 404, 'tokenreviews'],
    ['API throttled', 'status', 429, 'tokenreviews'],
    ['Pod 503', 'status', 503, '/pods/'],
    ['Job 502', 'status', 502, '/jobs/'],
    ['transport failure', 'transport', 0, 'tokenreviews'],
    ['timeout', 'timeout', 0, 'tokenreviews'],
  ] as const)(
    'classifies %s as identity unavailable, never a permission denial',
    async (_case, kind, status, path) => {
      apiFailure = { kind, status, path };
      const identity = makeIdentity({
        apiServer,
        tokenFile,
        caFile,
        timeoutMs: 100,
      });
      await expect(identity.verify('a', STORAGE_AUDIENCES.task)).rejects.toMatchObject({
        status: 503,
        code: 'identity_unavailable',
      });
    }
  );
  it.each([401, 403])('keeps apiserver refusal %s distinct from outages', async (status) => {
    apiFailure = { kind: 'status', status };
    await expect(chunk()).rejects.toMatchObject({ status: 403, code: 'identity_denied' });
  });
  it('refuses a task token on another audience and web on the control identity', async () => {
    await expect(access.identity.verify('a', STORAGE_AUDIENCES.control)).rejects.toMatchObject({
      status: 403,
    });
    await expect(access.identity.verify('web', STORAGE_AUDIENCES.control)).rejects.toMatchObject({
      status: 403,
    });
    expect((await access.identity.verify('core', STORAGE_AUDIENCES.control)).role).toBe('core');
    expect((await access.identity.verify('coreRead', STORAGE_AUDIENCES.read)).role).toBe('core');
    expect((await access.identity.verify('web', STORAGE_AUDIENCES.read)).role).toBe('web');
  });
  it('a newer committed revoke intent wins over a delayed old active projection', async () => {
    expect(await chunk()).toBe(true);
    await stores.postgres.query(
      "UPDATE task_access.intents SET revision=1,mode='revoked' WHERE task_id='a'"
    );
    await stores.postgres.query(
      "UPDATE task_access.projections SET mode='active',intent_revision=0 WHERE space_id='a'"
    );
    await denied();
  });
  it('soft wrap from intent or the database clock allows only own-space data', async () => {
    await stores.postgres.query(
      "UPDATE task_access.intents SET revision=1,mode='wrapping' WHERE task_id='a'"
    );
    const stream = operation();
    const modes: string[] = [];
    await stream.chunk(1, (decision) => {
      modes.push(decision.mode);
    });
    stream.close();
    expect(modes).toEqual(['wrapping']);
    await expect(chunk('a', 'b')).rejects.toMatchObject({ status: 403 });
    await stores.postgres.query(
      "UPDATE task_access.intents SET mode='active',soft_due_at=clock_timestamp()-interval '1 second' WHERE task_id='a'"
    );
    const second = operation();
    await second.chunk(1, (decision) => {
      expect(decision.mode).toBe('wrapping');
    });
    second.close();
  });
  it('the database hard deadline denies without a worker or projection update', async () => {
    await stores.postgres.query(
      "UPDATE task_access.intents SET soft_due_at=clock_timestamp()-interval '2 seconds',hard_stop_at=clock_timestamp()-interval '1 second' WHERE task_id='a'"
    );
    await denied();
    expect(await chunk('b', 'b')).toBe(true);
  });
  it('uses the database clock after waiting for an intent lock, not transaction start', async () => {
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query("UPDATE task_access.intents SET revision=1 WHERE task_id='a'");
    const pending = chunk();
    void pending.catch(() => undefined);
    try {
      await expect
        .poll(
          async () =>
            (
              await stores.postgres.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='lifemodel-storage-access' AND wait_event_type='Lock'"
              )
            ).rows[0].n
        )
        .toBeGreaterThan(0);
      await locker.query(
        "UPDATE task_access.intents SET soft_due_at=clock_timestamp()-interval '2 seconds',hard_stop_at=clock_timestamp()-interval '1 second' WHERE task_id='a'"
      );
      await locker.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ status: 403 });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
});

describe('durable revision fencing and stream cancellation', () => {
  it.each(['PUT', 'GET'])(
    'revoke during %s cancels without waiting for transfer; no chunk or publication after ACK',
    async () => {
      const stream = operation();
      const dispatched: number[] = [];
      await stream.chunk(4, () => {
        dispatched.push(1);
      });
      // Network drain is deliberately never awaited inside the guard.
      const receipt = await access.revoke('a', '0', 'revoke-a');
      expect(receipt).toMatchObject({ space: 'a', revision: '1', effectKey: 'revoke-a' });
      expect(stream.signal.aborted).toBe(true);
      await expect(
        stream.chunk(4, () => {
          dispatched.push(2);
        })
      ).rejects.toMatchObject({ status: 403 });
      await expect(stream.publish({ text: 'SELECT 1', values: [] })).rejects.toMatchObject({
        status: 403,
      });
      expect(dispatched).toEqual([1]);
      expect(await chunk('b', 'b')).toBe(true);
      stream.close();
      access = makeAccess();
      await denied();
    }
  );
  it('a live API result delayed until after revoke ACK cannot resurrect access', async () => {
    const entered = deferred();
    const release = deferred();
    holdPod = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = chunk();
    void pending.catch(() => undefined);
    await entered.promise;
    try {
      await access.revoke('a', '0', 'late');
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toMatchObject({ status: 403 });
  });
  it('revoke distinguishes a missing space from a stale revision', async () => {
    await expect(access.revoke('missing', '0', 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'space_not_found',
    });
    await expect(access.revoke('a', '1', 'stale')).rejects.toMatchObject({
      status: 409,
      code: 'revision_conflict',
    });
  });
  it('replays the same receipt after restart, rejects changed key input and stale different keys', async () => {
    const receipt = await access.revoke('a', '0', 'once');
    access = makeAccess();
    expect(await access.revoke('a', '0', 'once')).toEqual(receipt);
    await expect(access.revoke('b', '0', 'once')).rejects.toMatchObject({ status: 409 });
    await expect(access.revoke('a', '1', 'once')).rejects.toMatchObject({ status: 409 });
    await expect(access.revoke('a', '0', 'different')).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await stores.postgres.query(
          "SELECT access_revision::text AS revision FROM storage.spaces WHERE id='a'"
        )
      ).rows[0].revision
    ).toBe('1');
  });
  it('exactly one concurrent key wins a revision and simultaneous same-key calls replay', async () => {
    const results = await Promise.allSettled([
      access.revoke('a', '0', 'x'),
      access.revoke('a', '0', 'y'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [a, b] = await Promise.all([
      access.revoke('b', '0', 'same'),
      access.revoke('b', '0', 'same'),
    ]);
    expect(a).toEqual(b);
  });
  it('same-space concurrent processes serialize revoke with chunk decisions in SQL', async () => {
    const other = makeAccess();
    const stream = operation();
    const held = await stores.postgres.connect();
    await held.query('BEGIN');
    await held.query("SELECT id FROM storage.spaces WHERE id='a' FOR UPDATE");
    const revoke = other.revoke('a', '0', 'cross-instance');
    void revoke.catch(() => undefined);
    await expect
      .poll(
        async () =>
          (
            await stores.postgres.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='lifemodel-storage-access-control' AND wait_event_type='Lock'"
            )
          ).rows[0].n
      )
      .toBeGreaterThan(0);
    const pending = stream.chunk(1, () => undefined);
    void pending.catch(() => undefined);
    try {
      await held.query('COMMIT');
      await revoke;
      await expect(pending).rejects.toMatchObject({ status: 403 });
      await expect(stream.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
    } finally {
      await held.query('ROLLBACK');
      held.release();
      stream.close();
    }
  });
  it('returns only committed publication rows to the trusted module', async () => {
    const stream = operation();
    try {
      expect(
        await stream.publish({ text: 'SELECT $1::text AS status', values: ['completed'] })
      ).toEqual({ rows: [{ status: 'completed' }] });
    } finally {
      stream.close();
    }
  });
  it('publication commits metadata under the same guard and rolls back a failed write', async () => {
    const stream = operation();
    await stream.publish({
      text: "UPDATE storage.spaces SET mode='wrapping' WHERE id=$1",
      values: ['a'],
    });
    expect(
      (await stores.postgres.query("SELECT mode FROM storage.spaces WHERE id='a'")).rows[0].mode
    ).toBe('wrapping');
    await expect(
      stream.publish({ text: "UPDATE storage.spaces SET mode='invalid' WHERE id='a'", values: [] })
    ).rejects.toMatchObject({ status: 503 });
    expect(
      (await stores.postgres.query("SELECT mode FROM storage.spaces WHERE id='a'")).rows[0].mode
    ).toBe('wrapping');
    await access.revoke('a', '0', 'publish');
    await expect(
      stream.publish({ text: "UPDATE storage.spaces SET mode='open' WHERE id='a'", values: [] })
    ).rejects.toMatchObject({ status: 403 });
    stream.close();
  });
  it('a hard deadline crossing while the guard waits uses fresh database wall time', async () => {
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query(
      "UPDATE task_access.intents SET soft_due_at=clock_timestamp()+interval '200 milliseconds',hard_stop_at=clock_timestamp()+interval '300 milliseconds' WHERE task_id='a'"
    );
    const pending = chunk();
    void pending.catch(() => undefined);
    try {
      await expect
        .poll(
          async () =>
            (
              await stores.postgres.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='lifemodel-storage-access' AND wait_event_type='Lock'"
              )
            ).rows[0].n
        )
        .toBeGreaterThan(0);
      await expect
        .poll(
          async () =>
            (
              await locker.query(
                "SELECT clock_timestamp() >= hard_stop_at AS due FROM task_access.intents WHERE task_id='a'"
              )
            ).rows[0].due
        )
        .toBe(true);
      await locker.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ status: 403 });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
  it('holds intent and catalog locks through a chunk dispatch, without holding a network transfer', async () => {
    const writer = await stores.postgres.connect();
    let intent: Promise<unknown> | undefined;
    let revoke: Promise<unknown> | undefined;
    const stream = operation();
    try {
      await stream.chunk(1, () => {
        // Starts only after the callback yields; both must wait for this guard's SQL commit.
        intent = writer.query(
          "UPDATE task_access.intents SET revision=1,mode='revoked' WHERE task_id='a'"
        );
        revoke = makeAccess().revoke('a', '0', 'during-dispatch');
      });
      await intent;
      await revoke;
      await expect(stream.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
    } finally {
      stream.close();
      writer.release();
    }
  });
  it('a missing authority row is denied before a concurrent first binding can appear', async () => {
    // Hold the space table. A guard that ignores a missing authority lock would
    // reach this wait and then accept the row inserted while it waited.
    await stores.postgres.query("DELETE FROM task_access.intents WHERE task_id='a'");
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE storage.spaces IN ACCESS EXCLUSIVE MODE');
    const pending = chunk();
    void pending.catch(() => undefined);
    try {
      await expect(pending).rejects.toMatchObject({ status: 403 });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
  it('a missing space row never authorizes from a projection alone', async () => {
    await stores.postgres.query("DELETE FROM storage.spaces WHERE id='a'");
    await denied();
  });
  it('schema readiness covers the narrow authorization and revoke receipt contract', async () => {
    expect(await access.check(new AbortController().signal)).toBe(true);
    await stores.postgres.query('ALTER TABLE task_access.intents RENAME TO hidden_intents');
    try {
      expect(await access.check(new AbortController().signal)).toBe(false);
    } finally {
      await stores.postgres.query('ALTER TABLE task_access.hidden_intents RENAME TO intents');
    }
  });
  it('rejects an async dispatch before its body starts', async () => {
    const stream = operation();
    let ran = false;
    const callback = (async () => {
      ran = true;
    }) as unknown as () => undefined;
    await expect(stream.chunk(1, callback)).rejects.toMatchObject({
      code: 'async_dispatch_forbidden',
    });
    expect(ran).toBe(false);
    stream.close();
  });
  it('closing an old stream twice cannot unregister a newer live stream', async () => {
    const old = operation();
    old.close();
    const current = operation();
    old.close();
    await access.revoke('a', '0', 'cancel-new');
    expect(current.signal.aborted).toBe(true);
    current.close();
  });
  it('each chunk repeats Pod and Job liveness, not just stream open', async () => {
    const stream = operation();
    await stream.chunk(1, () => undefined);
    podDeleting = true;
    await expect(stream.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
    podDeleting = false;
    jobMissing = true;
    await expect(stream.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
    expect(reviewed).toBe(3);
    expect(podReads).toBe(3);
    expect(jobReads).toBe(2);
    stream.close();
  });
  it('rejects unbounded chunks and all task modes after freeze/seal', async () => {
    const stream = operation();
    await expect(stream.chunk(4 * 1024 * 1024 + 1, () => undefined)).rejects.toMatchObject({
      status: 400,
    });
    stream.close();
    for (const mode of ['frozen', 'sealed', 'revoked']) {
      await stores.postgres.query('UPDATE storage.spaces SET mode=$1 WHERE id=$2', [mode, 'a']);
      await denied();
    }
  });
  it('survives a real dropped SQL TCP connection and denies until the store returns', async () => {
    const target = new URL(workerDatabaseUrl());
    const sockets = new Set<Socket>();
    const upstreamHost = target.hostname;
    const upstreamPort = Number(target.port || '5432');
    const proxy = createTcpServer((client) => {
      const upstream = connect(upstreamPort, upstreamHost);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('no proxy');
    target.hostname = '127.0.0.1';
    target.port = String(address.port);
    access = makeAccess(target.toString());
    expect(await chunk()).toBe(true);
    const lock = await stores.postgres.connect();
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE task_access.intents IN ACCESS EXCLUSIVE MODE');
    const pending = chunk();
    void pending.catch(() => undefined);
    try {
      await expect
        .poll(
          async () =>
            (
              await stores.postgres.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='lifemodel-storage-access' AND wait_event_type='Lock'"
              )
            ).rows[0].n
        )
        .toBeGreaterThan(0);
      for (const socket of sockets) socket.destroy();
      await expect(pending).rejects.toMatchObject({ status: 503 });
      await lock.query('ROLLBACK');
      expect(await chunk()).toBe(true);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

async function listenerFixture() {
  const lines: RecordedLine[] = [];
  const app = createStorageModule({
    bucket: 'lifemodel-storage',
    catalog: createCatalog({ connectionString: workerDatabaseUrl() }),
    access,
    custody: {
      read: async () => {
        throw new Error('not used for access');
      },
    },
    check: async () => {
      throw new Error('not used for access');
    },
    logger: createRecordingLogger(lines),
    tls: {
      cert: certificate.cert,
      key: certificate.key,
      read: async () => ({ cert: certificate.cert, key: certificate.key }),
      timers: { set: () => ({}) as ReturnType<typeof setTimeout>, clear: () => undefined },
    },
  });
  const listeners = [app.task, app.control, app.read];
  for (const listener of listeners)
    await new Promise<void>((resolve) => listener.server.listen(0, '127.0.0.1', resolve));
  async function call(which: number, token: string, path: string, body?: unknown) {
    const address = listeners[which].server.address();
    if (!address || typeof address === 'string') throw new Error('no listener');
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          servername: 'localhost',
          ca: certificate.ca,
          agent: false,
          path,
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}` },
        },
        (res) => {
          let text = '';
          res.on('error', reject);
          res.on('data', (part) => {
            text += part;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null })
          );
        }
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return {
    app,
    lines,
    call,
    close: () => {
      for (const listener of listeners) listener.close();
    },
  };
}
describe('separate TLS operation-shaped listeners', () => {
  it('logs exactly one safe correlated line per denied request and revoke, including replay', async () => {
    const f = await listenerFixture();
    const assertLine = (
      index: number,
      id: string,
      code: string,
      status: number,
      space: string | null
    ) => {
      expect(f.lines).toHaveLength(index + 1);
      expect(f.lines[index].fields).toEqual({ id, code, status, space });
    };
    try {
      invalid = true;
      const denied = await f.call(0, 'secret-caller-token', '/spaces/a/access');
      expect(denied.status).toBe(403);
      assertLine(0, denied.body.error.id, 'identity_denied', 403, 'a');
      invalid = false;
      apiDown = true;
      const outage = await f.call(0, 'a', '/spaces/a/access');
      expect(outage.status).toBe(503);
      assertLine(1, outage.body.error.id, 'identity_unavailable', 503, 'a');
      apiDown = false;
      const cross = await f.call(0, 'a', '/spaces/b/access');
      expect(cross.status).toBe(403);
      assertLine(2, cross.body.error.id, 'access_denied', 403, 'b');
      const input = { space: 'a', expectedRevision: '0', effectKey: 'private-effect-key' };
      const revoke = await f.call(1, 'core', '/revoke', input);
      expect(revoke.status).toBe(200);
      assertLine(3, revoke.body.id, 'space_revoked', 200, 'a');
      const replay = await f.call(1, 'core', '/revoke', input);
      expect(replay.body).toEqual(revoke.body);
      assertLine(4, replay.body.id, 'space_revoked', 200, 'a');
      const web = await f.call(1, 'web', '/revoke', input);
      expect(web.status).toBe(403);
      assertLine(5, web.body.error.id, 'identity_denied', 403, null);
      const bad = await f.call(1, 'core', '/revoke', { ...input, space: '/private/file-name' });
      expect(bad.status).toBe(400);
      assertLine(6, bad.body.error.id, 'invalid_request', 400, null);
      const output = JSON.stringify(f.lines);
      for (const secret of [
        'secret-caller-token',
        'private upstream body',
        'private-effect-key',
        '/private/file-name',
        'module-token',
        workerDatabaseUrl(),
        tokenFile,
      ])
        expect(output).not.toContain(secret);
    } finally {
      f.close();
    }
  });
  it('task proves own access, trusted read proves identity, web cannot revoke on any listener', async () => {
    const f = await listenerFixture();
    try {
      expect((await f.call(0, 'a', '/spaces/a/access')).status).toBe(200);
      expect((await f.call(0, 'a', '/spaces/b/access')).status).toBe(403);
      expect((await f.call(2, 'web', '/identity')).body).toMatchObject({ role: 'web' });
      expect((await f.call(2, 'coreRead', '/identity')).body).toMatchObject({ role: 'core' });
      const denied = await f.call(1, 'web', '/revoke', {
        space: 'a',
        expectedRevision: '0',
        effectKey: 'web',
      });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({
        error: { id: expect.any(String), code: expect.any(String) },
      });
      expect(JSON.stringify(denied.body)).not.toContain('private upstream body');
      expect(
        (await f.call(2, 'web', '/revoke', { space: 'a', expectedRevision: '0', effectKey: 'web' }))
          .status
      ).toBe(404);
      expect(
        (await f.call(0, 'a', '/revoke', { space: 'a', expectedRevision: '0', effectKey: 'task' }))
          .status
      ).toBe(404);
      const revoked = await f.call(1, 'core', '/revoke', {
        space: 'a',
        expectedRevision: '0',
        effectKey: 'core',
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.revision).toBe('1');
      expect((await f.call(0, 'a', '/spaces/a/access')).status).toBe(403);
    } finally {
      f.close();
    }
  });
});

describe('bounded test PUT/GET through the production guard seam', () => {
  it.each(['PUT', 'GET'])(
    'no %s chunk dispatch after the real control listener ACK, even with a stalled transfer',
    async (method) => {
      const first = deferred();
      const release = deferred();
      const cancelled = deferred();
      const finished = deferred();
      const dispatches: number[] = [];
      const transport = createServer(
        { cert: certificate.cert, key: certificate.key },
        (req, res) => {
          req.on('error', () => undefined);
          res.on('error', () => undefined);
          void (async () => {
            const stream = access.openTaskStream({ token: 'a', space: 'a' });
            stream.signal.addEventListener('abort', () => {
              cancelled.resolve();
              res.destroy();
            });
            try {
              if (req.method === 'PUT') {
                let index = 0;
                for await (const bytes of req) {
                  const part = Buffer.from(bytes);
                  await stream.chunk(part.length, () => {
                    dispatches.push(++index);
                    res.write('accepted\n');
                  });
                  first.resolve();
                  await release.promise;
                }
              } else {
                await stream.chunk(4, () => {
                  dispatches.push(1);
                  res.write('one\n');
                });
                first.resolve();
                await release.promise;
                await stream.chunk(4, () => {
                  dispatches.push(2);
                  res.write('two\n');
                });
              }
              res.end();
            } catch {
              res.destroy();
            } finally {
              stream.close();
              finished.resolve();
            }
          })();
        }
      );
      await new Promise<void>((resolve) => transport.listen(0, '127.0.0.1', resolve));
      const address = transport.address();
      if (!address || typeof address === 'string') throw new Error('no transport');
      const requestError = deferred();
      const client = request(
        {
          host: '127.0.0.1',
          port: address.port,
          servername: 'localhost',
          ca: certificate.ca,
          method,
          agent: false,
        },
        (res) => {
          res.on('error', () => requestError.resolve());
          res.resume();
        }
      );
      client.on('error', () => requestError.resolve());
      if (method === 'PUT') {
        client.flushHeaders();
        client.write('one\n');
      } else client.end();
      const control = await listenerFixture();
      try {
        await first.promise;
        const ack = await control.call(1, 'core', '/revoke', {
          space: 'a',
          expectedRevision: '0',
          effectKey: `transport-${method}`,
        });
        expect(ack.status).toBe(200);
        await cancelled.promise;
        if (method === 'PUT') client.end('two\n');
        release.resolve();
        if (method === 'PUT') client.destroy();
        await finished.promise;
        expect(dispatches).toEqual([1]);
        expect(await chunk('b', 'b')).toBe(true);
      } finally {
        release.resolve();
        client.destroy();
        control.close();
        transport.closeAllConnections();
        await new Promise<void>((resolve) => transport.close(() => resolve()));
      }
    }
  );
});
