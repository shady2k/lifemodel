import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRetentionHarness, DAY, TERMINAL } from '../helpers/storage-retention-harness.js';

let h: Awaited<ReturnType<typeof createRetentionHarness>>;
beforeAll(async () => {
  h = await createRetentionHarness();
}, 30_000);
beforeEach(async () => {
  await h.reset();
}, 20_000);
afterEach(async () => {
  await h.cleanup();
}, 20_000);
afterAll(async () => {
  await h?.close();
}, 20_000);

describe('sealed retention snapshots and durable warning plans', () => {
  it('defers missing settings and backfills the first valid policy at the original terminal time', async () => {
    await h.projection(null);
    const artifact = await h.artifact();
    expect(
      (
        await h.stores.postgres.query(
          'SELECT * FROM storage.retention_policies WHERE space_id=$1',
          [artifact.space]
        )
      ).rows
    ).toEqual([]);
    await h.clock(TERMINAL + 90 * DAY);
    await h.projection(null);
    await h.tick();
    expect((await h.pending()).plans).toEqual([]);
    await h.projection({ retention: 'forever', warningLeadDays: 7, revision: 2 });
    await h.tick();
    const policy = (
      await h.stores.postgres.query(
        'SELECT retention,terminal_at,expires_at,settings_revision::text FROM storage.retention_policies WHERE space_id=$1',
        [artifact.space]
      )
    ).rows[0];
    expect(policy).toMatchObject({
      retention: 'forever',
      expires_at: null,
      settings_revision: '2',
    });
    expect(policy.terminal_at.getTime()).toBe(TERMINAL);
    await h.clock(TERMINAL + 100 * DAY, { retention: '90d', revision: 3 });
    await h.tick();
    expect((await h.pending()).plans).toEqual([]);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT retention FROM storage.retention_policies WHERE space_id=$1',
          [artifact.space]
        )
      ).rows[0].retention
    ).toBe('forever');
  }, 30000);

  it('uses the last valid forever projection when a later read fails at freeze', async () => {
    await h.projection({ retention: 'forever', warningLeadDays: 7, revision: 2 });
    await h.tick();
    await h.projection('invalid');
    const artifact = await h.artifact();
    expect(
      (
        await h.stores.postgres.query(
          'SELECT retention,settings_revision::text FROM storage.retention_policies WHERE space_id=$1',
          [artifact.space]
        )
      ).rows[0]
    ).toEqual({ retention: 'forever', settings_revision: '2' });
    await h.clock(TERMINAL + 100 * DAY);
    await h.projection(null);
    await h.tick();
    expect((await h.pending()).plans).toEqual([]);
  }, 30000);

  it('selects at 90 days, never deletes without the notice, then waits seven full days from its commit', async () => {
    const artifact = await h.artifact();
    const policy = (
      await h.stores.postgres.query(
        `SELECT retention,pinned,revision::text,settings_revision::text,
      terminal_at,expires_at,state FROM storage.retention_policies WHERE space_id=$1`,
        [artifact.space]
      )
    ).rows[0];
    expect(policy).toMatchObject({
      retention: '90d',
      pinned: false,
      revision: '0',
      settings_revision: '1',
      state: 'retained',
    });
    expect(new Date(policy.terminal_at).getTime()).toBe(TERMINAL);
    expect(new Date(policy.expires_at).getTime()).toBe(TERMINAL + 90 * DAY);
    await h.clock(TERMINAL + 89 * DAY);
    await h.tick();
    expect((await h.pending()).plans).toEqual([]);
    await h.clock(TERMINAL + 90 * DAY - 1000);
    await h.tick();
    expect((await h.pending()).plans).toEqual([]);
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const { plans } = await h.pending();
    expect(plans).toHaveLength(1);
    const planId = plans[0].id as string;
    expect(planId).toEqual(expect.any(String));
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    // An unannounced plan is never authority to delete, however old it becomes.
    await h.clock(TERMINAL + 150 * DAY);
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    expect(
      h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === artifact.key)
    ).toHaveLength(0);
    const first = await h.warn(planId);
    expect(first.status).toBe(200);
    expect((await h.warn(planId)).json).toEqual(first.json);
    expect((await h.warn(planId, 'different-owner-message')).status).toBe(409);
    expect((await h.pending()).plans).toEqual([]);
    const stored = (
      await h.stores.postgres.query(
        'SELECT state,message_id,warned_at,earliest_delete_at FROM storage.deletion_plans WHERE id=$1',
        [planId]
      )
    ).rows[0];
    expect(stored).toMatchObject({ state: 'warned', message_id: 'owner-message' });
    expect(new Date(stored.warned_at).getTime()).toBe(TERMINAL + 150 * DAY);
    expect(new Date(stored.earliest_delete_at).getTime()).toBe(TERMINAL + 157 * DAY);
    await h.clock(TERMINAL + 157 * DAY - 1000);
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    expect(
      (await h.call('read', 'GET', `/spaces/${artifact.space}/objects/${artifact.id}`)).body
    ).toEqual(artifact.bytes);
    await h.clock(TERMINAL + 157 * DAY);
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(false);
    expect(
      (await h.call('read', 'GET', `/spaces/${artifact.space}/objects/${artifact.id}`)).status
    ).toBe(404);
    expect(
      (
        await h.stores.postgres.query('SELECT state FROM storage.deletion_plans WHERE id=$1', [
          planId,
        ])
      ).rows[0].state
    ).toBe('complete');
    expect((await h.warn(planId)).json).toEqual(first.json);
    expect((await h.warn(planId, 'another-message')).status).toBe(409);
  }, 30_000);

  it('uses a configured three-day lead and does not shorten an announced seven-day window', async () => {
    const old = await h.artifact('a');
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const oldPlan = (await h.pending()).plans[0];
    expect((await h.warn(oldPlan.id)).status).toBe(200);
    // A later shorter setting applies to a later batch, never the already sent notice.
    await h.clock(TERMINAL + 90 * DAY, { warningLeadDays: 3, revision: 2 });
    const fresh = await h.artifact('b');
    await h.clock(TERMINAL + 94 * DAY);
    await h.tick();
    expect(h.backend.objects.has(old.key)).toBe(true);
    await h.clock(TERMINAL + 97 * DAY - 1000);
    await h.tick();
    expect(h.backend.objects.has(old.key)).toBe(true);
    await h.clock(TERMINAL + 97 * DAY + 1000);
    await h.tick();
    expect(h.backend.objects.has(old.key)).toBe(false);
    expect(h.backend.objects.has(fresh.key)).toBe(true);
    await h.clock(TERMINAL + 180 * DAY);
    await h.tick();
    const freshPlans = (await h.pending()).plans;
    expect(freshPlans).toHaveLength(1);
    const freshPlan = freshPlans[0];
    const stored = (
      await h.stores.postgres.query(
        'SELECT lead_days,settings_revision::text FROM storage.deletion_plans WHERE id=$1',
        [freshPlan.id]
      )
    ).rows[0];
    expect(stored).toMatchObject({ lead_days: 3, settings_revision: '2' });
    expect((await h.warn(freshPlan.id, 'configured-lead-message')).status).toBe(200);
    await h.clock(TERMINAL + 183 * DAY - 1000);
    await h.tick();
    expect(h.backend.objects.has(fresh.key)).toBe(true);
    await h.clock(TERMINAL + 183 * DAY + 1000);
    await h.tick();
    expect(h.backend.objects.has(fresh.key)).toBe(false);
  }, 30_000);

  it('snapshots forever, excludes active and pinned spaces, and replays keyed policy receipts', async () => {
    await h.clock(TERMINAL, { retention: 'forever', revision: 2 });
    const forever = await h.artifact('a');
    await h.clock(TERMINAL, { retention: '90d', revision: 3 });
    const activeSpace = await h.prepare('b');
    const active = await h.upload(activeSpace, 'b');
    const pin = await h.policy(forever.space, 'pin');
    expect(pin.status).toBe(200);
    expect((await h.policy(forever.space, 'pin')).json).toEqual(pin.json);
    expect((await h.policy(forever.space, 'unpin', '0', `pin-${forever.space}`)).status).toBe(409);
    expect((await h.policy(forever.space, 'unpin', '0', 'stale-policy')).status).toBe(409);
    expect((await h.policy(forever.space, 'unpin', '1')).status).toBe(200);
    await h.clock(TERMINAL + 365 * DAY);
    await h.tick();
    expect((await h.pending()).plans).toEqual([]);
    expect(h.backend.objects.has(forever.key)).toBe(true);
    expect(h.backend.objects.has(active.key)).toBe(true);
    const snapshot = (
      await h.stores.postgres.query(
        'SELECT retention,pinned,settings_revision::text,expires_at FROM storage.retention_policies WHERE space_id=$1',
        [forever.space]
      )
    ).rows[0];
    expect(snapshot).toMatchObject({
      retention: 'forever',
      pinned: false,
      settings_revision: '2',
      expires_at: null,
    });
  }, 30_000);

  it('pins win after warning, and unpin creates a fresh warning instead of reviving the old notice', async () => {
    const artifact = await h.artifact();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const firstPlan = (await h.pending()).plans[0];
    expect((await h.warn(firstPlan.id)).status).toBe(200);
    expect((await h.policy(artifact.space, 'pin')).status).toBe(200);
    await h.clock(TERMINAL + 98 * DAY);
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    const candidates = (
      await h.stores.postgres.query(
        'SELECT state FROM storage.deletion_candidates WHERE plan_id=$1',
        [firstPlan.id]
      )
    ).rows;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].state).toBe('removed');
    expect((await h.pending()).plans).toEqual([]);
    expect((await h.policy(artifact.space, 'unpin', '1')).status).toBe(200);
    await h.tick();
    const next = (await h.pending()).plans;
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(firstPlan.id);
    expect(h.backend.objects.has(artifact.key)).toBe(true);
  }, 30_000);

  it('changing one warned space to forever removes it before deletion and is idempotent', async () => {
    const artifact = await h.artifact();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plan = (await h.pending()).plans[0];
    await h.warn(plan.id);
    const changed = await h.policy(artifact.space, 'retention', '0', 'keep-forever', 'forever');
    expect(changed.status).toBe(200);
    expect(
      (await h.policy(artifact.space, 'retention', '0', 'keep-forever', 'forever')).json
    ).toEqual(changed.json);
    expect((await h.policy(artifact.space, 'retention', '0', 'keep-forever', '90d')).status).toBe(
      409
    );
    await h.clock(TERMINAL + 365 * DAY);
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    expect((await h.pending()).plans).toEqual([]);
  }, 30_000);

  it('one hundred artifacts coalesce into one plan and survive restart without a second warning', async () => {
    const artifacts = await h.batch(100);
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const page = await h.pending('?limit=1');
    expect(page.plans).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    const plan = page.plans[0];
    const rows = (
      await h.stores.postgres.query(
        'SELECT object_id::text,state FROM storage.deletion_candidates WHERE plan_id=$1',
        [plan.id]
      )
    ).rows;
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((row) => row.object_id))).toEqual(new Set(artifacts.map((a) => a.id)));
    const stored = (
      await h.stores.postgres.query(
        'SELECT total_bytes::text,reason FROM storage.deletion_plans WHERE id=$1',
        [plan.id]
      )
    ).rows[0];
    expect(stored).toEqual({
      total_bytes: String(artifacts.reduce((n, a) => n + a.bytes.length, 0)),
      reason: 'age',
    });
    await h.kill();
    await h.start();
    await h.tick();
    expect((await h.pending()).plans.map((p) => p.id)).toEqual([plan.id]);
    const receipt = await h.warn(plan.id);
    expect(receipt.status).toBe(200);
    await h.kill();
    await h.start();
    await h.tick();
    expect((await h.pending()).plans).toEqual([]);
    expect((await h.warn(plan.id)).json).toEqual(receipt.json);
    expect((await h.warn(plan.id, 'duplicate-notice')).status).toBe(409);
    expect(
      (await h.stores.postgres.query('SELECT count(*)::int AS n FROM storage.deletion_plans'))
        .rows[0].n
    ).toBe(1);
    await h.clock(TERMINAL + 97 * DAY);
    await h.tick();
    for (const artifact of artifacts) expect(h.backend.objects.has(artifact.key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query(
          "SELECT count(*)::int AS n FROM storage.deletion_candidates WHERE state='deleted'"
        )
      ).rows[0].n
    ).toBe(100);
  }, 45_000);

  it('coalesces only unannounced batches and paginates plans in stable order across restart', async () => {
    const oldest = await h.artifact('a');
    await h.clock(TERMINAL + DAY);
    await h.artifact('b');
    const quota = await h.call('control', 'POST', '/retention/reclaim', {
      effectKey: 'reclaim-oldest',
      bytes: 1,
    });
    expect(quota.status).toBe(200);
    const quotaPlan = (await h.pending()).plans;
    expect(quotaPlan).toHaveLength(1);
    const selected = (
      await h.stores.postgres.query(
        'SELECT space_id FROM storage.deletion_candidates WHERE plan_id=$1',
        [quotaPlan[0].id]
      )
    ).rows;
    expect(selected).toEqual([{ space_id: oldest.space }]);
    expect(h.backend.objects.has(oldest.key)).toBe(true);
    await h.clock(TERMINAL + 91 * DAY);
    await h.tick();
    const first = await h.pending('?limit=1');
    expect(first.plans).toHaveLength(1);
    expect(first.plans[0].id).toBe(quotaPlan[0].id);
    expect(first.nextCursor).toEqual(expect.any(String));
    await h.kill();
    await h.start();
    const second = await h.pending(`?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.plans).toHaveLength(1);
    expect(second.plans[0].reason).toBe('age');
    expect(second.plans[0].id).not.toBe(first.plans[0].id);
    expect(second.nextCursor).toBeNull();
    expect(
      (
        await h.call('control', 'POST', '/retention/reclaim', {
          effectKey: 'reclaim-oldest',
          bytes: 1,
        })
      ).json
    ).toEqual(quota.json);
    expect(
      (
        await h.call('control', 'POST', '/retention/reclaim', {
          effectKey: 'reclaim-oldest',
          bytes: 2,
        })
      ).status
    ).toBe(409);
    expect(h.backend.objects.has(oldest.key)).toBe(true);
  }, 30_000);

  it('adds newly due spaces to a pending notice but never to an already committed notice', async () => {
    const first = await h.artifact('a');
    await h.clock(TERMINAL + DAY);
    const second = await h.artifact('b');
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plan = (
      await h.stores.postgres.query("SELECT id FROM storage.deletion_plans WHERE state='pending'")
    ).rows[0];
    await h.clock(TERMINAL + 91 * DAY);
    await h.tick();
    expect((await h.pending()).plans.map((p) => p.id)).toEqual([plan.id]);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT space_id FROM storage.deletion_candidates WHERE plan_id=$1 ORDER BY space_id',
          [plan.id]
        )
      ).rows.map((r) => r.space_id)
    ).toEqual([first.space, second.space].sort());
    await h.warn(plan.id);
    const all = await h.stores.postgres.query(
      'SELECT count(*)::int AS n FROM storage.deletion_plans'
    );
    expect(all.rows[0].n).toBe(1);
  }, 30_000);

  it('freezes membership when core fetches a notice so later candidates cannot inherit an unseen warning', async () => {
    const first = await h.artifact('a');
    await h.clock(TERMINAL + DAY);
    const second = await h.artifact('b');
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plan = (await h.pending()).plans[0];
    await h.clock(TERMINAL + 91 * DAY);
    await h.tick();
    const pending = (await h.pending()).plans;
    expect(pending).toHaveLength(2);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT object_id::text FROM storage.deletion_candidates WHERE plan_id=$1',
          [plan.id]
        )
      ).rows
    ).toEqual([{ object_id: first.id }]);
    await h.warn(plan.id);
    await h.clock(TERMINAL + 98 * DAY);
    await h.tick();
    expect(h.backend.objects.has(first.key)).toBe(false);
    expect(h.backend.objects.has(second.key)).toBe(true);
  }, 30000);

  it('a longer setting delays an announced deadline and a later decrease cannot undo it', async () => {
    const artifact = await h.artifact();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plan = (await h.pending()).plans[0];
    await h.warn(plan.id);
    await h.clock(TERMINAL + 97 * DAY, { warningLeadDays: 10, revision: 2 });
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    expect(
      new Date(
        (
          await h.stores.postgres.query(
            'SELECT earliest_delete_at FROM storage.deletion_plans WHERE id=$1',
            [plan.id]
          )
        ).rows[0].earliest_delete_at
      ).getTime()
    ).toBe(TERMINAL + 100 * DAY);
    await h.clock(TERMINAL + 99 * DAY, { warningLeadDays: 1, revision: 3 });
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    await h.clock(TERMINAL + 100 * DAY);
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(false);
  }, 30_000);

  it('a candidate that becomes due after a warning receives a new notice, not the existing deadline', async () => {
    const first = await h.artifact('a');
    await h.clock(TERMINAL + DAY);
    const second = await h.artifact('b');
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const firstPlan = (await h.pending()).plans[0];
    await h.warn(firstPlan.id);
    await h.clock(TERMINAL + 91 * DAY);
    await h.tick();
    const fresh = (await h.pending()).plans;
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).not.toBe(firstPlan.id);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT object_id::text FROM storage.deletion_candidates WHERE plan_id=$1',
          [firstPlan.id]
        )
      ).rows
    ).toEqual([{ object_id: first.id }]);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT object_id::text FROM storage.deletion_candidates WHERE plan_id=$1',
          [fresh[0].id]
        )
      ).rows
    ).toEqual([{ object_id: second.id }]);
    await h.clock(TERMINAL + 97 * DAY);
    await h.tick();
    expect(h.backend.objects.has(first.key)).toBe(false);
    expect(h.backend.objects.has(second.key)).toBe(true);
    expect((await h.pending()).plans.map((plan) => plan.id)).toEqual([fresh[0].id]);
  }, 30_000);

  it.each(['pin', 'forever'] as const)(
    'quota reclamation skips an older %s space and warns for finite unpinned output',
    async (protection) => {
      const protectedArtifact = await h.artifact('a');
      expect(
        (
          await h.policy(
            protectedArtifact.space,
            protection === 'pin' ? 'pin' : 'retention',
            '0',
            'protect-oldest',
            protection === 'forever' ? 'forever' : undefined
          )
        ).status
      ).toBe(200);
      await h.clock(TERMINAL + DAY);
      const eligible = await h.artifact('b');
      const planned = await h.call('control', 'POST', '/retention/reclaim', {
        effectKey: 'reclaim-protected',
        bytes: 1,
      });
      expect(planned.status).toBe(200);
      const plans = (await h.pending()).plans;
      expect(plans).toHaveLength(1);
      expect(plans[0].reason).toBe('quota');
      expect(
        (
          await h.stores.postgres.query(
            'SELECT space_id FROM storage.deletion_candidates WHERE plan_id=$1',
            [plans[0].id]
          )
        ).rows
      ).toEqual([{ space_id: eligible.space }]);
      expect(h.backend.objects.has(protectedArtifact.key)).toBe(true);
      expect(h.backend.objects.has(eligible.key)).toBe(true);
      await h.tick();
      expect(h.backend.objects.has(eligible.key)).toBe(true);
      await h.warn(plans[0].id);
      await h.clock(TERMINAL + 8 * DAY);
      await h.tick();
      expect(h.backend.objects.has(protectedArtifact.key)).toBe(true);
      expect(h.backend.objects.has(eligible.key)).toBe(false);
    },
    30_000
  );

  it.each(['a', 'web'])(
    'refuses %s on every retention control route',
    async (token) => {
      const artifact = await h.artifact();
      for (const [method, path, body] of [
        ['GET', '/retention/plans?limit=1', undefined],
        ['POST', '/retention/warningCommitted', { planId: 'unknown', messageId: 'message' }],
        [
          'POST',
          '/retention/pin',
          { space: artifact.space, effectKey: 'deny-pin', expectedRevision: '0' },
        ],
        [
          'POST',
          '/retention/unpin',
          { space: artifact.space, effectKey: 'deny-unpin', expectedRevision: '0' },
        ],
        [
          'POST',
          '/retention/policy',
          {
            space: artifact.space,
            effectKey: 'deny-policy',
            expectedRevision: '0',
            retention: 'forever',
          },
        ],
        ['POST', '/retention/reclaim', { effectKey: 'deny-reclaim', bytes: 1 }],
      ] as const)
        expect((await h.call('control', method, path, body, token)).status).toBe(403);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT revision::text FROM storage.retention_policies WHERE space_id=$1',
            [artifact.space]
          )
        ).rows[0].revision
      ).toBe('0');
    },
    30_000
  );
});
