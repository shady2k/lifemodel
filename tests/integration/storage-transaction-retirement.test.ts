import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { createStorageAccess, StorageAccessError } from '../../loader/src/storage-access.js';
import { createStorageSeal } from '../../loader/src/storage-seal.js';
import { createStorageRetention } from '../../loader/src/storage-retention.js';
import { createStorageUploadOwner } from '../../loader/src/storage-upload-owner.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

let stores: TestStores;
beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await stores.postgres.end();
  await stores.redis.quit();
});

const identity = {
  verify: async () => ({ role: 'task' as const, podUid: 'missing', jobUid: 'missing' }),
  verifyBinding: async () => undefined,
};
const paths = ['control', 'seal', 'retention', 'transfer'] as const;
type Path = (typeof paths)[number];
function fixture(path: Path) {
  const access = createStorageAccess({
    connectionString: workerDatabaseUrl(),
    identity,
    poolMax: 1,
  });
  const seal = createStorageSeal({
    connectionString: workerDatabaseUrl(),
    access,
    s3: {} as never,
  });
  const retention = createStorageRetention({
    connectionString: workerDatabaseUrl(),
    s3: {} as never,
    owner: {} as never,
    settings: { read: async () => undefined },
    logger: createRecordingLogger([]),
  });
  const name = path === 'control' || path === 'transfer' ? 'access' : path;
  return {
    application: `lifemodel-storage-${name}`,
    refuse: () =>
      path === 'control'
        ? access.revoke('missing', '0', 'missing')
        : path === 'seal'
          ? seal.seal({
              space: 'missing',
              effectKey: 'missing',
              expectedRevision: '0',
              outcome: 'stopped',
            })
          : path === 'retention'
            ? retention.policy({
                space: 'missing',
                effectKey: 'missing',
                expectedRevision: '0',
                operation: 'pin',
              })
            : (async () => {
                const stream = access.openTaskStream({ token: 'missing', space: 'missing' });
                try {
                  await stream.chunk(1, () => undefined);
                } finally {
                  stream.close();
                }
              })(),
    commit: () =>
      path === 'control'
        ? access.revoke('transaction-end', '0', 'transaction-end')
        : path === 'seal'
          ? seal.check(new AbortController().signal)
          : path === 'retention'
            ? retention.check(new AbortController().signal)
            : access.check(new AbortController().signal),
    check: () =>
      path === 'seal'
        ? seal.check(new AbortController().signal)
        : path === 'retention'
          ? retention.check(new AbortController().signal)
          : access.check(new AbortController().signal),
    close: () => Promise.all([seal.close(), retention.close(), access.close()]),
  };
}

/** Keep real PG protocol/transaction state. Only the selected terminal SQL is
 * replaced. A local pg query timeout has no SQLSTATE, parent abort or client
 * error event; the backend is still executing when the caller sees rejection. */
function faultCompletion(
  application: string,
  command: 'ROLLBACK' | 'COMMIT',
  fault: 'timeout' | 'sqlstate',
  refuseInsert = false
) {
  const original = Client.prototype.query;
  let armed = true;
  let faultPid: number | undefined;
  let clientErrors = 0;
  const beginPids: number[] = [];
  const queryPids: number[] = [];
  vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    const client = this as Client & {
      processID: number;
      connectionParameters: { application_name: string };
    };
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
    if (client.connectionParameters.application_name === application) {
      queryPids.push(client.processID);
      if (refuseInsert && text?.startsWith('INSERT INTO storage.upload_owners')) {
        refuseInsert = false;
        return Promise.reject(new StorageAccessError(503, 'upload_owner_unavailable'));
      }
      if (text === 'BEGIN') beginPids.push(client.processID);
      if (armed && text === command) {
        armed = false;
        faultPid = client.processID;
        client.on('error', () => {
          clientErrors++;
        });
        return original.call(
          this,
          fault === 'timeout'
            ? { text: 'SELECT pg_sleep(0.2)', query_timeout: 20 }
            : { text: "DO $$ BEGIN RAISE SQLSTATE '40001'; END $$" }
        );
      }
    }
    return original.apply(this, args as never);
  });
  return {
    get pid() {
      return faultPid;
    },
    get errors() {
      return clientErrors;
    },
    beginPids,
    queryPids,
  };
}

async function backend(pid: number) {
  return (
    await stores.postgres.query<{ state: string }>(
      'SELECT state FROM pg_stat_activity WHERE pid=$1',
      [pid]
    )
  ).rows;
}

