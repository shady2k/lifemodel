import { describe, it, expect } from 'vitest';
import { createTestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import {
  startInstance,
  thoughtSignal,
  waitFor,
  makeScratchDir,
  rmDir,
} from '../helpers/core-loop-drain-harness.js';
const silent = {
  confidence: 1,
  intents: [],
  disposition: 'no_reply' as const,
  response: undefined,
};
describe('bounded admission liveness', () => {
  it('healthy burst larger than two ledger windows reaches cognition once each in FIFO order', async () => {
    const stores = await createTestStores();
    const prefix = `review-burst:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('review-burst-');
    const signals = Array.from({ length: 243 }, (_, i) => thoughtSignal(`burst ${i}`));
    for (const s of signals) await bus.append(s);
    let saved: any;
    let peak = 0;
    const h = await startInstance(path, {
      cognitionMode: 'immediate',
      tickIntervalMs: 5,
      busSignalStream: bus,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
        saved = bus.exportSnapshot();
        peak = Math.max(peak, Object.keys(saved.entries).length);
      },
    });
    h.cognition.result = silent;
    try {
      await waitFor(
        () =>
          h.cognition.triggerIds().length === 243 && Object.keys(saved?.entries ?? {}).length === 0,
        'healthy burst completely committed'
      );
      h.coreLoop.haltForTest();
      expect(h.cognition.triggerIds()).toEqual(signals.map((s) => s.id));
      expect(peak).toBeLessThanOrEqual(100);
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(path);
      await stores.redis.quit();
      await stores.postgres.end();
    }
  });
  it('admits a generated thought after the failed gap exhausts retries on the same core', async () => {
    const stores = await createTestStores();
    const prefix = `review-generated:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const seeds = Array.from({ length: 100 }, (_, i) => thoughtSignal(`seed ${i}`));
    const ids = [];
    for (const signal of seeds) ids.push(await bus.append(signal));
    for (const id of ids) bus.ensureOwned(id, `seed:${id}`);
    bus.markFailed([ids[0]!]);
    bus.markCompleted(ids.slice(1));
    await store.commitOwners(epoch, 0);
    const path = await makeScratchDir('review-generated-');
    const h = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 5,
      busSignalStream: bus,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    try {
      await waitFor(() => h.cognition.calls.length === 1, 'failed head retry');
      h.cognition.settleAll({
        confidence: 0,
        disposition: 'error',
        response: undefined,
        intents: [
          {
            type: 'EMIT_THOUGHT',
            payload: {
              content: 'generated while full',
              triggerSource: 'thought',
              depth: 1,
              rootThoughtId: 'generated-root',
              signalSource: 'cognition.thought',
            },
          },
        ],
      });
      await waitFor(() => h.cognition.calls.length === 2, 'generated thought admitted');
      const generated = (await bus.readAfter(ids.at(-1)!, 10))[0]!;
      expect(generated.signal.data).toMatchObject({ content: 'generated while full' });
      expect(h.cognition.triggerIds()).toEqual([seeds[0]!.id, generated.signal.id]);
      h.cognition.settleAll(silent);
      await waitFor(() => bus.committedOffset() === generated.id, 'generated thought committed');
      expect(h.coreLoop.isRunning()).toBe(true);
    } finally {
      await h.coreLoop.stop();
      await rmDir(path);
      await stores.redis.quit();
      await stores.postgres.end();
    }
  });
});
