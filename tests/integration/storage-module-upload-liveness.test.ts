import { createStorageUploadOwner } from '../../loader/src/storage-upload-owner.js';
import { workerDatabaseUrl } from '../helpers/test-stores.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createRetentionHarness,
  DAY,
  TERMINAL,
  gate,
  sha256,
} from '../helpers/storage-retention-harness.js';
let h: Awaited<ReturnType<typeof createRetentionHarness>>;
beforeAll(async () => {
  h = await createRetentionHarness();
}, 30000);
beforeEach(async () => {
  await h.reset();
}, 20000);
afterEach(async () => {
  await h.cleanup();
}, 20000);
afterAll(async () => {
  await h?.close();
}, 20000);

async function holdUpload(task = 'a') {
  const space = await h.prepare(task);
  const reached = gate(),
    release = gate();
  h.releases.push(release.resolve);
  let key = '';
  h.backend.hooks.afterWrite = async (r) => {
    key = r.key;
    reached.resolve();
    await release.promise;
  };
  const put = h.upload(space, task);
  void put.catch(() => undefined);
  await reached.promise;
  await h.stores.postgres.query(
    `UPDATE storage.upload_attempts SET created_at=to_timestamp($2/1000.0) WHERE space_id=$1`,
    [space, TERMINAL]
  );
  await h.stores.postgres.query(
    `UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1`,
    [space, TERMINAL + DAY]
  );
  await h.clock(TERMINAL + 2 * DAY + 1000);
  return { space, key, put, release };
}
describe('durable upload transfer ownership', () => {
  it('fails closed on a renewal gap then accepts a new PUT and becomes ready without restart', async () => {
    const space = await h.prepare();
    const first = await h.upload(space);
    const boot = (
      await h.stores.postgres.query(
        'SELECT owner_boot_id FROM storage.upload_attempts WHERE s3_key=$1',
        [first.key]
      )
    ).rows[0].owner_boot_id;
    h.sqlProxy.drop();
    await h.ownerClock(31000);
    expect(await h.ipc('readiness')).toBe(false);
    h.sqlProxy.restore();
    // SQL must still reject a replacement until the original durable boot is stale.
    expect(await h.ipc('readiness')).toBe(false);
    await h.stores.postgres.query(
      "UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE boot_id=$1",
      [boot]
    );
    const second = await h.upload(space, 'a', 'recovered');
    expect(await h.ipc('readiness')).toBe(true);
    expect(h.child().process.exitCode).toBeNull();
    const newBoot = (
      await h.stores.postgres.query(
        'SELECT owner_boot_id FROM storage.upload_attempts WHERE s3_key=$1',
        [second.key]
      )
    ).rows[0].owner_boot_id;
    expect(newBoot).not.toBe(boot);
    await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,1,$5,3600)', [
      space,
      'stale-boot',
      randomUUID(),
      'stale.txt',
      'a'.repeat(64),
    ]);
    expect(
      (
        await h.stores.postgres.query('SELECT storage.begin_attempt($1,$2,$3,$4,$5) AS ok', [
          randomUUID(),
          space,
          'stale-boot',
          `private/${randomUUID()}`,
          boot,
        ])
      ).rows[0].ok
    ).toBe(false);
  }, 30000);

  it('renews durable ownership while a progressing transfer outlives its original lease', async () => {
    const held = await holdUpload();
    const owner = (
      await h.stores.postgres.query(
        'SELECT owner_boot_id FROM storage.upload_attempts WHERE s3_key=$1',
        [held.key]
      )
    ).rows[0].owner_boot_id;
    expect(owner).toEqual(expect.any(String));
    const aged = (
      await h.stores.postgres.query(
        `UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()-interval '45 seconds' WHERE boot_id=$1 RETURNING heartbeat_at`,
        [owner]
      )
    ).rows[0].heartbeat_at;
    await expect
      .poll(
        async () =>
          (
            await h.stores.postgres.query(
              'SELECT heartbeat_at FROM storage.upload_owners WHERE boot_id=$1',
              [owner]
            )
          ).rows[0].heartbeat_at.getTime(),
        { timeout: 7000 }
      )
      .toBeGreaterThan(aged.getTime());
    await h.tick();
    expect(
      h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === held.key)
    ).toHaveLength(0);
    held.release.resolve();
    expect((await held.put).key).toBe(held.key);
  }, 30000);
  it('reclaims its own settled failed transfer without waiting for the live boot to become stale', async () => {
    const space = await h.prepare();
    const bytes = Buffer.from('failed');
    h.backend.hooks.beforePut = () => ({ status: 500 });
    const reply = await h.call('task', 'PUT', `/spaces/${space}/objects/failure`, bytes, 'a', {
      'x-storage-name': Buffer.from('failed.txt').toString('base64url'),
      'x-storage-length': String(bytes.length),
      'x-storage-sha256': sha256(bytes),
    });
    expect(reply.status).toBe(503);
    await h.stores.postgres.query(
      'UPDATE storage.upload_attempts SET created_at=to_timestamp($1/1000.0)',
      [TERMINAL]
    );
    await h.stores.postgres.query(
      'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($1/1000.0)',
      [TERMINAL]
    );
    await h.clock(TERMINAL + 2 * DAY + 1000);
    await h.tick();
    expect((await h.stores.postgres.query('SELECT deleted FROM storage.attempt_gc')).rows).toEqual([
      { deleted: true },
    ]);
  }, 30000);
  it('never retires or DELETEs a real held PUT with an expired original reservation lease', async () => {
    const held = await holdUpload();
    await h.tick();
    expect(
      h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === held.key)
    ).toHaveLength(0);
    expect(
      (await h.stores.postgres.query('SELECT count(*)::int AS n FROM storage.attempt_gc')).rows[0].n
    ).toBe(0);
    held.release.resolve();
    const published = await held.put;
    expect(published.key).toBe(held.key);
  }, 30000);
  it("a second module does not retire the other module's live PUT", async () => {
    const first = h.child();
    const held = await holdUpload();
    const second = await h.start();
    const other = await holdUpload('b');
    await h.tick(second);
    await h.tick(first);
    for (const live of [held, other]) {
      expect(
        h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === live.key)
      ).toHaveLength(0);
      live.release.resolve();
      expect((await live.put).key).toBe(live.key);
    }
  }, 30000);
  it('recovers a SIGKILLed owner only after its durable heartbeat is stale', async () => {
    const first = h.child();
    const held = await holdUpload();
    const second = await h.start();
    await h.kill(first);
    await h.tick(second);
    expect(
      h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === held.key)
    ).toHaveLength(0);
    // Move the persisted last heartbeat, not the reservation lease, past the
    // production staleness bound. No wall-clock sleep or simulated PUT replaces it.
    await h.stores.postgres.query(
      `UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE boot_id=(SELECT owner_boot_id FROM storage.upload_attempts WHERE s3_key=$1)`,
      [held.key]
    );
    await h.tick(second);
    expect(
      h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === held.key)
    ).toHaveLength(1);
    expect(
      (await h.stores.postgres.query('SELECT deleted FROM storage.attempt_gc')).rows[0].deleted
    ).toBe(true);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
    held.release.resolve();
    await held.put.catch(() => undefined);
  }, 30000);
});

