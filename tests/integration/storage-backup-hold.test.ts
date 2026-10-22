import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRetentionHarness,
  DAY,
  TERMINAL,
  sha256,
  gate,
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
