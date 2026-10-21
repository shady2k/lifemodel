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