describe('per-key failure isolation', () => {
  it('bounds pruning and keeps fresh owners and unconfirmed garbage protected', async () => {
    const space = await h.prepare();
    await h.stores.postgres.query(
      `INSERT INTO storage.upload_owners(boot_id,heartbeat_at) SELECT gen_random_uuid(),clock_timestamp()-interval '8 days' FROM generate_series(1,105)`
    );
    const fresh = randomUUID();
    await h.stores.postgres.query(
      'INSERT INTO storage.upload_owners VALUES($1,clock_timestamp())',
      [fresh]
    );
    for (const [upload, deleted] of [
      ['confirmed', true],
      ['pending', false],
    ] as const) {
      const attempt = randomUUID(),
        key = `private/${attempt}`;
      await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,1,$5,3600)', [
        space,
        upload,
        randomUUID(),
        `${upload}.txt`,
        'a'.repeat(64),
      ]);
      await h.stores.postgres.query(
        'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
        [attempt, space, upload, key]
      );
      await h.stores.postgres.query(
        'INSERT INTO storage.attempt_gc(attempt_id,space_id,s3_key,size,deleted,deleted_at) VALUES($1,$2,$3,1,$4,to_timestamp($5/1000.0))',
        [attempt, space, key, deleted, TERMINAL - 3 * DAY]
      );
    }
    const sealed = await h.artifact('b');
    const sealedAttempt = randomUUID();
    const sealedKey = `private/${sealedAttempt}`;
    await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,1,$5,3600)', [
      sealed.space,
      'retired-before-seal',
      randomUUID(),
      'retired.txt',
      'a'.repeat(64),
    ]);
    await h.stores.postgres.query(
      'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
      [sealedAttempt, sealed.space, 'retired-before-seal', sealedKey]
    );
    await h.stores.postgres.query(
      'INSERT INTO storage.attempt_gc(attempt_id,space_id,s3_key,size,deleted,deleted_at) VALUES($1,$2,$3,1,true,to_timestamp($4/1000.0))',
      [sealedAttempt, sealed.space, sealedKey, TERMINAL - 3 * DAY]
    );
    await h.stores.postgres.query(
      'INSERT INTO storage.seal_gc(space_id,attempt_id,s3_key,deleted) VALUES($1,$2,$3,true)',
      [sealed.space, sealedAttempt, sealedKey]
    );
    const oldOrphan = `private/${randomUUID()}`,
      pendingOrphan = `private/${randomUUID()}`;
    for (const [key, deleted] of [
      [oldOrphan, true],
      [pendingOrphan, false],
    ] as const)
      await h.stores.postgres.query(
        'INSERT INTO storage.orphan_gc(s3_key,size,first_seen_at,last_modified,deleted,deleted_at) VALUES($1,0,to_timestamp($3/1000.0),to_timestamp($3/1000.0),$2,to_timestamp($3/1000.0))',
        [key, deleted, TERMINAL - 3 * DAY]
      );
    h.backend.hooks.beforeDelete = () => ({ status: 500 });
    await h.tick();
    expect(
      (
        await h.stores.postgres.query(
          "SELECT count(*)::int AS n FROM storage.upload_owners WHERE heartbeat_at<clock_timestamp()-interval '7 days'"
        )
      ).rows[0].n
    ).toBe(5);
    expect(
      (
        await h.stores.postgres.query('SELECT 1 FROM storage.upload_owners WHERE boot_id=$1', [
          fresh,
        ])
      ).rowCount
    ).toBe(1);
    expect((await h.stores.postgres.query('SELECT deleted FROM storage.attempt_gc')).rows).toEqual([
      { deleted: false },
    ]);
    expect(
      (
        await h.stores.postgres.query(
          "SELECT 1 FROM storage.upload_attempts WHERE upload_id='confirmed'"
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await h.stores.postgres.query('SELECT s3_key FROM storage.orphan_gc ORDER BY s3_key')).rows
    ).toEqual([{ s3_key: pendingOrphan }]);
    await h.tick();
    expect(
      (
        await h.stores.postgres.query(
          "SELECT count(*)::int AS n FROM storage.upload_owners WHERE heartbeat_at<clock_timestamp()-interval '7 days'"
        )
      ).rows[0].n
    ).toBe(0);
  }, 30000);

  it('a failed expired attempt keeps its intent and charge but does not block an unrelated retention plan', async () => {
    const active = await h.prepare('a');
    await h.stores.postgres.query(
      `SELECT storage.reserve_upload($1,'abandoned',$2,'a/old.txt',1,$3,3600)`,
      [active, randomUUID(), 'a'.repeat(64)]
    );
    const key = `private/${randomUUID()}`;
    await h.stores.postgres.query(
      `INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,created_at) VALUES($1,$2,'abandoned',$3,to_timestamp($4/1000.0))`,
      [randomUUID(), active, key, TERMINAL]
    );
    await h.stores.postgres.query(
      `UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1`,
      [active, TERMINAL]
    );
    await h.artifact('b');
    h.backend.hooks.beforeDelete = (r) => (r.key === key ? { status: 500 } : undefined);
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick().catch(() => undefined);
    expect((await h.pending()).plans).toHaveLength(1);
    expect(
      (await h.stores.postgres.query('SELECT deleted FROM storage.attempt_gc')).rows[0].deleted
    ).toBe(false);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT reserved_bytes::text FROM storage.space_quota WHERE space_id=$1',
          [active]
        )
      ).rows[0].reserved_bytes
    ).toBe('1');
    delete h.backend.hooks.beforeDelete;
    await h.tick();
    expect(
      (await h.stores.postgres.query('SELECT deleted FROM storage.attempt_gc')).rows[0].deleted
    ).toBe(true);
  }, 30000);
  it('a failed first orphan keeps its charge while later orphans delete and retention still plans', async () => {
    const bad = 'private/11111111-1111-4111-8111-111111111111';
    const good = 'private/22222222-2222-4222-8222-222222222222';
    const bytes = Buffer.from('orphan');
    for (const key of [bad, good])
      h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL });
    await h.artifact();
    h.backend.hooks.beforeDelete = (r) => (r.key === bad ? { status: 500 } : undefined);
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick().catch(() => undefined);
    expect(h.backend.objects.has(good)).toBe(false);
    expect(h.backend.objects.has(bad)).toBe(true);
    expect((await h.pending()).plans).toHaveLength(1);
    expect(
      (
        await h.stores.postgres.query('SELECT deleted FROM storage.orphan_gc WHERE s3_key=$1', [
          bad,
        ])
      ).rows[0].deleted
    ).toBe(false);
    delete h.backend.hooks.beforeDelete;
    await h.tick();
    expect(h.backend.objects.has(bad)).toBe(false);
  }, 30000);
});

