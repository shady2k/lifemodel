/** Real-listener regressions for downstream SQL control capacity (ADR-015 S10). */
import { expect, it } from 'vitest';
import { createPressureHarness } from '../helpers/storage-pressure-harness.js';

it('ACKs an unrelated allocate within two seconds with every core-read SQL client blocked', async () => {
  const h = await createPressureHarness();
  const blocker = await h.stores.postgres.connect();
  const requests: ReturnType<typeof h.begin>[] = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM storage.spaces WHERE id IN ('a','b') FOR UPDATE");
    for (const space of ['a', 'a', 'b', 'b']) {
      const read = h.begin('read', 'GET', `/spaces/${space}/objects`);
      read.request.setTimeout(12_000);
      requests.push(read);
    }
    // Observe the actual four backend row-lock waiters, not a request/tick count.
    // The original shared-pool name remains included so this test proves the fix red.
    await expect
      .poll(
        async () =>
          Number(
            (
              await h.stores.postgres.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('lifemodel-storage-seal','lifemodel-storage-seal-read') AND wait_event_type='Lock'"
              )
            ).rows[0].count
          ),
        { timeout: 4000 }
      )
      .toBe(4);
    const allocate = h.begin('control', 'POST', '/allocate', {
      taskId: 'unrelated',
      launchId: 'unrelated',
      effectKey: 'unrelated',
      retentionRevision: 'one',
    });
    allocate.request.setTimeout(12_000);
    requests.push(allocate);
    const reply = await allocate.settled;
    expect(reply?.status).toBe(200);
    expect(reply!.elapsed).toBeLessThan(2000);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    requests.forEach((request) => request.abort());
    await Promise.allSettled(requests.map((request) => request.settled));
    await h.close();
  }
}, 30_000);

it('ACKs an unrelated revoke within two seconds with every task-guard SQL client blocked', async () => {
  // A small explicit task pool makes saturation reachable through the real task
  // listener without changing HTTP admission or invoking an internal SQL callback.
  const h = await createPressureHarness({}, { spaces: ['c'], accessPoolMax: 2 });
  const blocker = await h.stores.postgres.connect();
  const requests: ReturnType<typeof h.begin>[] = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM storage.spaces WHERE id IN ('a','b') FOR UPDATE");
    for (const space of ['a', 'b']) {
      const task = h.begin('task', 'GET', `/spaces/${space}/objects`, undefined, space);
      task.request.setTimeout(12_000);
      requests.push(task);
    }
    await expect
      .poll(
        async () =>
          Number(
            (
              await h.stores.postgres.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='lifemodel-storage-access' AND wait_event_type='Lock'"
              )
            ).rows[0].count
          ),
        { timeout: 4000 }
      )
      .toBe(2);
    const revoke = h.begin('control', 'POST', '/revoke', {
      space: 'c',
      expectedRevision: '0',
      effectKey: 'unrelated-revoke',
    });
    revoke.request.setTimeout(12_000);
    requests.push(revoke);
    const reply = await revoke.settled;
    expect(reply?.status).toBe(200);
    expect(reply!.elapsed).toBeLessThan(2000);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    requests.forEach((request) => request.abort());
    await Promise.allSettled(requests.map((request) => request.settled));
    await h.close();
  }
}, 30_000);
