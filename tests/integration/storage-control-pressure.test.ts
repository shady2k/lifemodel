import { afterEach, describe, expect, it } from 'vitest';
import { request, type ClientRequest } from 'node:https';
import { createStorageModule, type StorageModule } from '../../loader/src/storage-module-app.js';
import { createStorageAdmission } from '../../loader/src/storage-admission.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { createPressureHarness } from '../helpers/storage-pressure-harness.js';
import { createStorageSeal } from '../../loader/src/storage-seal.js';
import { createStorageRetention } from '../../loader/src/storage-retention.js';
import { createStorageMaintenance } from '../../loader/src/storage-maintenance.js';
import { workerDatabaseUrl } from '../helpers/test-stores.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';

let fixture: Awaited<ReturnType<typeof createPressureHarness>> | undefined;
let app: StorageModule | undefined;
const clients = new Set<ClientRequest>();
const releases: (() => void)[] = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const client of clients) client.destroy();
  clients.clear();
  app?.control.close();
  app = undefined;
  await fixture?.close();
  fixture = undefined;
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

async function controls(
  allocate: (input: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>,
  deadline = 5000
) {
  const h = (fixture = await createPressureHarness());
  const admission = createStorageAdmission({ chunkDeadlineMs: deadline });
  const module = (app = createStorageModule({
    bucket: 'task-output',
    access: h.access,
    admission,
    seal: {
      allocate,
      bind: allocate,
      seal: allocate,
      openCoreStream: () => {
        throw Error('unexpected stream');
      },
      check: async () => true,
      close: async () => undefined,
    },
    catalog: { check: async () => ({ ok: true }) },
    custody: { read: async () => h.backend.credentials },
    check: async () => ({ ok: true }),
    logger: createRecordingLogger([]),
    tls: { ...h.api.certificate, read: async () => h.api.certificate },
  }));
  await new Promise<void>((resolve) => module.control.server.listen(0, '127.0.0.1', resolve));
  const address = module.control.server.address();
  if (!address || typeof address === 'string') throw Error('missing listener');
  function begin(partial = false) {
    const body = JSON.stringify({ effectKey: 'control' });
    let req!: ClientRequest;
    const settled = new Promise<number | null>((resolve) => {
      req = request(
        {
          hostname: 'localhost',
          port: address.port,
          path: '/allocate',
          method: 'POST',
          ca: h.api.certificate.ca,
          agent: false,
          headers: { authorization: 'Bearer core', 'content-length': String(body.length) },
        },
        (res) => {
          res.on('error', () => resolve(null));
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        }
      );
      req.on('socket', (socket) => socket.on('error', () => undefined));
      req.on('error', () => resolve(null));
      clients.add(req);
      req.once('close', () => clients.delete(req));
      if (partial) req.write('{');
      else req.end(body);
    });
    return {
      request: req,
      settled,
      closed: new Promise<void>((resolve) => req.once('close', resolve)),
    };
  }
  return { begin, admission };
}

describe('control execution pressure and cancellation', () => {
  it('keeps at most two handlers executing after disconnect until their canceled work settles', async () => {
    const drain = deferred();
    let entered = 0,
      exited = 0,
      peak = 0,
      canceled = 0;
    const h = await controls(async (_input, signal) => {
      entered++;
      peak = Math.max(peak, entered - exited);
      try {
        if (entered <= 2) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
            signal?.addEventListener(
              'abort',
              () => {
                canceled++;
                resolve();
              },
              { once: true }
            );
          });
          // Cancellation was requested, but the SQL/S3 transport has not settled.
          await drain.promise;
        }
        return { id: 'receipt', space: 'a' };
      } finally {
        exited++;
      }
    });
    const first = h.begin(),
      second = h.begin();
    await expect.poll(() => entered).toBe(2);
    first.request.destroy();
    second.request.destroy();
    await expect.poll(() => canceled).toBe(2);
    const third = h.begin();
    await expect.poll(() => h.admission.snapshot().queued + Math.max(0, entered - 2)).toBe(1);
    expect(peak).toBe(2);
    expect(h.admission.snapshot().queued).toBe(1);
    expect(entered - exited).toBe(2);
    drain.resolve();
    expect(await third.settled).toBe(200);
    expect(peak).toBe(2);
    expect(exited).toBe(3);
  });

  it('closes a stalled partial control body at its progress deadline without another fragment', async () => {
    let entered = 0;
    const h = await controls(async () => {
      entered++;
      return {};
    }, 250);
    const started = performance.now();
    const partial = h.begin(true);
    await expect.poll(() => h.admission.snapshot().control).toBe(1);
    // Bounded by the assertion, not the client's or server's 10-second socket timeout.
    await expect.poll(() => clients.has(partial.request), { timeout: 1500 }).toBe(false);
    await partial.closed;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(entered).toBe(0);
    await expect.poll(() => h.admission.snapshot().control).toBe(0);
    expect(await h.begin().settled).toBe(200);
  });
});

