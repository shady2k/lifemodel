/** Background/read SQL pressure cannot borrow the retention control capacity. */
import { expect, it } from 'vitest';
import { createRetentionHarness } from '../helpers/storage-retention-harness.js';

it('ACKs retention control within two seconds with every background SQL client blocked', async () => {
  const h = await createRetentionHarness();
  let blocker: Awaited<ReturnType<typeof h.stores.postgres.connect>> | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    await h.reset();
    blocker = await h.stores.postgres.connect();
    await blocker.query('BEGIN');
    // The tick begins at upload_intents; read-side readiness touches orphan_gc.
    // Neither table is needed by the independent pending-notice control request.
    await blocker.query(
      'LOCK TABLE storage.upload_intents,storage.orphan_gc IN ACCESS EXCLUSIVE MODE'
    );
    pending.push(h.tick());
    pending.push(...Array.from({ length: 3 }, () => h.ipc('retentionCheck')));
    for (const operation of pending) void operation.catch(() => undefined);
    await expect
      .poll(
        async () =>
          Number(
            (
              await h.stores.postgres.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='lifemodel-storage-retention' AND wait_event_type='Lock'"
              )
            ).rows[0].count
          ),
        { timeout: 4000 }
      )
      .toBe(4);
    const started = performance.now();
    const reply = await h.call('control', 'GET', '/retention/plans');
    const elapsed = performance.now() - started;
    expect(reply.status).toBe(200);
    expect(reply.json.plans).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
  } finally {
    if (blocker) {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await Promise.allSettled(pending);
    await h.close();
  }
}, 30_000);
