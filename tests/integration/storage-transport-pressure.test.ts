import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK, digest, createPressureHarness } from '../helpers/storage-pressure-harness.js';

let fixture: Awaited<ReturnType<typeof createPressureHarness>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe('storage transport pressure across many task spaces (ADR-015 S10)', () => {
  it('keeps reads below two seconds with 20 simultaneously open multi-chunk PUTs and bounded S3 pools', async () => {
    const spaces = Array.from({ length: 20 }, (_, index) => `transport-${index}`);
    const h = (fixture = await createPressureHarness({}, { spaces }));
    // All clients send the same bytes. Hash once before opening any request,
    // so fixture-only allocation/hash work cannot consume admission deadlines.
    const bytes = Buffer.alloc(2 * CHUNK + 1, 120);
    const sha256 = digest(bytes);
    const headers = {
      'content-length': String(bytes.length),
      'x-storage-name': Buffer.from('three-chunk-output.txt').toString('base64url'),
      'x-storage-length': String(bytes.length),
      'x-storage-sha256': sha256,
    };
    // Producer pacing is outside the real scheduler: an upload must not
    // acquire its next chunk while this fixture deliberately withholds those
    // bytes at a barrier. Every permitted chunk still uses real admission,
    // authorization, buffers and transports with unchanged production limits.
    const acquire = h.admission.acquire.bind(h.admission);
    type Request = Parameters<typeof acquire>[0];
    const rounds = new Map<string, number>();
    const waiting: Array<{ round: number; start: () => void }> = [];
    let openRound = 0;
    let producers = 0;
    function drainProducers() {
      while (producers < 6) {
        const index = waiting.findIndex((entry) => entry.round <= openRound);
        if (index === -1) return;
        waiting.splice(index, 1)[0]!.start();
      }
    }
    async function producerPermit(request: Request, round: number) {
      return new Promise<() => void>((resolve, reject) => {
        const abort = () => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(Error('fixture producer aborted'));
        };
        const entry = {
          round,
          start: () => {
            request.signal.removeEventListener('abort', abort);
            producers++;
            let released = false;
            resolve(() => {
              if (released) return;
              released = true;
              producers--;
              drainProducers();
            });
          },
        };
        if (request.signal.aborted) return abort();
        request.signal.addEventListener('abort', abort, { once: true });
        waiting.push(entry);
        drainProducers();
      });
    }
    h.admission.acquire = async (request) => {
      if (request.role !== 'task' || !spaces.includes(request.space)) return acquire(request);
      const round = rounds.get(request.space) ?? 0;
      rounds.set(request.space, round + 1);
      const releaseProducer = await producerPermit(request, round);
      try {
        const lease = await acquire(request);
        return {
          release() {
            lease.release();
            releaseProducer();
          },
        };
      } catch (error) {
        releaseProducer();
        throw error;
      }
    };
    function nextRound() {
      openRound++;
      drainProducers();
    }

    const uploads = spaces.map((space) =>
      h.begin(
        'task',
        'PUT',
        `/spaces/${space}/objects/three-chunk-output`,
        undefined,
        space,
        headers,
        true
      )
    );
    let completed = 0;
    for (const upload of uploads)
      void upload.settled.then(
        () => completed++,
        () => completed++
      );

    function assertSocketBounds() {
      const pools = h.s3.transportSnapshot();
      for (const [name, cap] of [
        ['put', 40],
        ['read', 8],
        ['control', 2],
      ] as const) {
        const pool = pools[name];
        expect(pool.limit).toBeLessThanOrEqual(cap);
        // Counts include idle keep-alive sockets, not just dispatched requests.
        expect(pool.sockets).toBeLessThanOrEqual(pool.limit);
        expect(pool.observedSockets).toBeLessThanOrEqual(pool.limit);
      }
      return pools;
    }
    async function readPair() {
      const replies = await Promise.all(
        Array.from({ length: 2 }, () => h.call('read', 'GET', `/spaces/reader/objects/${h.readId}`))
      );
      for (const reply of replies) {
        expect(reply.status).toBe(200);
        expect(reply.body.equals(h.readBytes)).toBe(true);
        expect(reply.elapsed).toBeLessThan(2000);
      }
      assertSocketBounds();
    }
    async function waitForAllOpenPuts(bytes: number) {
      // A backend PUT record exists only after an actual socket dispatch. A
      // complete first/second chunk on every request proves that these are 20
      // overlapping transports, not 20 queued attempts or sequential uploads.
      await expect
        .poll(
          () => ({
            reached: h.backend.requests.filter(
              (request) => request.method === 'PUT' && request.bytes >= bytes
            ).length,
            completed,
            active: h.admission.snapshot().active,
            queued: h.admission.snapshot().queued,
          }),
          { timeout: 5000 }
        )
        .toMatchObject({ reached: 20, completed: 0 });
      expect(completed).toBe(0);
      expect(h.backend.objects.size).toBe(1);
      const pools = assertSocketBounds();
      expect(pools.put.sockets).toBeGreaterThan(16);
      expect(pools.put.observedSockets).toBeGreaterThanOrEqual(20);
    }

    // Each client supplied one byte in begin(). Supply only its first chunk,
    // then leave the retained S3 PUT open while admission rotates all spaces.
    for (const upload of uploads) upload.request.write(bytes.subarray(1, CHUNK));
    await waitForAllOpenPuts(CHUNK);
    await readPair();

    // Rotate every upload through another chunk before reading again. A pool
    // shared with retained PUTs cannot serve these reserved owner/core reads.
    for (const upload of uploads) upload.request.write(bytes.subarray(CHUNK, 2 * CHUNK));
    nextRound();
    await waitForAllOpenPuts(2 * CHUNK);
    await readPair();

    // Keep reads running while all uploads finish, including checksum HEADs
    // on the separately bounded control socket pool.
    for (const upload of uploads) upload.request.end(Buffer.from('x'));
    // Both strict first-attempt barriers passed. Let completion and any bounded
    // protocol retry proceed, still paced through the real scheduler.
    openRound = Number.POSITIVE_INFINITY;
    drainProducers();
    await readPair();
    // The first attempt must pass both 20-open barriers without retries. At
    // completion, a bounded admission refusal is valid under full-suite load.
    // Behave like a protocol client: honor Retry-After, with five attempts total.
    const refusals: Array<{ space: string; attempt: number; elapsed: number; retryAfter: string }> =
      [];
    const replies = await Promise.all(
      uploads.map(async (upload, index) => {
        let reply = await upload.settled;
        for (let attempt = 1; attempt <= 5; attempt++) {
          expect(reply).not.toBeNull();
          if (!reply || reply.status !== 429) return reply;
          expect(reply.json?.error?.code).toBe('storage_overloaded');
          expect(reply.elapsed).toBeLessThan(1000);
          expect(reply.retryAfter).toMatch(/^[1-9]\d*$/);
          const retryAfter = reply.retryAfter!;
          refusals.push({ space: spaces[index]!, attempt, elapsed: reply.elapsed, retryAfter });
          // A fifth refusal is recorded but must fail the final success check.
          if (attempt === 5) return reply;
          await wait(Number(retryAfter) * 1000);
          reply = await h.call(
            'task',
            'PUT',
            `/spaces/${spaces[index]}/objects/three-chunk-output`,
            bytes,
            spaces[index],
            headers
          );
          assertSocketBounds();
        }
        return reply;
      })
    );
    expect(
      replies.map((reply) => ({
        status: reply?.status ?? 0,
        code: reply?.json?.error?.code ?? null,
      }))
    ).toEqual(Array.from({ length: 20 }, () => ({ status: 200, code: null })));
    expect(refusals.length).toBeLessThanOrEqual(20 * 4);
    const committed = await h.stores.postgres.query<{
      space_id: string;
      sha256: string;
      s3_key: string;
    }>(
      `SELECT o.space_id,o.sha256,a.s3_key FROM storage.objects o
       JOIN storage.object_versions v ON v.object_id=o.id
       JOIN storage.upload_attempts a ON a.id=v.attempt_id
       WHERE o.space_id=ANY($1::text[])`,
      [spaces]
    );
    expect(committed.rows.map((row) => row.space_id).sort()).toEqual([...spaces].sort());
    for (const row of committed.rows) {
      expect(row.sha256).toBe(sha256);
      const saved = h.backend.objects.get(row.s3_key);
      expect(saved).toBeDefined();
      expect(saved?.sha256).toBe(sha256);
      expect(saved?.bytes.length).toBe(bytes.length);
      expect(digest(saved!.bytes)).toBe(sha256);
    }
    expect(h.backend.objects.size).toBe(21);
    await expect.poll(() => h.admission.snapshot().active).toBe(0);
    await expect.poll(() => h.admission.snapshot().queued).toBe(0);
    const pools = assertSocketBounds();
    expect(pools.put.limit).toBe(40);
    expect(pools.read.limit).toBe(8);
    expect(pools.control.limit).toBe(2);
    expect(pools.read.observedSockets).toBeGreaterThan(0);
    expect(pools.control.observedSockets).toBeGreaterThan(0);
    expect(h.admission.snapshot().observed.active).toBeLessThanOrEqual(8);
    expect(h.admission.snapshot().observed.bufferedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  }, 30_000);
});
