import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createStorageMaintenance,
  STORAGE_REOPEN_GRACE_MS,
  STORAGE_READ_LEASE_MS,
  STORAGE_CORE_READ_PROGRESS_MS,
} from '../../loader/src/storage-maintenance.js';
import { workerDatabaseUrl } from '../helpers/test-stores.js';
import {
  createRetentionHarness,
  DAY,
  TERMINAL,
  sha256,
  gate,
} from '../helpers/storage-retention-harness.js';
let h: Awaited<ReturnType<typeof createRetentionHarness>>;
const maintainers: ReturnType<typeof createStorageMaintenance>[] = [];
function maintenance(
  options: { drainMs?: number; settleMs?: number; connectionString?: string } = {}
) {
  const result = createStorageMaintenance({ connectionString: workerDatabaseUrl(), ...options });
  maintainers.push(result);
  return result;
}
beforeAll(async () => {
  h = await createRetentionHarness();
}, 30000);
beforeEach(async () => {
  await h.reset();
}, 20000);
afterEach(async () => {
  for (const item of maintainers.splice(0)) await item.close();
  await h.cleanup();
}, 20000);
afterAll(async () => {
  await h?.close();
}, 20000);

async function catalogSnapshot(tables: readonly string[]) {
  const rows: Record<string, unknown> = {};
  for (const table of tables) {
    rows[table] = (
      await h.stores.postgres.query(
        `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM storage.${table} t`
      )
    ).rows[0].rows;
  }
  return rows;
}
const allocationTables = [
  'spaces',
  'allocations',
  'allocate_receipts',
  'space_quota',
  'instance_ledger',
];
const retentionTables = [
  'orphan_gc',
  'instance_ledger',
  'space_quota',
  'deletion_candidates',
  'deletion_plans',
  'retention_policies',
  'retention_tombstones',
  'object_tombstones',
];

const begin = () => h.call('control', 'POST', '/maintenance/begin', { effectKey: 'backup-one' });
const release = (generation: string) =>
  h.call('control', 'POST', '/maintenance/release', { generation });
