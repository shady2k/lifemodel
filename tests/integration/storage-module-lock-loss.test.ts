/** Lost SQL ownership cancels transport; retries remain idempotent, not S3-fenced. */
import { createServer, request } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRetentionHarness,
  DAY,
  TERMINAL,
  gate,
} from '../helpers/storage-retention-harness.js';

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

/** Observe cancellation at the HTTP socket, without replacing the S3 client.
 * Forward the signed Host unchanged so the independent backend still verifies it. */
async function observeDeletes(key: string) {
  const endpoint = h.backend.endpoint;
  const aborted = gate();
  let firstAborted = false;
  let deletes = 0;
  const order: string[] = [];
  const server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    const first = req.method === 'DELETE' && req.url?.endsWith(`/${key}`) && ++deletes === 1;
    const upstream = request(new URL(req.url ?? '/', endpoint), {
      method: req.method,
      headers: req.headers,
      agent: false,
    });
    upstream.on('error', () => res.destroy());
    upstream.on('response', (reply) => {
      reply.on('error', () => res.destroy());
      res.writeHead(reply.statusCode!, reply.headers);
      reply.pipe(res);
    });
    res.on('close', () => {
      if (first && !res.writableFinished) {
        firstAborted = true;
        order.push('first-aborted');
        aborted.resolve();
      }
      upstream.destroy();
    });
    req.pipe(upstream);
  });
  server.on('error', () => undefined);
  server.on('connection', (socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('observer listen failed');
  h.backend.endpoint = `http://127.0.0.1:${address.port}`;
  return {
    aborted,
    order,
    get firstAborted() {
      return firstAborted;
    },
    get deletes() {
      return deletes;
    },
    async close() {
      h.backend.endpoint = endpoint;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('storage deletion lock-session loss', () => {
  it('aborts the first child DELETE before the second confirms and releases bytes once', async () => {
    const artifact = await h.artifact();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plans = (await h.pending()).plans;
    expect(plans).toHaveLength(1);
    expect((await h.warn(plans[0].id)).status).toBe(200);
    await h.clock(TERMINAL + 97 * DAY);
    await h.kill();
    const observer = await observeDeletes(artifact.key);
    const reached = gate();
    const release = gate();
    h.releases.push(release.resolve);
    let backendDeletes = 0;
    h.backend.hooks.beforeDelete = async (record) => {
      if (record.key !== artifact.key) return;
      if (++backendDeletes === 1) {
        reached.resolve();
        await release.promise;
        return 'hang';
      }
      expect(observer.firstAborted).toBe(true);
    };
    h.backend.hooks.afterDelete = (record) => {
      if (record.key === artifact.key) observer.order.push('second-confirmed');
    };
    try {
      const first = await h.start();
      const second = await h.start();
      const deleting = h.tick(first);
      void deleting.catch(() => undefined);
      await reached.promise;
      expect(
        (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
          .rows[0].used_bytes
      ).toBe(String(artifact.bytes.length));
      const owners = await h.stores.postgres.query(
        `SELECT DISTINCT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
         WHERE a.application_name='lifemodel-storage-retention'
           AND l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
           AND l.classid=((hashtextextended($1,7)>>32)&4294967295)::oid
           AND l.objid=(hashtextextended($1,7)&4294967295)::oid`,
        [artifact.id]
      );
      expect(owners.rows).toHaveLength(1);
      await h.stores.postgres.query('SELECT pg_terminate_backend($1)', [owners.rows[0].pid]);
      // This bound is below the ten-second S3 deadline: only session-loss
      // cancellation can satisfy it. Wait for the socket event, not a tick count.
      await expect.poll(() => observer.firstAborted, { timeout: 2_000 }).toBe(true);
      await observer.aborted.promise;
      await deleting;
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
            [artifact.id]
          )
        ).rows
      ).toEqual([{ state: 'deleting' }]);
      await h.tick(second);
      release.resolve();
      expect(observer.order).toEqual(['first-aborted', 'second-confirmed']);
      expect(observer.deletes).toBe(2);
      expect(backendDeletes).toBe(2);
      expect(h.backend.objects.has(artifact.key)).toBe(false);
      await h.tick(first);
      await h.tick(second);
      expect(observer.deletes).toBe(2);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state,count(*)::int AS n FROM storage.deletion_candidates WHERE object_id=$1 GROUP BY state',
            [artifact.id]
          )
        ).rows
      ).toEqual([{ state: 'deleted', n: 1 }]);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state,total_bytes::text FROM storage.deletion_plans WHERE id=$1',
            [plans[0].id]
          )
        ).rows
      ).toEqual([{ state: 'complete', total_bytes: String(artifact.bytes.length) }]);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT charged_bytes::text FROM storage.space_quota WHERE space_id=$1',
            [artifact.space]
          )
        ).rows[0].charged_bytes
      ).toBe('0');
      expect(
        (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
          .rows[0].used_bytes
      ).toBe('0');
    } finally {
      release.resolve();
      await h.cleanup();
      await observer.close();
    }
  }, 30_000);
});
