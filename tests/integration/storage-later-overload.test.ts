import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK, createPressureHarness, digest } from '../helpers/storage-pressure-harness.js';

let fixture: Awaited<ReturnType<typeof createPressureHarness>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe('later-chunk overload refusal', () => {
  it('answers 429 before blocked cleanup settles, then safely releases and retries', async () => {
    const h = (fixture = await createPressureHarness({
      transferWorkers: 3,
      reservedReadWorkers: 2,
      perSpaceWorkers: 1,
    }));
    let secondAdmission = 0;
    let attempts = 0;
    const acquire = h.admission.acquire.bind(h.admission);
    h.admission.acquire = (request) => {
      if (request.space === 'a' && ++attempts === 2) secondAdmission = performance.now();
      return acquire(request);
    };
    const first = h.stall('a', 'later-overload', 2 * CHUNK);
    const lock = await h.stores.postgres.connect();
    try {
      await expect
        .poll(
          async () =>
            (
              await h.stores.postgres.query(
                "SELECT count(*)::int AS n FROM storage.upload_attempts WHERE space_id='a' AND upload_id='later-overload'"
              )
            ).rows[0].n
        )
        .toBe(1);
      await lock.query('BEGIN');
      await lock.query(
        "SELECT 1 FROM storage.upload_intents WHERE space_id='a' AND upload_id='later-overload' FOR UPDATE"
      );
      const blocker = h.stall('b', 'next-chunk-blocker');
      await expect.poll(() => h.admission.snapshot().queued).toBe(1);
      first.request.write(Buffer.alloc(CHUNK - 1, 120));
      await expect.poll(() => secondAdmission).toBeGreaterThan(0);
      const reply = await first.settled;
      expect(reply?.status).toBe(429);
      expect(Number(reply?.retryAfter)).toBeGreaterThan(0);
      expect(performance.now() - secondAdmission).toBeLessThan(1000);
      // Real SQL cleanup is still waiting on our row lock after the HTTP reply.
      await expect
        .poll(
          async () =>
            (
              await h.stores.postgres.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%storage.release_upload%' AND wait_event_type='Lock'"
              )
            ).rows[0].n
        )
        .toBeGreaterThan(0);
      expect(
        (
          await h.stores.postgres.query(
            "SELECT state FROM storage.upload_intents WHERE space_id='a' AND upload_id='later-overload'"
          )
        ).rows[0].state
      ).toBe('pending');
      // Cleanup still owns its authorization stream; a fence cannot report
      // quiescence simply because the client already received a refusal.
      let quiesced = false;
      const quiescence = h.access.quiesceSpace('a', AbortSignal.timeout(2000)).then(() => {
        quiesced = true;
      });
      expect(quiesced).toBe(false);
      await lock.query('ROLLBACK');
      await quiescence;
      expect(quiesced).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await h.stores.postgres.query(
                "SELECT reserved FROM storage.upload_intents WHERE space_id='a' AND upload_id='later-overload'"
              )
            ).rows[0].reserved
        )
        .toBe(false);
      await h.s3.settle('a', AbortSignal.timeout(2000));
      blocker.abort();
      await expect.poll(() => h.admission.snapshot().active).toBe(0);
      const body = Buffer.alloc(2 * CHUNK, 120);
      const retry = await h.call('task', 'PUT', '/spaces/a/objects/later-overload', body, 'a', {
        'x-storage-name': Buffer.from('later-overload.txt').toString('base64url'),
        'x-storage-length': String(body.length),
        'x-storage-sha256': digest(body),
      });
      expect(retry.status).toBe(200);
      expect(
        (
          await h.stores.postgres.query(
            "SELECT count(*)::int AS n FROM storage.objects WHERE space_id='a'"
          )
        ).rows[0].n
      ).toBe(1);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      first.abort();
    }
  }, 15_000);
});
