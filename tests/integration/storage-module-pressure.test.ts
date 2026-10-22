import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK, digest, createPressureHarness } from '../helpers/storage-pressure-harness.js';

let fixture: Awaited<ReturnType<typeof createPressureHarness>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe('storage module under transfer pressure (ADR-015 S10)', () => {
  it('bounds 20 attempted 4 MiB streams across two spaces and rejects excess within one second', async () => {
    const h = (fixture = await createPressureHarness({ queueRequests: 8 }));
    const streams = Array.from({ length: 20 }, (_, n) =>
      h.stall(n % 2 ? 'b' : 'a', `pressure-${n}`)
    );
    await expect.poll(() => h.admission.snapshot().observed.queued).toBe(8);
    await expect.poll(() => h.admission.snapshot().bufferedBytes).toBe(4 * CHUNK);
    const overload = await Promise.any(
      streams.map(async (stream) => {
        const reply = await stream.settled;
        if (!reply || reply.status !== 429) throw Error('not overload');
        return { reply, stream };
      })
    );
    expect(overload.reply.elapsed).toBeLessThan(1000);
    expect(Number(overload.reply.retryAfter)).toBeGreaterThan(0);
    // A rejected partial body cannot retain a persistent socket.
    await overload.stream.closed;
    const observed = h.admission.snapshot().observed;
    expect(observed.active).toBeLessThanOrEqual(8);
    expect(observed.task).toBeLessThanOrEqual(6);
    expect(observed.maxPerSpace).toBe(2);
    expect(observed.bufferedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(observed.queued).toBe(8);
    expect(observed.queueBytes).toBeLessThanOrEqual(64 * 1024);
    // The independent read listener still returns a full authenticated chunk.
    const read = await h.call('read', 'GET', `/spaces/reader/objects/${h.readId}`);
    expect(read.status).toBe(200);
    expect(read.body.equals(h.readBytes)).toBe(true);
    expect(read.elapsed).toBeLessThan(2000);
    streams.forEach((stream) => stream.abort());
    await expect.poll(() => h.admission.snapshot().active).toBe(0);
    await expect.poll(() => h.admission.snapshot().queued).toBe(0);
  });

  it('reserves owner/core read workers when both task spaces compete for every non-reserved slot', async () => {
    const h = (fixture = await createPressureHarness({
      transferWorkers: 4,
      reservedReadWorkers: 2,
      queueRequests: 8,
    }));
    const streams = Array.from({ length: 4 }, (_, n) => h.stall(n % 2 ? 'b' : 'a', `reserve-${n}`));
    await expect.poll(() => h.admission.snapshot().bufferedBytes).toBe(2 * CHUNK);
    expect(h.admission.snapshot().task).toBe(2);
    const read = await h.call('read', 'GET', `/spaces/reader/objects/${h.readId}`);
    expect(read.status).toBe(200);
    expect(read.body.equals(h.readBytes)).toBe(true);
    expect(read.elapsed).toBeLessThan(1000);
    expect(h.admission.snapshot().observed.read).toBeGreaterThan(0);
    expect(h.admission.snapshot().observed.task).toBeLessThanOrEqual(2);
    streams.forEach((stream) => stream.abort());
  });

  it('ACKs 20 real control writes and 20 second-task operations within two seconds each while an upload stalls', async () => {
    // Only one task slot is available: a control route accidentally using it
    // cannot hide behind unused default transfer capacity.
    const h = (fixture = await createPressureHarness({
      transferWorkers: 3,
      reservedReadWorkers: 2,
      perSpaceWorkers: 1,
    }));
    const stalled = h.stall('a', 'control-stall');
    await expect.poll(() => h.admission.snapshot().bufferedBytes).toBe(CHUNK);
    for (let n = 0; n < 20; n++) {
      const control = await h.call('control', 'POST', '/allocate', {
        taskId: `control-${n}`,
        launchId: `control-${n}`,
        effectKey: `control-${n}`,
        retentionRevision: 'retention-1',
      });
      expect(control.status).toBe(200);
      expect(control.elapsed).toBeLessThan(2000);
      // Task metadata is still transfer admission; use a separate read-reserved
      // configuration for the second task throughput below.
    }
    expect(h.admission.snapshot().observed.control).toBeGreaterThan(0);
    expect(h.admission.snapshot().observed.control).toBeLessThanOrEqual(2);
    stalled.abort();
    await expect.poll(() => h.admission.snapshot().active).toBe(0);
    await h.close();
    fixture = undefined;
    const other = (fixture = await createPressureHarness());
    const upload = other.stall('a', 'other-space-stall');
    await expect.poll(() => other.admission.snapshot().bufferedBytes).toBe(CHUNK);
    const bytes = Buffer.alloc(CHUNK, 98);
    for (let n = 0; n < 20; n++) {
      const reply = await other.call('task', 'PUT', `/spaces/b/objects/healthy-${n}`, bytes, 'b', {
        'x-storage-name': Buffer.from(`healthy-${n}.txt`).toString('base64url'),
        'x-storage-length': String(bytes.length),
        'x-storage-sha256': digest(bytes),
      });
      expect(reply.status).toBe(200);
      expect(reply.elapsed).toBeLessThan(2000);
    }
    expect(other.admission.snapshot().bySpace.a).toBe(1);
    upload.abort();
  }, 30_000);

  it('releases aborted workers and queued metadata before admitting a later valid request', async () => {
    const h = (fixture = await createPressureHarness());
    const first = h.stall('a', 'abort-one'),
      second = h.stall('a', 'abort-two');
    await expect.poll(() => h.admission.snapshot().bufferedBytes).toBe(2 * CHUNK);
    first.abort();
    second.abort();
    await expect.poll(() => h.admission.snapshot().active).toBe(0);
    expect(h.admission.snapshot().bufferedBytes).toBe(0);
    const reply = await h.call('task', 'GET', '/spaces/a/objects?limit=1');
    expect(reply.status).toBe(200);
    expect(reply.elapsed).toBeLessThan(1000);
    expect(h.admission.snapshot().queued).toBe(0);
  });

  it('hands the next chunk to a waiting second space before reading the first task again', async () => {
    const h = (fixture = await createPressureHarness({
      transferWorkers: 3,
      reservedReadWorkers: 2,
      perSpaceWorkers: 1,
    }));
    const first = h.stall('a', 'fairness-large', 2 * CHUNK);
    await expect.poll(() => h.admission.snapshot().bufferedBytes).toBe(CHUNK);
    const bytes = Buffer.alloc(CHUNK, 98);
    const second = h.begin('task', 'PUT', '/spaces/b/objects/fairness-small', bytes, 'b', {
      'x-storage-name': Buffer.from('fairness-small.txt').toString('base64url'),
      'x-storage-length': String(bytes.length),
      'x-storage-sha256': digest(bytes),
    });
    await expect.poll(() => h.admission.snapshot().queued).toBe(1);
    // Complete only A's first chunk. B must ACK while A's second chunk has
    // not been supplied: reacquiring A before a queued B would deadlock here.
    first.request.write(Buffer.alloc(CHUNK - 1, 120));
    const completed = await second.settled;
    expect(completed?.status).toBe(200);
    expect(completed!.elapsed).toBeLessThan(2000);
    await expect.poll(() => h.admission.snapshot().bySpace.a).toBe(1);
    first.abort();
  });

  it('ends a no-progress chunk at its own configured deadline and frees the next worker', async () => {
    const h = (fixture = await createPressureHarness({ chunkDeadlineMs: 250 }));
    const started = performance.now();
    const stalled = h.stall('a', 'deadline');
    await expect.poll(() => h.admission.snapshot().bufferedBytes).toBe(CHUNK);
    await stalled.settled;
    expect(performance.now() - started).toBeLessThan(1500);
    await expect.poll(() => h.admission.snapshot().active).toBe(0);
    expect(h.admission.snapshot().bufferedBytes).toBe(0);
    expect((await h.call('task', 'GET', '/spaces/b/objects?limit=1', undefined, 'b')).status).toBe(
      200
    );
  });

  it('revoke ACK cancels every active and queued worker in that space without blocking the other task', async () => {
    const h = (fixture = await createPressureHarness());
    const streams = Array.from({ length: 3 }, (_, n) => h.stall('a', `revoke-${n}`));
    await expect.poll(() => h.admission.snapshot().bufferedBytes).toBe(2 * CHUNK);
    await expect.poll(() => h.admission.snapshot().queued).toBe(1);
    const revoked = await h.call('control', 'POST', '/revoke', {
      space: 'a',
      expectedRevision: '0',
      effectKey: 'pressure-revoke',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.elapsed).toBeLessThan(2000);
    await Promise.all(streams.map((stream) => stream.settled));
    await expect.poll(() => h.admission.snapshot().active).toBe(0);
    expect(h.admission.snapshot().queued).toBe(0);
    expect(h.admission.snapshot().bufferedBytes).toBe(0);
    expect((await h.call('task', 'GET', '/spaces/b/objects?limit=1', undefined, 'b')).status).toBe(
      200
    );
  });

  it('reports failed backend and catalog as unavailable, then recovers without calling either empty', async () => {
    const h = (fixture = await createPressureHarness());
    expect((await h.app.health.evaluate()).status).toBe(200);
    h.backend.hooks.beforeBucketCheck = () => 'lose-response';
    const down = await h.app.health.evaluate();
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ state: 'down', lastErrorCode: 'unreachable' });
    h.backend.hooks.beforeBucketCheck = () => ({ status: 200 });
    expect((await h.app.health.evaluate()).body).toMatchObject({
      state: 'ok',
      lastErrorCode: null,
    });
    h.sqlProxy.drop();
    const catalog = await h.app.health.evaluate();
    expect(catalog.status).toBe(503);
    expect(catalog.body).toMatchObject({ state: 'down', lastErrorCode: 'catalog_unavailable' });
    h.sqlProxy.restore();
    expect((await h.app.health.evaluate()).status).toBe(200);
  });

  it('reuses bounded TLS and PostgreSQL connections without caching TokenReview or Pod/Job authority', async () => {
    const h = (fixture = await createPressureHarness());
    const tlsBefore = h.tlsProxy.connections,
      sqlBefore = h.sqlProxy.connections;
    const reviews = h.api.reviews.length,
      calls = h.api.calls.length;
    for (let n = 0; n < 20; n++) {
      expect(
        (await h.call('task', 'GET', '/spaces/b/objects?limit=1', undefined, 'b')).status
      ).toBe(200);
      const activity = await h.stores.postgres.query(
        "SELECT application_name,count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'lifemodel-storage-%' GROUP BY application_name"
      );
      for (const row of activity.rows) expect(row.count).toBeLessThanOrEqual(10);
    }
    expect(h.api.reviews.length - reviews).toBeGreaterThanOrEqual(20);
    expect(h.api.calls.slice(calls).filter((path) => path.includes('/pods/'))).toHaveLength(
      h.api.reviews.length - reviews
    );
    expect(h.api.calls.slice(calls).filter((path) => path.includes('/jobs/'))).toHaveLength(
      h.api.reviews.length - reviews
    );
    expect(h.tlsProxy.connections - tlsBefore).toBeLessThanOrEqual(10);
    expect(h.sqlProxy.connections - sqlBefore).toBeLessThanOrEqual(16);
    // Freshness is still checked after all those successful reused connections.
    h.api.deadPods.add('b');
    expect((await h.call('task', 'GET', '/spaces/b/objects?limit=1', undefined, 'b')).status).toBe(
      403
    );
    h.api.deadPods.delete('b');
    expect((await h.call('task', 'GET', '/spaces/b/objects?limit=1', undefined, 'b')).status).toBe(
      200
    );
  }, 30_000);
});