describe('durable storage backup hold', () => {
  it('keeps release grace at least the lease TTL and core chunk progress deadline', () => {
    expect(STORAGE_REOPEN_GRACE_MS).toBeGreaterThanOrEqual(STORAGE_READ_LEASE_MS);
    expect(STORAGE_REOPEN_GRACE_MS).toBeGreaterThanOrEqual(STORAGE_CORE_READ_PROGRESS_MS);
  });

  it.each(['held-admission', 'expired-before-hold'] as const)(
    'hands an active %s reader to a writable lease before GC can delete',
    async (admission) => {
      const leaseMs = STORAGE_READ_LEASE_MS;
      const graceMs = STORAGE_REOPEN_GRACE_MS;
      const obj = await h.artifact('a', Buffer.alloc(8 * 1024 * 1024 + 8, 97));
      await h.clock(TERMINAL + 90 * DAY);
      await h.tick();
      await h.warn((await h.pending()).plans[0].id);
      const startedAt = TERMINAL + 98 * DAY;
      await h.clock(startedAt);
      let held = admission === 'held-admission' ? await begin() : undefined;
      const second = gate();
      const resumeSecond = gate();
      const third = gate();
      const resumeThird = gate();
      h.releases.push(resumeSecond.resolve, resumeThird.resolve);
      let gets = 0;
      h.backend.hooks.beforeGet = async (record) => {
        if (record.key !== obj.key) return;
        gets++;
        if (gets === 2) {
          second.resolve();
          await resumeSecond.promise;
        } else if (gets === 3) {
          third.resolve();
          await resumeThird.promise;
        }
      };
      const reading = h.call('read', 'GET', `/spaces/${obj.space}/objects/${obj.id}`);
      void reading.catch(() => undefined);
      await second.promise;
      if (admission === 'expired-before-hold') {
        expect(
          (
            await h.stores.postgres.query('SELECT id FROM storage.read_leases WHERE space_id=$1', [
              obj.space,
            ])
          ).rowCount
        ).toBe(1);
        held = await begin();
      } else {
        expect(
          (
            await h.stores.postgres.query('SELECT id FROM storage.read_leases WHERE space_id=$1', [
              obj.space,
            ])
          ).rowCount
        ).toBe(0);
      }
      expect(held!.status).toBe(200);
      // Simulate a long hold without sleeping; the next held chunk cannot renew.
      const reopenedAt = startedAt + leaseMs + 1;
      await h.clock(reopenedAt);
      const leases = () =>
        h.stores.postgres.query(
          'SELECT id FROM storage.read_leases WHERE space_id=$1 AND expires_at>to_timestamp($2/1000.0)',
          [obj.space, reopenedAt]
        );
      expect((await leases()).rowCount).toBe(0);
      expect((await release(held!.json.generation)).status).toBe(200);
      await h.clock(reopenedAt + graceMs - 1);
      await h.tick();
      expect(h.backend.objects.has(obj.key)).toBe(true);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
            [obj.id]
          )
        ).rows[0].state
      ).toBe('pending');
      const savedReopenedAt = (
        await h.stores.postgres.query('SELECT reopened_at FROM storage.maintenance WHERE id=true')
      ).rows[0].reopened_at;
      expect(savedReopenedAt.getTime()).toBe(reopenedAt);
      // An idempotent retry must not perpetually postpone pending deletion.
      expect((await release(held!.json.generation)).status).toBe(200);
      expect(
        (await h.stores.postgres.query('SELECT reopened_at FROM storage.maintenance WHERE id=true'))
          .rows[0].reopened_at
      ).toEqual(savedReopenedAt);
      // Remove an expired row, as a normal collector can: renewal must UPSERT,
      // not just UPDATE a lease that used to exist before a long hold.
      await h.stores.postgres.query('DELETE FROM storage.read_leases WHERE space_id=$1', [
        obj.space,
      ]);
      resumeSecond.resolve();
      await third.promise;
      expect((await leases()).rowCount).toBe(1);
      await h.clock(reopenedAt + graceMs);
      await h.tick();
      expect(h.backend.objects.has(obj.key)).toBe(true);
      expect(
        h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === obj.key)
      ).toHaveLength(0);
      resumeThird.resolve();
      const read = await reading;
      expect(read.status).toBe(200);
      expect(read.body.equals(obj.bytes)).toBe(true);
      await h.clock(reopenedAt + graceMs + leaseMs);
      await h.tick();
      expect(h.backend.objects.has(obj.key)).toBe(false);
    },
    30_000
  );

  it('leaves seal, orphan and expired-upload deletions pending inside release grace', async () => {
    const space = await h.prepare();
    const unmarked = await h.upload(space);
    await h.stores.postgres.query('UPDATE storage.objects SET mark=NULL WHERE id=$1', [
      unmarked.id,
    ]);
    const abandoned = randomUUID();
    const abandonedKey = `private/${abandoned}`;
    const orphanKey = `private/${randomUUID()}`;
    const bytes = Buffer.from('private bytes');
    await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
      space,
      'expired',
      randomUUID(),
      'a/expired.txt',
      bytes.length,
      sha256(bytes),
    ]);
    await h.stores.postgres.query(
      'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,created_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))',
      [abandoned, space, 'expired', abandonedKey, TERMINAL - 3 * DAY]
    );
    await h.stores.postgres.query(
      'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1',
      [space, TERMINAL - 3 * DAY]
    );
    for (const key of [abandonedKey, orphanKey])
      h.backend.objects.set(key, {
        bytes,
        sha256: sha256(bytes),
        lastModified: TERMINAL - 3 * DAY,
      });
    const held = await begin();
    expect((await release(held.json.generation)).status).toBe(200);
    await h.clock(TERMINAL + STORAGE_REOPEN_GRACE_MS - 1);
    // Expired attempt and orphan are not readable, but share the conservative
    // deletion gate so future read paths cannot accidentally bypass the handoff.
    await h.tick();
    for (const key of [unmarked.key, abandonedKey, orphanKey])
      expect(h.backend.objects.has(key)).toBe(true);
    const sealRequest = { space, effectKey: 'seal-a', expectedRevision: '0', outcome: 'failed' };
    const pending = await h.call('control', 'POST', '/seal', sealRequest);
    expect(pending.status).toBe(503);
    expect(pending.json.error.code).toBe('cleanup_pending');
    expect(
      (
        await h.stores.postgres.query(
          'SELECT deleted FROM storage.seal_gc WHERE attempt_id=(SELECT attempt_id FROM storage.object_versions WHERE object_id=$1)',
          [unmarked.id]
        )
      ).rows[0].deleted
    ).toBe(false);
    expect(h.backend.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    await h.clock(TERMINAL + STORAGE_REOPEN_GRACE_MS);
    const sealed = await h.call('control', 'POST', '/seal', sealRequest);
    expect(sealed.status, JSON.stringify(sealed.json)).toBe(200);
    await h.tick();
    for (const key of [unmarked.key, abandonedKey, orphanKey])
      expect(h.backend.objects.has(key)).toBe(false);
  }, 30_000);

  it('finishes a timed-out draining hold with the same key and releases admission', async () => {
    const api = maintenance({ drainMs: 1, settleMs: 1 });
    const blocker = await h.stores.postgres.connect();
    blocker.on('error', () => undefined);
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock_shared(653740016)');
      await expect(api.begin({ effectKey: 'retry-draining' })).rejects.toMatchObject({
        code: 'maintenance_unavailable',
      });
      const draining = await api.status();
      expect(draining.state).toBe('draining');
      await blocker.query('COMMIT');
      await expect(api.release({ generation: draining.generation })).rejects.toMatchObject({
        code: 'hold_pending',
      });
      const retry = maintenance();
      const held = await retry.begin({ effectKey: 'retry-draining' });
      expect(held).toMatchObject({ state: 'held', generation: draining.generation });
      expect((await retry.release({ generation: held.generation })).state).toBe('normal');
      expect((await h.prepare()).length).toBeGreaterThan(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  }, 30_000);

  it('refuses all mutations including revoke while authenticated task/core reads still work; restarts and releases a crash-left hold', async () => {
    const space = await h.prepare();
    const obj = await h.upload(space);
    const held = await begin();
    expect(held.status).toBe(200);
    expect(held.json.state).toBe('held');
    expect((await begin()).json.generation).toBe(held.json.generation);
    expect((await h.call('task', 'GET', `/spaces/${space}/objects/${obj.id}`)).body).toEqual(
      obj.bytes
    );
    expect((await h.call('read', 'GET', `/spaces/${space}/objects/${obj.id}`)).body).toEqual(
      obj.bytes
    );
    expect((await h.call('task', 'GET', `/spaces/${space}/objects`)).status).toBe(200);
    expect((await h.call('task', 'GET', `/spaces/${space}/access`)).status).toBe(200);
    expect(
      (await h.call('task', 'POST', `/spaces/${space}/objects/${obj.id}/mark`, { role: 'result' }))
        .status
    ).toBe(503);
    const bytes = Buffer.from('not admitted');
    expect(
      (
        await h.call('task', 'PUT', `/spaces/${space}/objects/held`, bytes, 'a', {
          'x-storage-name': Buffer.from('held.txt').toString('base64url'),
          'x-storage-length': String(bytes.length),
          'x-storage-sha256': sha256(bytes),
        })
      ).status
    ).toBe(503);
    expect(
      (
        await h.call('control', 'POST', '/seal', {
          space,
          effectKey: 'held-seal',
          expectedRevision: '0',
          outcome: 'completed',
        })
      ).status
    ).toBe(503);
    expect((await h.call('control', 'GET', '/retention/plans')).status).toBe(503);
    expect(
      (await h.call('control', 'POST', '/maintenance/begin', { effectKey: 'task' }, 'a')).status
    ).toBe(403);
    await h.kill();
    await h.start();
    expect((await h.call('control', 'GET', '/maintenance/status')).json.state).toBe('held');
    expect((await release('00000000-0000-4000-8000-000000000000')).status).toBe(409);
    expect((await release(held.json.generation)).status).toBe(200);
    expect((await release(held.json.generation)).status).toBe(200);
    expect(
      (await h.call('task', 'POST', `/spaces/${space}/objects/${obj.id}/mark`, { role: 'result' }))
        .status
    ).toBe(200);
    await begin();
    expect(
      (
        await h.call('control', 'POST', '/revoke', {
          space,
          expectedRevision: '0',
          effectKey: 'held-revoke',
        })
      ).status
    ).toBe(503);
    expect((await h.call('task', 'GET', `/spaces/${space}/objects/${obj.id}`)).status).toBe(200);
  }, 30000);
  it('pauses deletion and orphan passes, preserving their byte/accounting work until release', async () => {
    const obj = await h.artifact();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plan = (await h.pending()).plans[0];
    await h.warn(plan.id);
    await h.clock(TERMINAL + 98 * DAY);
    const held = await begin();
    expect(held.status).toBe(200);
    const before = h.backend.requests.length;
    await h.tick();
    expect(
      h.backend.requests.slice(before).filter((r) => r.method === 'DELETE' || r.method === 'GET')
    ).toEqual([]);
    expect(h.backend.objects.has(obj.key)).toBe(true);
    expect((await h.call('read', 'GET', `/spaces/${obj.space}/objects/${obj.id}`)).status).toBe(
      200
    );
    await release(held.json.generation);
    await h.clock(TERMINAL + 98 * DAY + STORAGE_REOPEN_GRACE_MS);
    await h.tick();
    expect(h.backend.objects.has(obj.key)).toBe(false);
  }, 30000);
  it('holds through a different child while PUT is stalled, refuses publication and collects the private orphan after release', async () => {
    const space = await h.prepare();
    const writer = h.child();
    const holder = await h.start();
    const arrived = gate();
    const proceed = gate();
    h.releases.push(proceed.resolve);
    let key = '';
    h.backend.hooks.beforeCommit = async (request) => {
      key = request.key;
      arrived.resolve();
      await proceed.promise;
    };
    const bytes = Buffer.from('cut member');
    const writing = h.call(
      'task',
      'PUT',
      `/spaces/${space}/objects/cut-member`,
      bytes,
      'a',
      {
        'x-storage-name': Buffer.from('cut.txt').toString('base64url'),
        'x-storage-length': String(bytes.length),
        'x-storage-sha256': sha256(bytes),
      },
      writer
    );
    await arrived.promise;
    const held = await h.call(
      'control',
      'POST',
      '/maintenance/begin',
      { effectKey: 'put-cut' },
      'core',
      {},
      holder
    );
    expect(held.status).toBe(200);
    expect(held.json.state).toBe('held');
    expect(h.backend.objects.has(key)).toBe(false);
    const snapshot = async () => ({
      objects: (await h.stores.postgres.query('SELECT * FROM storage.objects')).rows,
      versions: (await h.stores.postgres.query('SELECT * FROM storage.object_versions')).rows,
      intents: (await h.stores.postgres.query('SELECT * FROM storage.upload_intents')).rows,
      attempts: (await h.stores.postgres.query('SELECT * FROM storage.upload_attempts')).rows,
      quota: (await h.stores.postgres.query('SELECT * FROM storage.space_quota')).rows,
      ledger: (await h.stores.postgres.query('SELECT * FROM storage.instance_ledger')).rows,
    });
    const cut = await snapshot();
    expect(cut.objects).toEqual([]);
    expect(cut.versions).toEqual([]);
    expect(cut.intents[0]).toMatchObject({ state: 'pending', reserved: true });
    proceed.resolve();
    expect((await writing).status).toBe(503);
    expect(h.backend.objects.get(key)?.bytes).toEqual(bytes);
    expect(await snapshot()).toEqual(cut);
    expect((await release(held.json.generation)).status).toBe(200);
    delete h.backend.hooks.beforeCommit;
    await h.clock(TERMINAL + 3 * DAY);
    // The original owner knows this settled transfer is no longer live.
    await h.tick(writer);
    expect(h.backend.objects.has(key)).toBe(false);
    expect((await h.stores.postgres.query('SELECT * FROM storage.object_versions')).rows).toEqual(
      []
    );
    expect(
      (
        await h.stores.postgres.query('SELECT deleted FROM storage.attempt_gc WHERE s3_key=$1', [
          key,
        ])
      ).rows
    ).toEqual([{ deleted: true }]);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT reserved_bytes::text FROM storage.space_quota WHERE space_id=$1',
          [space]
        )
      ).rows[0].reserved_bytes
    ).toBe('0');
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
  }, 30000);
  it('never serves catalog-only restored versions, including zero bytes, lists and receipt retry', async () => {
    const space = await h.prepare();
    const obj = await h.upload(space, 'a', 'empty', Buffer.alloc(0));
    const held = await begin();
    const generation = held.json.generation;
    await h.stores.postgres.query(
      "INSERT INTO storage.version_availability(object_id,generation,status) VALUES($1,$2,'missing')",
      [obj.id, generation]
    );
    expect((await h.call('task', 'GET', `/spaces/${space}/objects/${obj.id}`)).status).toBe(404);
    expect((await h.call('read', 'GET', `/spaces/${space}/objects/${obj.id}`)).status).toBe(404);
    expect((await h.call('task', 'GET', `/spaces/${space}/objects`)).json.objects).toEqual([]);
    await release(generation);
    const retry = await h.call(
      'task',
      'PUT',
      `/spaces/${space}/objects/empty`,
      Buffer.alloc(0),
      'a',
      {
        'x-storage-name': Buffer.from('a/empty.txt').toString('base64url'),
        'x-storage-length': '0',
        'x-storage-sha256': sha256(Buffer.alloc(0)),
      }
    );
    expect(retry.status).toBe(404);
    expect(
      (await h.stores.postgres.query('SELECT mark FROM storage.objects WHERE id=$1', [obj.id]))
        .rows[0].mark
    ).toBe('result');
  }, 30000);
});

