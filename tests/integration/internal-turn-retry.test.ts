import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import {
  makeScratchDir,
  rmDir,
  startInstance,
  thoughtSignal,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';

describe('internal cognition retries', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('retries a failed head once and releases 105 later signals in FIFO on the same core', async () => {
    const prefix = `internal-retry:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('internal-retry-');
    const instance = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 5,
      busSignalStream: bus,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    const cognition = instance.cognition as {
      calls: unknown[];
      triggerIds(): string[];
      rejectAll(): void;
      settleAll(result: unknown): void;
    };
    const head = thoughtSignal('failed head', instance.recipientId);
    try {
      instance.coreLoop.pushSignal(head);
      await waitFor(() => cognition.calls.length === 1, 'first head attempt');
      cognition.rejectAll();
      await waitFor(() => cognition.calls.length === 2, 'same-core retry');
      expect(cognition.triggerIds()[1]).toBe(head.id);
      cognition.settleAll({
        confidence: 1,
        intents: [],
        disposition: 'no_reply',
        response: undefined,
      });
      await waitFor(() => bus.committedOffset() !== '0-0', 'retried head completed');

      const later = Array.from({ length: 105 }, (_, index) =>
        thoughtSignal(`later ${index}`, instance.recipientId)
      );
      for (let index = 0; index < later.length; index++) {
        instance.coreLoop.pushSignal(later[index]!);
        await waitFor(() => cognition.calls.length === index + 3, `later turn ${index}`);
        cognition.settleAll({
          confidence: 1,
          intents: [],
          disposition: 'no_reply',
          response: undefined,
        });
      }
      await waitFor(
        () =>
          cognition.calls.length === 107 && Object.keys(bus.exportSnapshot().entries).length === 0,
        'all later signals committed'
      );
      expect(cognition.triggerIds()).toEqual([
        head.id,
        head.id,
        ...later.map((signal) => signal.id),
      ]);
      expect(Object.keys(bus.exportSnapshot().entries)).toHaveLength(0);
      expect(instance.coreLoop.isRunning()).toBe(true);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
    }
  });

  it('completes an internal entry with a warning after its retry also fails', async () => {
    const prefix = `internal-retry-exhausted:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('internal-retry-exhausted-');
    const instance = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 5,
      recordLogs: true,
      busSignalStream: bus,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    try {
      instance.coreLoop.pushSignal(thoughtSignal('fails twice', instance.recipientId));
      await waitFor(() => instance.cognition.calls.length === 1, 'first attempt');
      instance.cognition.rejectAll();
      await waitFor(() => instance.cognition.calls.length === 2, 'single retry');
      instance.cognition.rejectAll();
      await waitFor(() => bus.committedOffset() !== '0-0', 'failed entry completed');
      await waitFor(
        () =>
          instance.recordedLogs.some(
            (log) =>
              log.level === 'warn' &&
              log.msg ===
                'Internal signals failed twice and were completed with their recorded failure'
          ),
        'failure warning recorded'
      );
      expect(Object.keys(bus.exportSnapshot().entries)).toHaveLength(0);
      expect(instance.cognition.calls).toHaveLength(2);
      expect(instance.coreLoop.isRunning()).toBe(true);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
    }
  });
});
