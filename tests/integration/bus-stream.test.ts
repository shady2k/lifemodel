import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import {
  createBusSignalStream,
  MAX_BUS_LEDGER_ENTRIES,
  type BusSnapshot,
} from '../../src/core/bus-stream.js';
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
      initialBusOffset: { version: 1, watermark: '0-0', entries: {} },
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
    const secondSignal = thoughtSignal('second consumed trigger', instance.recipientId);
    instance.coreLoop.pushSignal(firstSignal);
    instance.coreLoop.pushSignal(secondSignal);
    await waitFor(() => instance.cognition.calls.length === 1, 'cognition started');
    await waitFor(() => commitAttempts >= 1, 'initial snapshot committed');
    const bothBusEntries = await stream.readAfter('0-0', 10);
    expect(bothBusEntries).toHaveLength(2);
    const secondStreamId = bothBusEntries[1]!.id;
    const committedOffset = stream.committedOffset();
    expect(committedOffset).toBe('0-0');
    const send: SendMessageIntent = {
      type: 'SEND_MESSAGE',
      payload: { recipientId: instance.recipientId, text: 'must not commit' },
    };
    if (!('settleAll' in instance.cognition)) throw new Error('Expected fake cognition');
    instance.cognition.settleAll({ confidence: 1, intents: [send], response: undefined });
    await waitFor(() => attemptedOffset !== undefined, 'second snapshot commit attempted');
    await waitFor(() => instance.coreLoop.stopReport().loopStopped, 'core stopped after failure');
    expect(attemptedOffset).toBe(secondStreamId);
    expect(attemptedOutbox).toHaveLength(1);
    expect((await stores.redis.xrange(`${prefix}bus`, '-', '+')).map(([id]) => id)).toHaveLength(2);
    const restartBus = createBusSignalStream(stores.redis, prefix);
    restartBus.hydrateSnapshot(
      (await store.read())?.sections['busOffset'] as BusSnapshot | undefined
    );
    expect(
      (await restartBus.readAfter(restartBus.committedOffset(), 10)).map((entry) => entry.signal.id)
    ).toEqual([firstSignal.id, secondSignal.id]);
    expect(stream.committedOffset()).toBe(committedOffset);
    expect(await store.read()).toMatchObject({
      sections: { busOffset: { watermark: committedOffset } },
    });
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
      initialBusOffset: (await secondStore.read())?.sections['busOffset'] as
        | BusSnapshot
        | undefined,
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
    expect(snapshot?.sections['busOffset']).toMatchObject({
      version: 1,
      watermark: expect.stringMatching(/^\d+-\d+$/),
    });
    await second.coreLoop.stop();
  });

  it('replays both consumed bus entries in order after a failed snapshot CAS', async () => {
    const prefix = `bus-multi-replay:${stores.workerId}:${Date.now()}:`;
    const originalStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const originalBus = createBusSignalStream(stores.redis, prefix);
    originalStore.register(originalBus);
    const epoch = await originalStore.takeEpoch();
    await originalStore.commitOwners(epoch, 1);
    const signals = [
      thoughtSignal('first replay', 'recipient'),
      thoughtSignal('second replay', 'recipient'),
    ];
    const ids: string[] = [];
    for (const signal of signals) ids.push(await originalBus.append(signal));
    const consumed = await originalBus.readAfter('0-0', 10);
    expect(consumed.map((entry) => entry.signal.id)).toEqual(signals.map((signal) => signal.id));
    await originalStore.takeEpoch();
    await expect(originalStore.commitOwners(epoch, 2)).rejects.toThrow(/epoch mismatch/i);
    expect(await stores.redis.xrange(`${prefix}bus`, '-', '+')).toHaveLength(2);
    const restartedStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const restartedBus = createBusSignalStream(stores.redis, prefix);
    restartedStore.register(restartedBus);
    await restartedStore.hydrate(await restartedStore.read());
    expect(restartedBus.committedOffset()).toBe('0-0');
    expect(
      (await restartedBus.readAfter(restartedBus.committedOffset(), 10)).map((entry) => entry.id)
    ).toEqual(ids);
    expect((await restartedBus.readAfter('0-0', 10)).map((entry) => entry.signal.id)).toEqual(
      signals.map((signal) => signal.id)
    );
  });
  it('keeps sparse completed entries beyond the contiguous watermark and advances only across a completed prefix', async () => {
    const prefix = `bus-progress:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const first = thoughtSignal('A', 'recipient');
    const second = thoughtSignal('B', 'recipient');
    const firstId = await bus.append(first);
    const secondId = await bus.append(second);
    bus.ensureOwned(firstId, 'turn-A');
    bus.ensureOwned(secondId, 'turn-B');
    bus.markCompleted([secondId]);
    expect(bus.committedOffset()).toBe('0-0');
    expect(bus.exportSnapshot().entries[secondId]).toEqual({ status: 'completed' });
    await store.commitOwners(epoch, 1);

    const restarted = createBusSignalStream(stores.redis, prefix);
    const restartedStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    restartedStore.register(restarted);
    await restartedStore.hydrate(await restartedStore.read());
    const replay = await restarted.readAfter(restarted.committedOffset(), 10);
    expect(replay.map((entry) => entry.id)).toEqual([firstId, secondId]);
    expect(restarted.stateFor(secondId)?.status).toBe('completed');

    restarted.markCompleted([firstId]);
    expect(restarted.committedOffset()).toBe(secondId);
    expect(restarted.exportSnapshot().entries).toEqual({});
  });

  it('bounds ledger admission behind a failed gap and keeps completed entries non-replayable', async () => {
    const prefix = `bus-ledger-bound:${stores.workerId}:${Date.now()}:`;
    const stream = createBusSignalStream(stores.redis, prefix);
    const signals = Array.from({ length: MAX_BUS_LEDGER_ENTRIES + 5 }, (_, index) =>
      thoughtSignal(`bounded-${index}`)
    );
    const ids: string[] = [];
    for (const signal of signals) ids.push(await stream.append(signal));
    stream.ensureOwned(ids[0]!, 'failed-head');
    stream.markFailed([ids[0]!]);
    for (const id of ids.slice(1)) stream.ensureOwned(id, `pending:${id}`);
    stream.markCompleted(ids.slice(1, MAX_BUS_LEDGER_ENTRIES));

    const saved = stream.exportSnapshot();
    expect(Object.keys(saved.entries)).toHaveLength(MAX_BUS_LEDGER_ENTRIES);
    expect(saved.entries[ids[1]!]).toEqual({ status: 'completed' });
    expect(stream.admissionCapacity()).toBe(0);

    const restarted = createBusSignalStream(stores.redis, prefix);
    restarted.hydrateSnapshot(saved);
    expect(restarted.stateFor(ids[1]!)).toEqual({ status: 'completed' });
    expect(restarted.admissionCapacity()).toBe(0);
    expect((await restarted.readAfter('0-0', 200)).map(({ id }) => id)).toHaveLength(
      MAX_BUS_LEDGER_ENTRIES + 5
    );
  });
});