describe('restore hold release and transaction-local maintenance safety', () => {
  it('requires exact explicit degraded acceptance, preserves unavailable versions, marks and charges, and resumes writes and GC', async () => {
    const missing = await h.artifact();
    const activeSpace = await h.prepare('b');
    const available = await h.upload(activeSpace, 'b');
    const api = maintenance();
    await begin();
    const generation = randomUUID();
    await api.prepareRestore({ generation, artifactSha256: 'a'.repeat(64) });
    await h.stores.postgres.query(
      "UPDATE storage.version_availability SET status=CASE WHEN object_id=$1 THEN 'missing' ELSE 'available' END,checked_at=clock_timestamp()",
      [missing.id]
    );
    const before = (await h.stores.postgres.query('SELECT used_bytes FROM storage.instance_ledger'))
      .rows;
    await expect(api.releaseDegraded({ generation, unavailable: 1 })).rejects.toMatchObject({
      code: 'restore_pending',
    });
    await h.stores.postgres.query(
      'UPDATE storage.restore_progress SET complete=true,unavailable=1 WHERE generation=$1',
      [generation]
    );
    await expect(api.release({ generation })).rejects.toMatchObject({ code: 'restore_pending' });
    await expect(
      api.releaseDegraded({ generation: randomUUID(), unavailable: 1 })
    ).rejects.toMatchObject({ code: 'hold_conflict' });
    await expect(api.releaseDegraded({ generation, unavailable: 2 })).rejects.toMatchObject({
      code: 'restore_pending',
    });
    for (const unavailable of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(api.releaseDegraded({ generation, unavailable })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    await expect(
      api.releaseDegraded({ generation, unavailable: 1, force: true })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // Restart may not turn a completed-but-unreleased restore into normal service.
    await h.kill();
    await h.start();
    expect((await h.call('control', 'GET', '/maintenance/status')).json).toMatchObject({
      generation,
      purpose: 'restore',
      state: 'held',
    });
    expect(
      (
        await h.call(
          'task',
          'POST',
          `/spaces/${activeSpace}/objects/${available.id}/mark`,
          { role: 'result' },
          'b'
        )
      ).status
    ).toBe(503);
    expect(
      (
        await h.call(
          'task',
          'GET',
          `/spaces/${activeSpace}/objects/${available.id}`,
          undefined,
          'b'
        )
      ).body
    ).toEqual(available.bytes);
    expect(
      (await h.call('read', 'GET', `/spaces/${missing.space}/objects/${missing.id}`)).status
    ).toBe(404);
    const cut = h.backend.requests.length;
    await h.tick();
    expect(h.backend.requests.slice(cut)).toEqual([]);
    expect((await api.releaseDegraded({ generation, unavailable: 1 })).state).toBe('normal');
    expect((await api.releaseDegraded({ generation, unavailable: 1 })).state).toBe('normal');
    expect(
      (await h.call('read', 'GET', `/spaces/${missing.space}/objects/${missing.id}`)).status
    ).toBe(404);
    expect((await h.call('read', 'GET', `/spaces/${missing.space}/objects`)).json.objects).toEqual(
      []
    );
    expect(
      (
        await h.stores.postgres.query(
          'SELECT status FROM storage.version_availability WHERE object_id=$1',
          [missing.id]
        )
      ).rows[0].status
    ).toBe('missing');
    expect(
      (await h.stores.postgres.query('SELECT mark FROM storage.objects WHERE id=$1', [missing.id]))
        .rows[0].mark
    ).toBe('result');
    expect(
      (await h.stores.postgres.query('SELECT used_bytes FROM storage.instance_ledger')).rows
    ).toEqual(before);
    expect(
      (
        await h.call(
          'task',
          'POST',
          `/spaces/${activeSpace}/objects/${available.id}/mark`,
          { role: 'result' },
          'b'
        )
      ).status
    ).toBe(200);
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    expect((await h.pending()).plans).toHaveLength(1);
  }, 30000);

  it('refuses degraded acceptance for backup holds and clean restores', async () => {
    const api = maintenance();
    const held = await begin();
    await expect(
      api.releaseDegraded({ generation: held.json.generation, unavailable: 1 })
    ).rejects.toMatchObject({ code: 'restore_pending' });
    const generation = randomUUID();
    await api.prepareRestore({ generation, artifactSha256: 'b'.repeat(64) });
    await h.stores.postgres.query(
      'UPDATE storage.restore_progress SET complete=true WHERE generation=$1',
      [generation]
    );
    await expect(api.releaseDegraded({ generation, unavailable: 1 })).rejects.toMatchObject({
      code: 'restore_pending',
    });
    expect((await api.release({ generation })).state).toBe('normal');
  }, 30000);

  it('prepares a restore idempotently without resetting completed verification and refuses a conflicting artifact', async () => {
    const object = await h.artifact();
    const api = maintenance();
    await begin();
    const generation = randomUUID();
    const input = { generation, artifactSha256: 'c'.repeat(64) };
    await api.prepareRestore(input);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT status FROM storage.version_availability WHERE object_id=$1',
          [object.id]
        )
      ).rows[0].status
    ).toBe('unverified');
    await h.stores.postgres.query(
      "UPDATE storage.version_availability SET status='available',checked_at=clock_timestamp() WHERE object_id=$1",
      [object.id]
    );
    await h.stores.postgres.query(
      'UPDATE storage.restore_progress SET cursor=$1,backend_cursor=$2,inventory_complete=true,complete=true WHERE generation=$3',
      [object.id, 'saved-cursor', generation]
    );
    const snapshot = async () => ({
      availability: (await h.stores.postgres.query('SELECT * FROM storage.version_availability'))
        .rows,
      progress: (await h.stores.postgres.query('SELECT * FROM storage.restore_progress')).rows,
    });
    const before = await snapshot();
    expect((await api.prepareRestore(input)).generation).toBe(generation);
    expect(await snapshot()).toEqual(before);
    await expect(
      api.prepareRestore({ generation, artifactSha256: 'd'.repeat(64) })
    ).rejects.toMatchObject({ code: 'hold_conflict' });
    expect(await snapshot()).toEqual(before);
    await api.release({ generation });
    await api.begin({ effectKey: 'new-backup-after-restore' });
    await expect(api.prepareRestore(input)).rejects.toMatchObject({ code: 'hold_conflict' });
    expect(await snapshot()).toEqual(before);
  }, 30000);

  it('finishes held while a candidate DELETE stalls, refuses accounting and the next DELETE intent', async () => {
    const first = await h.artifact();
    const second = await h.artifact('b');
    const collector = h.child();
    const holder = await h.start();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick(collector);
    await h.warn((await h.pending()).plans[0].id);
    await h.clock(TERMINAL + 98 * DAY);
    const arrived = gate();
    const proceed = gate();
    h.releases.push(proceed.resolve);
    let deleting = '';
    h.backend.hooks.beforeDelete = async (request) => {
      deleting = request.key;
      arrived.resolve();
      await proceed.promise;
    };
    const before = h.backend.requests.length;
    const collecting = h.tick(collector);
    await arrived.promise;
    const held = await h.call(
      'control',
      'POST',
      '/maintenance/begin',
      { effectKey: 'gc-cut' },
      'core',
      {},
      holder
    );
    expect(held.status).toBe(200);
    expect(held.json.state).toBe('held');
    expect(h.backend.objects.has(deleting)).toBe(true);
    const cut = await catalogSnapshot(retentionTables);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT state,count(*)::int AS count FROM storage.deletion_candidates GROUP BY state ORDER BY state'
        )
      ).rows
    ).toEqual([
      { state: 'deleting', count: 1 },
      { state: 'pending', count: 1 },
    ]);
    proceed.resolve();
    await collecting;
    expect(h.backend.objects.has(deleting)).toBe(false);
    expect(h.backend.objects.has(deleting === first.key ? second.key : first.key)).toBe(true);
    expect(
      h.backend.requests
        .slice(before)
        .filter((r) => r.method === 'DELETE')
        .map((r) => r.key)
    ).toEqual([deleting]);
    expect(await catalogSnapshot(retentionTables)).toEqual(cut);
    expect((await release(held.json.generation)).status).toBe(200);
    delete h.backend.hooks.beforeDelete;
    await h.clock(TERMINAL + 98 * DAY + STORAGE_REOPEN_GRACE_MS);
    await h.tick(collector);
    expect(h.backend.objects.has(first.key)).toBe(false);
    expect(h.backend.objects.has(second.key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT state FROM storage.deletion_candidates ORDER BY object_id'
        )
      ).rows
    ).toEqual([{ state: 'deleted' }, { state: 'deleted' }]);
  }, 30000);

  it('refuses orphan discovery and accounting when a LIST started in another child returns after held', async () => {
    const collector = h.child();
    const holder = await h.start();
    const key = `private/${randomUUID()}`;
    const bytes = Buffer.from('unknown backend orphan');
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL - 3 * DAY });
    const arrived = gate();
    const proceed = gate();
    h.releases.push(proceed.resolve);
    h.backend.hooks.beforeList = async () => {
      arrived.resolve();
      await proceed.promise;
    };
    const collecting = h.tick(collector);
    await arrived.promise;
    const held = await h.call(
      'control',
      'POST',
      '/maintenance/begin',
      { effectKey: 'list-cut' },
      'core',
      {},
      holder
    );
    expect(held.status).toBe(200);
    expect(held.json.state).toBe('held');
    const cut = await catalogSnapshot(retentionTables);
    const before = h.backend.requests.length;
    proceed.resolve();
    await collecting;
    expect(await catalogSnapshot(retentionTables)).toEqual(cut);
    expect(
      (await h.stores.postgres.query('SELECT * FROM storage.orphan_gc WHERE s3_key=$1', [key])).rows
    ).toEqual([]);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
    expect(h.backend.objects.has(key)).toBe(true);
    expect(h.backend.requests.slice(before).filter((r) => r.method === 'DELETE')).toEqual([]);
    expect((await release(held.json.generation)).status).toBe(200);
    delete h.backend.hooks.beforeList;
    await h.clock(TERMINAL + STORAGE_REOPEN_GRACE_MS);
    await h.tick(collector);
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query('SELECT deleted FROM storage.orphan_gc WHERE s3_key=$1', [
          key,
        ])
      ).rows
    ).toEqual([{ deleted: true }]);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
  }, 30000);

  it('cannot allocate after held when its actual blocked seal backend was terminated', async () => {
    const writer = h.child();
    const holder = await h.start();
    const admin = await h.stores.postgres.connect();
    const launch = 'lost-seal-backend';
    try {
      const adminPid = (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await admin.query('SELECT pg_advisory_lock(hashtextextended($1, 1))', [launch]);
      const before = await catalogSnapshot(allocationTables);
      const allocating = h.call(
        'control',
        'POST',
        '/allocate',
        {
          taskId: launch,
          launchId: launch,
          effectKey: 'lost-allocate',
          retentionRevision: 'retention-1',
        },
        'core',
        {},
        writer
      );
      let backend = 0;
      await expect
        .poll(async () => {
          const blocked = await h.stores.postgres.query(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='lifemodel-storage-seal' AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))",
            [adminPid]
          );
          backend = blocked.rows[0]?.pid ?? 0;
          return blocked.rowCount;
        })
        .toBe(1);
      expect(
        (await h.stores.postgres.query('SELECT pg_terminate_backend($1) AS terminated', [backend]))
          .rows[0].terminated
      ).toBe(true);
      const held = await h.call(
        'control',
        'POST',
        '/maintenance/begin',
        { effectKey: 'lost-backend-cut' },
        'core',
        {},
        holder
      );
      expect(held.status).toBe(200);
      expect(held.json.state).toBe('held');
      expect(await catalogSnapshot(allocationTables)).toEqual(before);
      await admin.query('SELECT pg_advisory_unlock(hashtextextended($1, 1))', [launch]);
      expect((await allocating).status).toBe(503);
      expect(await catalogSnapshot(allocationTables)).toEqual(before);
      expect(
        (await h.call('control', 'GET', '/maintenance/status', undefined, 'core', {}, writer)).json
          .state
      ).toBe('held');
      expect((await release(held.json.generation)).status).toBe(200);
      expect(
        (
          await h.call(
            'control',
            'POST',
            '/allocate',
            {
              taskId: launch,
              launchId: launch,
              effectKey: 'lost-allocate',
              retentionRevision: 'retention-1',
            },
            'core',
            {},
            writer
          )
        ).status
      ).toBe(200);
    } finally {
      await admin.query('SELECT pg_advisory_unlock_all()');
      admin.release();
    }
  }, 30000);

  it('drains a real live allocate transaction before held, then refuses any late catalog work', async () => {
    const writer = h.child();
    const holder = await h.start();
    const admin = await h.stores.postgres.connect();
    const launch = 'live-seal-backend';
    try {
      const adminPid = (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await admin.query('SELECT pg_advisory_lock(hashtextextended($1, 1))', [launch]);
      const input = {
        taskId: launch,
        launchId: launch,
        effectKey: 'live-allocate',
        retentionRevision: 'retention-1',
      };
      const allocating = h.call('control', 'POST', '/allocate', input, 'core', {}, writer);
      let backend = 0;
      await expect
        .poll(async () => {
          const blocked = await h.stores.postgres.query(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='lifemodel-storage-seal' AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))",
            [adminPid]
          );
          backend = blocked.rows[0]?.pid ?? 0;
          return blocked.rowCount;
        })
        .toBe(1);
      const holding = h.call(
        'control',
        'POST',
        '/maintenance/begin',
        { effectKey: 'live-backend-cut' },
        'core',
        {},
        holder
      );
      await expect
        .poll(
          async () =>
            (await h.stores.postgres.query('SELECT state FROM storage.maintenance WHERE id=true'))
              .rows[0].state
        )
        .toBe('draining');
      // This is the actual begin transaction waiting for the writer's shared
      // transaction lock, not a synthetic maintenance-side session.
      await expect
        .poll(
          async () =>
            (
              await h.stores.postgres.query(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='lifemodel-storage-maintenance' AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))",
                [backend]
              )
            ).rowCount
        )
        .toBe(1);
      expect(
        (
          await h.stores.postgres.query('SELECT * FROM storage.allocations WHERE launch_id=$1', [
            launch,
          ])
        ).rows
      ).toEqual([]);
      await admin.query('SELECT pg_advisory_unlock(hashtextextended($1, 1))', [launch]);
      expect((await allocating).status).toBe(200);
      const held = await holding;
      expect(held.status).toBe(200);
      expect(held.json.state).toBe('held');
      const cut = await catalogSnapshot(allocationTables);
      expect(
        (await h.stores.postgres.query('SELECT launch_id FROM storage.allocations')).rows
      ).toEqual([{ launch_id: launch }]);
      expect(
        (
          await h.call(
            'control',
            'POST',
            '/allocate',
            { ...input, launchId: 'late-allocation', effectKey: 'late-allocate' },
            'core',
            {},
            writer
          )
        ).status
      ).toBe(503);
      expect(await catalogSnapshot(allocationTables)).toEqual(cut);
      expect((await release(held.json.generation)).status).toBe(200);
    } finally {
      await admin.query('SELECT pg_advisory_unlock_all()');
      admin.release();
    }
  }, 30000);
});
