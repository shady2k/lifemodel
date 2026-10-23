import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { CHUNK, createPressureHarness } from '../helpers/storage-pressure-harness.js';

let fixture: Awaited<ReturnType<typeof createPressureHarness>> | undefined;
let closeSlowApi: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  await closeSlowApi?.();
  closeSlowApi = undefined;
});

describe('storage initial admission arrival deadline', () => {
  it('includes a delayed real apiserver proof before the full-buffer queue refusal', async () => {
    // One full task chunk consumes the entire non-read byte budget. Metadata
    // admission (zero bytes) still passes, so this exercises auth BEFORE the
    // first actual GET buffer admission, not a quick initial queue refusal.
    const h = (fixture = await createPressureHarness(
      { bufferBytes: 3 * CHUNK, queueRequests: 1 },
      { readSpace: 'b' }
    ));
    const held = await h.admission.acquire({
      space: 'held',
      role: 'task',
      bytes: CHUNK,
      signal: new AbortController().signal,
    });
    let delayedReviews = 0;
    const slowApi = createServer(h.api.certificate, (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const part of req) chunks.push(Buffer.from(part));
        if (req.url?.endsWith('/tokenreviews')) {
          delayedReviews++;
          await delay(350);
        }
        const upstream = request(
          new URL(req.url ?? '/', h.api.options.apiServer),
          {
            method: req.method,
            headers: req.headers,
            ca: h.api.certificate.ca,
            agent: false,
          },
          (reply) => {
            reply.on('error', () => res.destroy());
            res.writeHead(reply.statusCode!, reply.headers);
            reply.pipe(res);
          }
        );
        upstream.on('error', () => res.destroy());
        upstream.end(Buffer.concat(chunks));
      })().catch(() => res.destroy());
    });
    slowApi.on('connection', (socket) => socket.on('error', () => undefined));
    await new Promise<void>((resolve) => slowApi.listen(0, '127.0.0.1', resolve));
    const address = slowApi.address();
    if (!address || typeof address === 'string') throw Error('slow apiserver unavailable');
    const identity = createKubernetesStorageIdentity({
      ...h.api.options,
      apiServer: `https://localhost:${address.port}`,
    });
    const original = h.access.identity;
    // The real access guard closes over this same object. Only its transport
    // endpoint changes; TokenReview, live Pod/Job proof and SQL remain real.
    const verify = original.verify;
    original.verify = identity.verify;
    closeSlowApi = async () => {
      original.verify = verify;
      identity.close();
      slowApi.closeAllConnections();
      await new Promise<void>((resolve) => slowApi.close(() => resolve()));
    };
    const path = `/spaces/b/objects/${h.readId}`;
    let arrived: number | undefined;
    h.app.task.server.prependOnceListener('request', (req) => {
      if (req.url === path) arrived = performance.now();
    });
    try {
      const operation = h.begin('task', 'GET', path, undefined, 'b');
      await expect.poll(() => delayedReviews).toBe(1);
      await expect.poll(() => h.admission.snapshot().queued).toBe(1);
      expect(h.admission.snapshot()).toMatchObject({
        bufferedBytes: CHUNK,
        queued: 1,
        observed: { queued: 1 },
      });
      const reply = await operation.settled;
      expect(reply?.status).toBe(429);
      expect(reply?.json).toMatchObject({ error: { code: 'storage_overloaded' } });
      expect(Number(reply?.retryAfter)).toBeGreaterThan(0);
      expect(arrived).toBeDefined();
      expect(performance.now() - arrived!).toBeLessThan(1000);
      expect(reply!.elapsed).toBeLessThan(1000);
      expect(h.api.reviews).toContain('b');
      expect(h.api.calls.some((call) => call.endsWith('/pods/b'))).toBe(true);
      expect(h.api.calls.some((call) => call.endsWith('/jobs/job-b'))).toBe(true);
      expect(h.admission.snapshot().queued).toBe(0);
    } finally {
      held.release();
    }
  });
});
