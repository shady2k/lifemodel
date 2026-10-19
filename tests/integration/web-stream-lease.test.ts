import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  ReadTranscriptOptions,
  TranscriptPage,
  TranscriptReader,
  TranscriptRow,
} from '../../src/ports/transcript.js';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { insertRow, startWebModule, stopWebModule } from '../helpers/web-live-page.js';
import { waitUntil } from '../helpers/browser-event-source.js';

const COOKIE = '__Host-lm_session=lease-walk-session';
/** The store's key for the slots this session holds, as the server derives it. */
const LEASE_KEY = `web:stream-leases:${createHash('sha256').update(COOKIE).digest('hex')}`;

/** Waits for the event it checks; never for a tick count. */
async function waitFor(check: () => Promise<boolean>, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A replica whose lease renewals reach no store, as a replica-specific outage is. */
class RenewalOutage implements TranscriptReader {
  failRenewals = false;

  constructor(private readonly inner: TranscriptReader) {}

  readTranscript(options: ReadTranscriptOptions): Promise<TranscriptPage> {
    return this.inner.readTranscript(options);
  }

  watchTranscript(after: string, signal?: AbortSignal): AsyncIterable<TranscriptRow> {
    return this.inner.watchTranscript(after, signal);
  }

  acquireStreamLease(session: string, expiresAt: number): Promise<string | null> {
    return this.inner.acquireStreamLease(session, expiresAt);
  }

  renewStreamLease(session: string, leaseId: string, expiresAt: number): Promise<boolean> {
    if (this.failRenewals) return Promise.reject(new Error('the store is unreachable here'));
    return this.inner.renewStreamLease(session, leaseId, expiresAt);
  }

  releaseStreamLease(session: string, leaseId: string): Promise<void> {
    return this.inner.releaseStreamLease(session, leaseId);
  }
}

interface LiveStream {
  status: number;
  /** Settles when the server's response body ends. */
  ended: Promise<void>;
  live(): boolean;
  frames(): string;
  stop(): void;
}

/** One page's event stream against a real web module. */
async function openStream(base: string, after = '0'): Promise<LiveStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?after=${after}`, {
    headers: { cookie: COOKIE },
    signal: controller.signal,
  });
  let frames = '';
  let finished = response.status !== 200;
  if (response.status !== 200) await response.body?.cancel().catch(() => undefined);
  const ended = (async () => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        frames += decoder.decode(value, { stream: true });
      }
    } catch {
      // The test aborted the stream.
    } finally {
      finished = true;
    }
  })();
  return {
    status: response.status,
    ended,
    live: () => !finished,
    frames: () => frames,
    stop: () => controller.abort(),
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

describe('a stream lease only lasts while the store confirms it', () => {
  it('refuses to renew a lease whose expiry has passed', async () => {
    const stores = await createTestStores();
    try {
      const store = new PostgresTranscriptStore(
        stores.postgres,
        stores.redis,
        'lease-renewal-owner'
      );
      const session = 'lapsed-renewal-session';
      const expiry = Date.now() + 200;
      const lease = await store.acquireStreamLease(session, expiry);
      if (!lease) throw new Error('the test could not take a lease');
      await new Promise((resolve) => setTimeout(resolve, 300));
      // No acquisition has pruned the lapsed score yet: the renewal itself must
      // refuse it, and leave the slot exactly as expired as it was.
      expect(await store.renewStreamLease(session, lease, Date.now() + 60_000)).toBe(false);
      const sessionKey = `web:stream-leases:${createHash('sha256').update(session).digest('hex')}`;
      expect(Number(await stores.redis.zscore(sessionKey, lease))).toBe(expiry);
      expect(await store.acquireStreamLease(session, Date.now() + 60_000)).not.toBeNull();
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('refuses to renew a lease that was released', async () => {
    const stores = await createTestStores();
    try {
      const store = new PostgresTranscriptStore(
        stores.postgres,
        stores.redis,
        'lease-release-owner'
      );
      const session = 'released-renewal-session';
      const lease = await store.acquireStreamLease(session, Date.now() + 60_000);
      if (!lease) throw new Error('the test could not take a lease');
      await store.releaseStreamLease(session, lease);
      expect(await store.renewStreamLease(session, lease, Date.now() + 60_000)).toBe(false);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('keeps a renewing stream alive across several lease lives', async () => {
    const stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const store = new PostgresTranscriptStore(
      stores.postgres,
      stores.redis,
      'lease-renewing-owner'
    );
    const module = await startWebModule(store, { streamLeaseTtlMs: 600 });
    const streams: LiveStream[] = [];
    try {
      const stream = await openStream(module.base);
      streams.push(stream);
      expect(stream.status).toBe(200);
      await waitUntil(() => stream.frames().includes('event: state'), 'the stream to open');
      // Liveness across a stretch of time is the property here, so the test
      // waits it out: several lease lives pass (a 600 ms lease renewed every
      // 200 ms), and every renewal the store answered moved the deadline.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(stream.live()).toBe(true);
      await insertRow(stores, 'lease-renewing-owner', 'channel:web:renewed', 'assistant', 'ответ');
      await waitUntil(() => stream.frames().includes('ответ'), 'the reply on the renewing stream');
    } finally {
      for (const stream of streams) stream.stop();
      await waitFor(async () => (await stores.redis.zcard(LEASE_KEY)) === 0, 'the lease release');
      await stopWebModule(module);
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  }, 30_000);

  it('ends a stream whose renewals fail past its lease deadline', async () => {
    const stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const store = new PostgresTranscriptStore(stores.postgres, stores.redis, 'lease-outage-owner');
    const outage = new RenewalOutage(store);
    const module = await startWebModule(outage, { streamLeaseTtlMs: 1_000 });
    const streams: LiveStream[] = [];
    try {
      const lapsed = await openStream(module.base);
      streams.push(lapsed);
      expect(lapsed.status).toBe(200);
      await waitUntil(() => lapsed.frames().includes('event: state'), 'the stream to open');
      // The replica can no longer reach the store, so no renewal is confirmed.
      outage.failRenewals = true;
      const deadline = Date.now();
      await withDeadline(lapsed.ended, 6_000, 'the stream to end at its lease deadline');
      expect(lapsed.live()).toBe(false);
      // It ended at the lease, not at the stream's own 15-minute age.
      expect(Date.now() - deadline).toBeLessThan(4_000);
      expect(lapsed.frames()).toContain('event: state');
      // Its slot came free: the next page is admitted at once.
      const next = await openStream(module.base);
      streams.push(next);
      expect(next.status).toBe(200);
    } finally {
      for (const stream of streams) stream.stop();
      // Wait out the releases the streams started, so no store call is left
      // in flight when the connections close.
      await waitFor(async () => (await stores.redis.zcard(LEASE_KEY)) === 0, 'the lease release');
      await stopWebModule(module);
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  }, 30_000);

  it('never holds more than four live streams for one session in total', async () => {
    const stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const store = new PostgresTranscriptStore(stores.postgres, stores.redis, 'lease-replica-owner');
    const outage = new RenewalOutage(store);
    const first = await startWebModule(outage, { streamLeaseTtlMs: 1_200 });
    const second = await startWebModule(store, { streamLeaseTtlMs: 1_200 });
    const streams: LiveStream[] = [];
    try {
      const held = await Promise.all([0, 1, 2, 3].map(() => openStream(first.base)));
      streams.push(...held);
      expect(held.map((stream) => stream.status)).toEqual([200, 200, 200, 200]);
      await waitUntil(
        () => held.every((stream) => stream.frames().includes('event: state')),
        'the four streams of the first replica'
      );
      // The second replica of the same module cannot take a fifth slot: the sum
      // for this session is four, however many module instances are running.
      const refused = await Promise.all([0, 1, 2, 3].map(() => openStream(second.base)));
      streams.push(...refused);
      expect(refused.map((stream) => stream.status)).toEqual([429, 429, 429, 429]);
      expect(held.filter((stream) => stream.live()).length).toBe(4);
      // The first replica loses its renewals: its four streams end at the lease
      // instead of keeping slots the store is free to hand out again.
      outage.failRenewals = true;
      await withDeadline(
        Promise.all(held.map((stream) => stream.ended)),
        6_000,
        'the four lapsed streams to end'
      );
      expect(held.filter((stream) => stream.live()).length).toBe(0);
      const admitted = await Promise.all([0, 1, 2, 3].map(() => openStream(second.base)));
      streams.push(...admitted);
      expect(admitted.map((stream) => stream.status)).toEqual([200, 200, 200, 200]);
      const fifth = await openStream(second.base);
      streams.push(fifth);
      expect(fifth.status).toBe(429);
    } finally {
      for (const stream of streams) stream.stop();
      await waitFor(async () => (await stores.redis.zcard(LEASE_KEY)) === 0, 'the lease release');
      await Promise.all([stopWebModule(first), stopWebModule(second)]);
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  }, 30_000);
});
