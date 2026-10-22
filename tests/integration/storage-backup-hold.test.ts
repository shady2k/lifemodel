import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStorageMaintenance } from '../../loader/src/storage-maintenance.js';
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
const begin = () => h.call('control', 'POST', '/maintenance/begin', { effectKey: 'backup-one' });
const release = (generation: string) =>
  h.call('control', 'POST', '/maintenance/release', { generation });
describe('durable storage backup hold', () => {
  it('refuses mutations while authenticated task/core reads and revoke still work; restarts and releases a crash-left hold', async () => {
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
    ).toBe(200);
    expect((await h.call('task', 'GET', `/spaces/${space}/objects/${obj.id}`)).status).toBe(403);
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
    await h.tick();
    expect(h.backend.objects.has(obj.key)).toBe(false);
  }, 30000);
  it('holds a writer admitted before the cut until its transport and publication settle', async () => {
    const space = await h.prepare();
    const arrived = gate();
    const proceed = gate();
    h.releases.push(proceed.resolve);
    h.backend.hooks.beforeCommit = async () => {
      arrived.resolve();
      await proceed.promise;
    };
    const bytes = Buffer.from('cut member');
    const writing = h.call('task', 'PUT', `/spaces/${space}/objects/cut-member`, bytes, 'a', {
      'x-storage-name': Buffer.from('cut.txt').toString('base64url'),
      'x-storage-length': String(bytes.length),
      'x-storage-sha256': sha256(bytes),
    });
    await arrived.promise;
    const holding = begin();
    // Wait for durable admission fence, not elapsed wall time.
    await expect
      .poll(
        async () =>
          (await h.stores.postgres.query('SELECT state FROM storage.maintenance WHERE id')).rows[0]
            .state
      )
      .toBe('draining');
    expect(
      (
        await h.call(
          'task',
          'POST',
          `/spaces/${space}/objects/00000000-0000-4000-8000-000000000000/mark`,
          { role: 'result' }
        )
      ).status
    ).toBe(503);
    proceed.resolve();
    expect((await writing).status).toBe(200);
    expect((await holding).json.state).toBe('held');
    expect(
      (
        await h.stores.postgres.query(
          'SELECT count(*)::int AS count FROM storage.objects WHERE space_id=$1',
          [space]
        )
      ).rows[0].count
    ).toBe(1);
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

describe('restore hold release and maintenance session safety', () => {
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
  }, 30000);

  it('drains a candidate DELETE already in flight before it declares a consistent cut', async () => {
    const object = await h.artifact();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    await h.warn((await h.pending()).plans[0].id);
    await h.clock(TERMINAL + 98 * DAY);
    const arrived = gate(),
      proceed = gate();
    h.releases.push(proceed.resolve);
    h.backend.hooks.beforeDelete = async () => {
      arrived.resolve();
      await proceed.promise;
    };
    const collecting = h.tick();
    await arrived.promise;
    const holding = begin();
    await expect
      .poll(
        async () =>
          (await h.stores.postgres.query('SELECT state FROM storage.maintenance WHERE id')).rows[0]
            .state
      )
      .toBe('draining');
    expect(h.backend.objects.has(object.key)).toBe(true);
    proceed.resolve();
    await collecting;
    expect((await holding).json.state).toBe('held');
    expect(h.backend.objects.has(object.key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
          [object.id]
        )
      ).rows[0].state
    ).toBe('deleted');
  }, 30000);

  it('aborts at its drain bound but retains admission until the cancelled effect has settled', async () => {
    const api = maintenance({ drainMs: 50, settleMs: 1000 });
    const arrived = gate(),
      cancelled = gate(),
      settled = gate();
    h.releases.push(settled.resolve);
    const operation = api.run(async (signal) => {
      signal.addEventListener('abort', cancelled.resolve, { once: true });
      arrived.resolve();
      await settled.promise;
    });
    await arrived.promise;
    const holding = api.begin({ effectKey: 'deadline-drain' });
    await cancelled.promise;
    expect((await api.status()).state).toBe('draining');
    await expect(api.enter()).rejects.toMatchObject({ code: 'storage_held' });
    settled.resolve();
    await operation;
    expect((await holding).state).toBe('held');
  }, 30000);

  it('keeps a timed-out hold fenced and lets a later begin finish after the owner settles', async () => {
    const api = maintenance({ drainMs: 20, settleMs: 30 });
    const operation = await api.enter();
    try {
      await expect(api.begin({ effectKey: 'retry-drain' })).rejects.toMatchObject({
        code: 'maintenance_unavailable',
      });
      expect(operation.signal.aborted).toBe(true);
      expect((await api.status()).state).toBe('draining');
      await expect(
        api.release({ generation: (await api.status()).generation })
      ).rejects.toMatchObject({ code: 'hold_pending' });
    } finally {
      await operation.close();
    }
    expect((await api.begin({ effectKey: 'retry-drain' })).state).toBe('held');
  }, 30000);

  it('propagates parent cancellation and session lock loss to the operation signal', async () => {
    const api = maintenance({ connectionString: h.sqlProxy.connectionString });
    const parent = new AbortController();
    const cancelled = await api.enter(parent.signal);
    parent.abort();
    expect(cancelled.signal.aborted).toBe(true);
    await cancelled.close();
    const lost = await api.enter();
    try {
      h.sqlProxy.drop();
      await expect.poll(() => lost.signal.aborted).toBe(true);
    } finally {
      await lost.close();
      h.sqlProxy.restore();
    }
    await api.close();
    await expect(api.enter()).rejects.toMatchObject({ code: 'maintenance_unavailable' });
  }, 30000);
});