describe('owner state-machine PostgreSQL regressions', () => {
  const owners: ReturnType<typeof createStorageUploadOwner>[] = [];
  function owner(now?: () => number) {
    const result = createStorageUploadOwner({
      connectionString: workerDatabaseUrl(),
      now,
    });
    owners.push(result);
    return result;
  }
  async function heartbeat(boot: string) {
    return (
      await h.stores.postgres.query(
        'SELECT heartbeat_at FROM storage.upload_owners WHERE boot_id=$1',
        [boot]
      )
    ).rows[0]?.heartbeat_at as Date | undefined;
  }
  async function stale(boot: string) {
    await h.stores.postgres.query(
      "UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE boot_id=$1",
      [boot]
    );
  }
  async function waitingFor(query: string) {
    await expect
      .poll(
        async () =>
          Number(
            (
              await h.stores.postgres.query(
                `SELECT count(*) AS n FROM pg_stat_activity
               WHERE application_name='lifemodel-storage-upload-owner'
                 AND wait_event_type='Lock' AND query LIKE $1`,
                [query]
              )
            ).rows[0].n
          ),
        { timeout: 7_000 }
      )
      .toBe(1);
  }

  const unavailable = { status: 503, code: 'upload_owner_unavailable' };

  describe('replaceable durable upload ownership', () => {
    beforeEach(async () => {
      await h.kill();
    });
    afterEach(async () => {
      await Promise.all(owners.splice(0).map((entry) => entry.close()));
    }, 15000);
    it('recovers an expired boot once, without reviving its heartbeat or abort controller', async () => {
      const uploadOwner = owner();
      await uploadOwner.ready();
      const oldBoot = uploadOwner.bootId;
      const attempt = randomUUID();
      const oldSignal = uploadOwner.register(attempt);
      await stale(oldBoot);
      const oldHeartbeat = await heartbeat(oldBoot);
      // The real renewal timer observes the stale DB row and aborts this boot.
      await expect.poll(() => oldSignal.aborted, { timeout: 7_000 }).toBe(true);
      expect(() => uploadOwner.register(randomUUID())).toThrow();
      await Promise.all(Array.from({ length: 8 }, () => uploadOwner.ready()));
      expect(uploadOwner.bootId).not.toBe(oldBoot);
      expect(await heartbeat(oldBoot)).toEqual(oldHeartbeat);
      expect(await heartbeat(uploadOwner.bootId)).toBeInstanceOf(Date);
      const replacementBoot = uploadOwner.bootId;
      await uploadOwner.ready();
      expect(uploadOwner.bootId).toBe(replacementBoot);
      expect(oldSignal.aborted).toBe(true);
      expect(uploadOwner.register(randomUUID()).aborted).toBe(false);
      uploadOwner.unregister(attempt);
      expect(uploadOwner.isLive(attempt)).toBe(false);
    }, 15_000);

    it('aborts at the local 30-second bound but waits for DB staleness before replacement', async () => {
      let now = 0;
      const uploadOwner = owner(() => now);
      await uploadOwner.ready();
      const oldBoot = uploadOwner.bootId;
      const oldSignal = uploadOwner.register(randomUUID());
      now = 29_999;
      expect(() => uploadOwner.assertActive()).not.toThrow();
      now = 30_000;
      expect(() => uploadOwner.assertActive()).toThrow();
      expect(oldSignal.aborted).toBe(true);
      await expect(uploadOwner.ready()).rejects.toMatchObject(unavailable);
      expect(uploadOwner.bootId).toBe(oldBoot);
      // Even an arbitrarily advanced local clock cannot prove cross-process expiry.
      now = 600_000;
      await expect(uploadOwner.ready()).rejects.toMatchObject(unavailable);
      expect(uploadOwner.bootId).toBe(oldBoot);
      await stale(oldBoot);
      await uploadOwner.ready();
      expect(uploadOwner.bootId).not.toBe(oldBoot);
      expect(uploadOwner.register(randomUUID()).aborted).toBe(false);
      await uploadOwner.close();
      await expect(uploadOwner.ready()).rejects.toMatchObject(unavailable);
    });

    it('settles a failed in-flight initialization before deciding that its boot can be replaced', async () => {
      let now = 0;
      const uploadOwner = owner(() => now);
      const oldBoot = uploadOwner.bootId;
      const blocker = await h.stores.postgres.connect();
      let initializing: Promise<void> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE storage.upload_owners IN ACCESS EXCLUSIVE MODE');
        initializing = uploadOwner.ready();
        void initializing.catch(() => undefined);
        await waitingFor('INSERT INTO storage.upload_owners%');
        now = 30_001;
        expect(() => uploadOwner.assertActive()).toThrow();
        // Start recovery while the old insert has not yet reached PostgreSQL.
        const recovering = uploadOwner.ready();
        void recovering.catch(() => undefined);
        await blocker.query('COMMIT');
        await expect(initializing).rejects.toMatchObject(unavailable);
        await expect(recovering).rejects.toMatchObject(unavailable);
        expect(uploadOwner.bootId).toBe(oldBoot);
        expect(await heartbeat(oldBoot)).toBeInstanceOf(Date);
        await stale(oldBoot);
        await uploadOwner.ready();
        expect(uploadOwner.bootId).not.toBe(oldBoot);
        expect(uploadOwner.register(randomUUID()).aborted).toBe(false);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await initializing?.catch(() => undefined);
      }
    }, 15_000);

    it('drains an in-flight renewal before rotating and never lets it renew the old boot', async () => {
      let now = 0;
      const uploadOwner = owner(() => now);
      await uploadOwner.ready();
      const oldBoot = uploadOwner.bootId;
      const signal = uploadOwner.register(randomUUID());
      const blocker = await h.stores.postgres.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT boot_id FROM storage.upload_owners WHERE boot_id=$1 FOR UPDATE',
          [oldBoot]
        );
        await waitingFor('SELECT boot_id FROM storage.upload_owners%');
        now = 30_001;
        expect(() => uploadOwner.assertActive()).toThrow();
        expect(signal.aborted).toBe(true);
        const recovering = Promise.all(Array.from({ length: 8 }, () => uploadOwner.ready()));
        void recovering.catch(() => undefined);
        const oldHeartbeat = (
          await blocker.query(
            "UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE boot_id=$1 RETURNING heartbeat_at",
            [oldBoot]
          )
        ).rows[0].heartbeat_at;
        await blocker.query('COMMIT');
        await recovering;
        expect(uploadOwner.bootId).not.toBe(oldBoot);
        expect(await heartbeat(oldBoot)).toEqual(oldHeartbeat);
        expect(uploadOwner.register(randomUUID()).aborted).toBe(false);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    }, 15_000);
  });
});