describe('request cancellation reaches real control dependencies', () => {
  it.each(['seal', 'retention', 'maintenance', 'revoke'] as const)(
    'cancels blocked %s SQL and closes its backend before releasing the operation',
    async (kind) => {
      const h = (fixture = await createPressureHarness());
      const s3 = createStorageObjectS3({
        endpoint: h.backend.endpoint,
        bucket: 'task-output',
        custody: { read: async () => h.backend.credentials },
      });
      const seal = createStorageSeal({
        connectionString: workerDatabaseUrl(),
        s3,
        access: h.access,
      });
      const maintenance = createStorageMaintenance({ connectionString: workerDatabaseUrl() });
      const retention = createStorageRetention({
        connectionString: workerDatabaseUrl(),
        s3,
        owner: {
          bootId: 'control-test',
          isLive: () => false,
          ready: async () => undefined,
          assertActive: () => undefined,
          register: () => new AbortController().signal,
          unregister: () => undefined,
          close: async () => undefined,
        },
        settings: { read: async () => undefined },
        logger: createRecordingLogger([]),
      });
      const blocker = await h.stores.postgres.connect();
      const controller = new AbortController();
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      const name = kind === 'revoke' ? 'access' : kind;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE storage.maintenance IN ACCESS EXCLUSIVE MODE');
        const operation =
          kind === 'seal'
            ? seal.allocate(
                {
                  taskId: 'cancel',
                  launchId: 'cancel',
                  effectKey: 'cancel',
                  retentionRevision: 'one',
                },
                controller.signal
              )
            : kind === 'retention'
              ? retention.pending({}, controller.signal)
              : kind === 'maintenance'
                ? maintenance.status(controller.signal)
                : h.access.revoke('a', '0', 'cancel', controller.signal);
        const settled = operation.then(
          () => {
            outcome = 'resolved';
          },
          () => {
            outcome = 'rejected';
          }
        );
        const activity = async () =>
          (
            await h.stores.postgres.query<{ pid: number }>(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
              [`lifemodel-storage-${name}`]
            )
          ).rows;
        await expect.poll(async () => (await activity()).length).toBe(1);
        const pid = (await activity())[0]!.pid;
        const started = performance.now();
        controller.abort();
        await expect.poll(() => outcome, { timeout: 1500 }).toBe('rejected');
        await settled;
        expect(performance.now() - started).toBeLessThan(1500);
        expect(
          (await h.stores.postgres.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid]))
            .rowCount
        ).toBe(0);
        await blocker.query('ROLLBACK');
        // A canceled statement cannot publish a late receipt after unlock.
        expect(
          (
            await h.stores.postgres.query(
              "SELECT 1 FROM storage.allocate_receipts WHERE effect_key='cancel'"
            )
          ).rowCount
        ).toBe(0);
      } finally {
        controller.abort();
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.all([seal.close(), maintenance.close(), retention.close()]);
        s3.close();
      }
    }
  );

  it('aborts a seal backend verification and issues no later cleanup work', async () => {
    const h = (fixture = await createPressureHarness());
    const s3 = createStorageObjectS3({
      endpoint: h.backend.endpoint,
      bucket: 'task-output',
      custody: { read: async () => h.backend.credentials },
    });
    const seal = createStorageSeal({ connectionString: workerDatabaseUrl(), s3, access: h.access });
    const controller = new AbortController();
    let outcome = 'pending';
    try {
      await h.stores.postgres.query("UPDATE storage.spaces SET mode='open' WHERE id='reader'");
      h.backend.hooks.beforeHead = () => 'hang';
      const work = seal
        .seal(
          { space: 'reader', effectKey: 'cancel-s3', expectedRevision: '0', outcome: 'stopped' },
          controller.signal
        )
        .then(
          () => {
            outcome = 'resolved';
          },
          () => {
            outcome = 'rejected';
          }
        );
      await expect.poll(() => h.backend.requests.filter((r) => r.method === 'HEAD').length).toBe(1);
      controller.abort();
      await expect.poll(() => outcome, { timeout: 1500 }).toBe('rejected');
      await work;
      expect(h.backend.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
      expect(
        (
          await h.stores.postgres.query(
            "SELECT 1 FROM storage.seal_receipts WHERE effect_key='cancel-s3'"
          )
        ).rowCount
      ).toBe(0);
      delete h.backend.hooks.beforeHead;
      expect(
        (
          await seal.seal({
            space: 'reader',
            effectKey: 'cancel-s3',
            expectedRevision: '0',
            outcome: 'stopped',
          })
        ).state
      ).toBe('sealed');
    } finally {
      controller.abort();
      await seal.close();
      s3.close();
    }
  });
});