describe('storage transaction completion retires uncertain pooled sessions', () => {
  it.each(paths)(
    '%s retires a refused transaction when ROLLBACK times out without abort or error event',
    async (path) => {
      const f = fixture(path);
      const fault = faultCompletion(f.application, 'ROLLBACK', 'timeout');
      try {
        await expect(f.refuse()).rejects.toMatchObject({ status: path === 'transfer' ? 403 : 404 });
        expect(fault.pid).toBeTypeOf('number');
        expect(fault.errors).toBe(0);
        expect(await f.check()).toBe(true);
        expect(fault.beginPids.at(-1)).not.toBe(fault.pid);
        await expect.poll(async () => (await backend(fault.pid!)).length).toBe(0);
      } finally {
        await f.close();
      }
    }
  );

  it.each(
    paths.flatMap((path) => (['timeout', 'sqlstate'] as const).map((fault) => ({ path, fault })))
  )(
    '$path retires a failed COMMIT ($fault) regardless of later ROLLBACK acknowledgement',
    async ({ path, fault: kind }) => {
      await stores.postgres.query(
        "INSERT INTO storage.spaces(id) VALUES ('transaction-end') ON CONFLICT(id) DO UPDATE SET access_revision=0,mode='open'"
      );
      await stores.postgres.query(
        "DELETE FROM storage.revoke_receipts WHERE effect_key='transaction-end'"
      );
      const f = fixture(path);
      const fault = faultCompletion(f.application, 'COMMIT', kind);
      try {
        if (path === 'control') await expect(f.commit()).rejects.toMatchObject({ status: 503 });
        else expect(await f.commit()).toBe(false);
        expect(fault.pid).toBeTypeOf('number');
        expect(fault.errors).toBe(0);
        expect(await f.check()).toBe(true);
        expect(fault.beginPids.at(-1)).not.toBe(fault.pid);
        await expect.poll(async () => (await backend(fault.pid!)).length).toBe(0);
      } finally {
        await f.close();
      }
    }
  );

  it.each(paths)('%s reuses a session after an acknowledged refusal ROLLBACK', async (path) => {
    const f = fixture(path);
    const original = Client.prototype.query;
    const pids: number[] = [];
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const client = this as Client & {
        processID: number;
        connectionParameters: { application_name: string };
      };
      if (args[0] === 'BEGIN' && client.connectionParameters.application_name === f.application)
        pids.push(client.processID);
      return original.apply(this, args as never);
    });
    try {
      await expect(f.refuse()).rejects.toHaveProperty('status');
      expect(await f.check()).toBe(true);
      expect(pids).toHaveLength(path === 'seal' ? 3 : 2);
      expect(new Set(pids).size).toBe(1);
    } finally {
      await f.close();
    }
  });
});

describe('upload owner transaction completion retires uncertain pooled sessions', () => {
  it.each(['initialize', 'renew', 'recover'] as const)(
    '%s retires a rejected COMMIT before a later owner checkout',
    async (phase) => {
      let clock = 0;
      const owner = createStorageUploadOwner({
        connectionString: workerDatabaseUrl(),
        now: () => clock,
      });
      let renewal: (() => void) | undefined;
      const schedule = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        // Capture only this owner's scheduler; leave native pg query deadlines intact.
        if (delay === 5000 && callback.toString().includes('pendingRenewal')) {
          renewal = () => callback(...args);
          return { unref() {} } as ReturnType<typeof setTimeout>;
        }
        return schedule(callback, delay, ...args);
      }) as typeof setTimeout);
      let fault: ReturnType<typeof faultCompletion> | undefined;
      try {
        if (phase !== 'initialize') await owner.ready();
        if (phase === 'recover') {
          await stores.postgres.query(
            "UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE boot_id=$1",
            [owner.bootId]
          );
          clock = 31000;
        }
        fault = faultCompletion('lifemodel-storage-upload-owner', 'COMMIT', 'sqlstate');
        if (phase === 'renew') {
          expect(renewal).toBeTypeOf('function');
          renewal!();
          // Wait for the renewal query to reject and its rollback to settle.
          await expect.poll(() => fault!.pid).toBeTypeOf('number');
        } else
          await expect(owner.ready()).rejects.toMatchObject({ code: 'upload_owner_unavailable' });
        expect(fault.pid).toBeTypeOf('number');
        // ready() always checks maintenance on its own checkout, even when
        // initialization/recovery has just failed. Observe that checkout's pid.
        const before = fault.queryPids.length;
        await owner.ready().catch(() => undefined);
        expect(fault.queryPids.length).toBeGreaterThan(before);
        expect(fault.queryPids[before]).not.toBe(fault.pid);
        await expect.poll(async () => (await backend(fault!.pid!)).length).toBe(0);
      } finally {
        await owner.close();
      }
    }
  );

  it('initialize retires a failed ROLLBACK after an insert refusal', async () => {
    const owner = createStorageUploadOwner({ connectionString: workerDatabaseUrl() });
    const fault = faultCompletion('lifemodel-storage-upload-owner', 'ROLLBACK', 'timeout', true);
    try {
      await expect(owner.ready()).rejects.toMatchObject({ code: 'upload_owner_unavailable' });
      expect(fault.pid).toBeTypeOf('number');
      expect(fault.errors).toBe(0);
      await owner.ready().catch(() => undefined);
      expect(fault.beginPids.at(-1)).not.toBe(fault.pid);
      await expect.poll(async () => (await backend(fault.pid!)).length).toBe(0);
    } finally {
      await owner.close();
    }
  });
});
