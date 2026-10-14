import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { createSignal } from '../../src/types/signal.js';
import type { SendMessageIntent } from '../../src/types/intent.js';
import {
  makeScratchDir,
  rmDir,
  startInstance,
  thoughtSignal,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';

describe('Valkey bus signal stream', () => {
  let stores: TestStores;
  const scratch: string[] = [];
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    for (const path of scratch) await rmDir(path);
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('rolls the bus offset back and leaves the outbox uncommitted when the snapshot commit fails', async () => {
    const prefix = `bus-rollback:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const stream = createBusSignalStream(stores.redis, prefix);
    store.register(stream);
    const epoch = await store.takeEpoch();
    let commitAttempts = 0;
    let attemptedOffset: string | undefined;
    let attemptedOutbox: unknown[] = [];
    const path = await makeScratchDir('lifemodel-bus-rollback-');
    scratch.push(path);
    const instance = await startInstance(path, {
      tickIntervalMs: 5,
      cognitionMode: 'hang',
      busSignalStream: stream,
      initialBusOffset: '0-0',
      commitSnapshot: async (tick, outbox) => {
        commitAttempts += 1;
        if (commitAttempts === 1) {
          await store.commitOwners(epoch, tick, outbox);
          return;
        }
        attemptedOffset = stream.committedOffset();
        attemptedOutbox = outbox;
        throw new Error('snapshot commit refused');
      },
    });
    const firstSignal = thoughtSignal('start cognition', instance.recipientId);
    instance.coreLoop.pushSignal(firstSignal);
    await waitFor(() => instance.cognition.calls.length === 1, 'cognition started');
    await waitFor(() => stream.committedOffset() !== '0-0', 'first bus offset committed');
    const committedOffset = stream.committedOffset();
    instance.coreLoop.pushSignal(thoughtSignal('consume with answer', instance.recipientId));
    const send: SendMessageIntent = {
      type: 'SEND_MESSAGE',
      payload: { recipientId: instance.recipientId, text: 'must not commit' },
    };
    if (!('settleAll' in instance.cognition)) throw new Error('Expected fake cognition');
    instance.cognition.settleAll({ confidence: 1, intents: [send], response: undefined });
    await waitFor(() => attemptedOffset !== undefined, 'second snapshot commit attempted');
    await waitFor(() => instance.coreLoop.stopReport().loopStopped, 'core stopped after failure');
    expect(attemptedOffset).not.toBe(committedOffset);
    expect(attemptedOutbox).toHaveLength(1);
    expect(stream.committedOffset()).toBe(committedOffset);
    expect(await store.read()).toMatchObject({ sections: { busOffset: committedOffset } });
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toEqual([]);
    await instance.coreLoop.stop();
  });

  it('replays a queued signal after a crash and never processes a committed signal twice', async () => {
    const prefix = `bus-test:${stores.workerId}:${Date.now()}:`;
    const firstStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const firstStream = createBusSignalStream(stores.redis, prefix);
    firstStore.register(firstStream);
    const firstEpoch = await firstStore.takeEpoch();
    const firstPath = await makeScratchDir('lifemodel-bus-crash-');
    scratch.push(firstPath);
    const first = await startInstance(firstPath, {
      tickIntervalMs: 10_000,
      busSignalStream: firstStream,
      commitSnapshot: async (tick) => {
        await firstStore.commitOwners(firstEpoch, tick);
      },
    });
    const signal = createSignal('thought', 'memory.thought', { value: 1 });
    first.coreLoop.pushSignal(signal);
    await waitFor(() => first.coreLoop.pendingSignalCount() === 1, 'signal accepted');
    const appendDeadline = Date.now() + 2_000;
    while ((await firstStream.readAfter('0-0', 10)).length === 0 && Date.now() < appendDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await firstStream.readAfter('0-0', 10)).toHaveLength(1);
    first.coreLoop.haltForTest();

    const secondStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const secondStream = createBusSignalStream(stores.redis, prefix);
    secondStore.register(secondStream);
    const secondEpoch = await secondStore.takeEpoch();
    const secondPath = await makeScratchDir('lifemodel-bus-restart-');
    scratch.push(secondPath);
    const second = await startInstance(secondPath, {
      tickIntervalMs: 5,
      busSignalStream: secondStream,
      initialBusOffset: (await secondStore.read())?.sections['busOffset'] as string | undefined,
      commitSnapshot: async (tick) => {
        await secondStore.commitOwners(secondEpoch, tick);
      },
    });
    await waitFor(
      () => second.autonomic.seen.flat().some((seen) => seen.id === signal.id),
      'signal processed after restart'
    );
    await waitFor(() => second.coreLoop.getTickCount() >= 3, 'committed follow-up ticks');
    expect(second.autonomic.seen.flat().filter((seen) => seen.id === signal.id)).toHaveLength(1);
    const snapshot = await secondStore.read();
    expect(snapshot?.sections['busOffset']).toMatch(/^\d+-\d+$/);
    await second.coreLoop.stop();
  });
});
