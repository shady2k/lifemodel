import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import {
  startInstance,
  thoughtSignal,
  waitFor,
  makeScratchDir,
  rmDir,
} from '../helpers/core-loop-drain-harness.js';

const answer = (recipientId: string, text: string) => ({
  confidence: 1,
  intents: [{ type: 'SEND_MESSAGE' as const, payload: { recipientId, text } }],
  response: undefined,
});

describe('turn ownership and outbox durability', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('keys separate proactive turns by their trigger identity and commits both events', async () => {
    const prefix = `turn-keys:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('turn-keys-');
    const events: { eventId: string }[] = [];
    const instance = await startInstance(path, {
      tickIntervalMs: 10,
      busSignalStream: bus,
      commitSnapshot: async (tick, outbox) => {
        events.push(...outbox);
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    try {
      const fake = instance.cognition as { result: unknown };
      fake.result = answer(instance.recipientId, 'first');
      instance.coreLoop.pushSignal(thoughtSignal('first', instance.recipientId));
      await waitFor(() => events.length === 1, 'first proactive send committed');
      fake.result = answer(instance.recipientId, 'second');
      instance.coreLoop.pushSignal(thoughtSignal('second', instance.recipientId));
      await waitFor(() => events.length === 2, 'second proactive send committed');
      expect(events[0]!.eventId).not.toBe(events[1]!.eventId);
      await instance.coreLoop.stop();
      await store.commitOwners(epoch, instance.coreLoop.getTickCount() + 1, [events[0]!]);
      expect(await stores.redis.xlen(`${prefix}outbound`)).toBe(2);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
    }
  });

  it('retains immediate sends across a tick boundary until the CAS accepts them', async () => {
    const prefix = `turn-outbox:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('turn-outbox-');
    let commits = 0;
    const instance = await startInstance(path, {
      tickIntervalMs: 30,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
        commits += 1;
      },
    });
    try {
      await waitFor(() => commits > 0 && !instance.coreLoop.stopReport().tickInFlight, 'idle tick');
      instance.coreLoop.applyImmediateIntent({
        type: 'SEND_MESSAGE',
        payload: { recipientId: instance.recipientId, text: 'between ticks' },
      });
      const previous = commits;
      await waitFor(() => commits > previous, 'next CAS');
      expect(await stores.redis.xlen(`${prefix}outbound`)).toBe(1);
      expect(instance.coreLoop.getOutboxForTest()).toHaveLength(0);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
    }
  });

  it('commits a drained answer within graceful stop', async () => {
    const prefix = `turn-stop:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('turn-stop-');
    const instance = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 10,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    try {
      instance.coreLoop.pushSignal(thoughtSignal('drain answer', instance.recipientId));
      await waitFor(
        () => instance.cognition.calls.length === 1 && !instance.coreLoop.stopReport().tickInFlight,
        'turn started'
      );
      const stopping = instance.coreLoop.stop();
      (instance.cognition as { settleAll(result: unknown): void }).settleAll(
        answer(instance.recipientId, 'drained')
      );
      await stopping;
      expect(await stores.redis.xlen(`${prefix}outbound`)).toBe(1);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
    }
  });

  it('does not advance a bus offset while cognition owns its trigger', async () => {
    const prefix = `turn-pending:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('turn-pending-');
    const instance = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 10,
      busSignalStream: bus,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    try {
      instance.coreLoop.pushSignal(thoughtSignal('owned while pending', instance.recipientId));
      let committed = false;
      await waitFor(() => instance.cognition.calls.length === 1, 'pending cognition');
      await waitFor(() => {
        void store.read().then((snapshot) => {
          committed = snapshot !== null;
        });
        return committed;
      }, 'snapshot CAS');
      const snapshot = await store.read();
      expect(snapshot?.sections['busOffset']).toBe('0-0');
    } finally {
      instance.coreLoop.haltForTest();
      (instance.cognition as { settleAll(result: unknown): void }).settleAll(
        answer(instance.recipientId, 'done')
      );
      await rmDir(path);
    }
  });

  it('leaves error-disposition inbound work unsettled for restart retry', async () => {
    const prefix = `turn-error:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    store.register(inbound);
    const path = await makeScratchDir('turn-error-');
    const instance = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 10,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    (instance.coreLoop as unknown as { inboundStream: InboundMessageStream }).inboundStream =
      inbound;
    try {
      const signal = createUserMessageSignal({
        text: 'retry this',
        recipientId: instance.recipientId,
        channel: 'test',
        updateId: 'error-input',
      });
      await inbound.append(signal);
      await waitFor(() => instance.cognition.calls.length === 1, 'input reaches cognition');
      (instance.cognition as { settleAll(result: unknown): void }).settleAll({
        confidence: 0,
        intents: [],
        response: undefined,
        disposition: 'error',
      });
      let failedAttemptCommitted = false;
      await waitFor(() => {
        void store.read().then((current) => {
          const state = current?.sections['inbound'] as { errorRetries?: Record<string, number> };
          failedAttemptCommitted = state?.errorRetries?.['error-input'] === 1;
        });
        return failedAttemptCommitted;
      }, 'failed attempt is snapshotted');
      expect(inbound.exportSnapshot().recentMessageIds).not.toContain('error-input');
      const snapshot = await store.read();
      const section = snapshot?.sections['inbound'] as Parameters<
        typeof inbound.hydrateSnapshot
      >[0];
      expect(section?.pending).toContainEqual(
        expect.objectContaining({ messageId: 'error-input' })
      );
      expect(section?.errorRetries['error-input']).toBe(1);

      const retry = new InboundMessageStream(stores.redis, `${prefix}inbound`);
      retry.hydrateSnapshot(section);
      expect((await retry.readNew()).map((entry) => entry.messageId)).toEqual(['error-input']);

      inbound.markFailedTurn([signal.id]);
      await store.commitOwners(epoch, (snapshot?.tick ?? 0) + 1, []);
      const afterRetryFailure = new InboundMessageStream(stores.redis, `${prefix}inbound`);
      afterRetryFailure.hydrateSnapshot(
        (await store.read())?.sections['inbound'] as typeof section
      );
      expect(await afterRetryFailure.readNew()).toEqual([]);
      expect(afterRetryFailure.exportSnapshot().pending).toHaveLength(1);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
    }
  });

  it('does not copy inbound work into the bus when primed on repeated restarts', async () => {
    const prefix = `turn-input:${stores.workerId}:`;
    const streamKey = `${prefix}inbound`;
    const inbound = new InboundMessageStream(stores.redis, streamKey);
    const bus = createBusSignalStream(stores.redis, prefix);
    const signal = createUserMessageSignal({
      text: 'one owner',
      recipientId: 'recipient',
      channel: 'test',
      updateId: 'stable-input',
    });
    await inbound.append(signal);
    const path1 = await makeScratchDir('turn-input-first-');
    const first = await startInstance(path1, {
      tickIntervalMs: 10_000,
      busSignalStream: bus,
      commitSnapshot: async () => undefined,
    });
    (first.coreLoop as unknown as { inboundStream: InboundMessageStream }).inboundStream = inbound;
    try {
      for (const entry of await inbound.readNew()) first.coreLoop.pushSignal(entry.signal);
      await Promise.resolve();
      expect(await bus.readAfter('0-0', 10)).toEqual([]);
      first.coreLoop.haltForTest();

      const restartedInbound = new InboundMessageStream(stores.redis, streamKey);
      const replayed = await restartedInbound.readNew();
      expect(replayed.map((entry) => entry.signal.id)).toEqual([signal.id]);
      const restartedBus = createBusSignalStream(stores.redis, prefix);
      const path2 = await makeScratchDir('turn-input-restart-');
      const second = await startInstance(path2, {
        tickIntervalMs: 10_000,
        busSignalStream: restartedBus,
        commitSnapshot: async () => undefined,
      });
      (second.coreLoop as unknown as { inboundStream: InboundMessageStream }).inboundStream =
        restartedInbound;
      try {
        for (const entry of replayed) second.coreLoop.pushSignal(entry.signal);
        await Promise.resolve();
        expect(await restartedBus.readAfter('0-0', 10)).toEqual([]);
        second.coreLoop.haltForTest();
      } finally {
        await rmDir(path2);
      }
    } finally {
      first.coreLoop.haltForTest();
      await rmDir(path1);
    }
  });
});
