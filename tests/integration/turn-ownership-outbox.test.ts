import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream, type BusSnapshot } from '../../src/core/bus-stream.js';
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

async function waitForAsync(condition: () => Promise<boolean>, what: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForEntries(bus: ReturnType<typeof createBusSignalStream>, count: number) {
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    const entries = await bus.readAfter('0-0', 10);
    if (entries.length >= count) return entries;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${String(count)} bus entries`);
}

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

  it('does not replay completed A when B remains pending across restart', async () => {
    const prefix = `turn-prefix:${stores.workerId}:${Date.now()}:`;
    const firstStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const firstBus = createBusSignalStream(stores.redis, prefix);
    firstStore.register(firstBus);
    const firstEpoch = await firstStore.takeEpoch();
    const firstPath = await makeScratchDir('turn-prefix-first-');
    const first = await startInstance(firstPath, {
      cognitionMode: 'hang',
      tickIntervalMs: 10,
      busSignalStream: firstBus,
      commitSnapshot: async (tick, outbox) => {
        await firstStore.commitOwners(firstEpoch, tick, outbox);
      },
    });
    try {
      const fake = first.cognition as { calls: unknown[]; settleAll(result: unknown): void };
      first.coreLoop.pushSignal(thoughtSignal('A', first.recipientId));
      await waitFor(() => fake.calls.length === 1, 'A cognition started');
      first.coreLoop.pushSignal(thoughtSignal('B', first.recipientId));
      const entries = await waitForEntries(firstBus, 2);
      const aId = entries[0]!.id;
      const bId = entries[1]!.id;
      fake.settleAll(answer(first.recipientId, 'A answer'));
      await waitForAsync(async () => {
        const current = await firstStore.read();
        const state = current?.sections['busOffset'] as BusSnapshot | undefined;
        return state?.watermark === aId && state.entries[bId]?.status === 'owned';
      }, 'A completed while B remains pending');
      first.coreLoop.haltForTest();

      const secondStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
      const secondBus = createBusSignalStream(stores.redis, prefix);
      secondStore.register(secondBus);
      await secondStore.hydrate(await secondStore.read());
      const secondEpoch = await secondStore.takeEpoch();
      const secondPath = await makeScratchDir('turn-prefix-restart-');
      const second = await startInstance(secondPath, {
        tickIntervalMs: 10,
        busSignalStream: secondBus,
        commitSnapshot: async (tick, outbox) => {
          await secondStore.commitOwners(secondEpoch, tick, outbox);
        },
      });
      try {
        (second.cognition as { result: unknown }).result = answer(second.recipientId, 'B answer');
        await waitForAsync(
          async () => (await stores.redis.xlen(`${prefix}outbound`)) === 2,
          'B answer committed'
        );
        const rows = await stores.redis.xrange(`${prefix}outbound`, '-', '+');
        const payloads = rows.map(([, fields]) => {
          const event = JSON.parse(fields[fields.indexOf('event') + 1] ?? 'null') as {
            eventId: string;
            payload: { text: string };
          };
          return event;
        });
        expect(payloads.map((event) => event.payload.text).sort()).toEqual([
          'A answer',
          'B answer',
        ]);
        expect(new Set(payloads.map((event) => event.eventId)).size).toBe(2);
        expect((second.cognition as { calls: unknown[] }).calls).toHaveLength(1);
      } finally {
        await second.coreLoop.stop();
        await rmDir(secondPath);
      }
    } finally {
      first.coreLoop.haltForTest();
      await rmDir(firstPath);
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
      expect(snapshot?.sections['busOffset']).toMatchObject({ watermark: '0-0' });
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
      instance.coreLoop.applyImmediateIntent({
        type: 'SEND_MESSAGE',
        payload: { recipientId: instance.recipientId, text: 'acknowledged before failure' },
      });
      (instance.cognition as { settleAll(result: unknown): void }).settleAll({
        confidence: 0,
        intents: [
          {
            type: 'SEND_MESSAGE',
            payload: { recipientId: instance.recipientId, text: 'partial 1' },
          },
          {
            type: 'SEND_MESSAGE',
            payload: { recipientId: instance.recipientId, text: 'partial 2' },
          },
        ],
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
      expect(await stores.redis.xlen(`${prefix}outbound`)).toBe(0);

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

  it('drops an error apology and lets a fresh core commit the real retry answer', async () => {
    const prefix = `turn-error-retry:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    store.register(bus);
    store.register(inbound);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('turn-error-retry-first-');
    const first = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 10,
      busSignalStream: bus,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    (first.coreLoop as unknown as { inboundStream: InboundMessageStream }).inboundStream = inbound;
    const signal = createUserMessageSignal({
      text: 'retry me',
      recipientId: first.recipientId,
      channel: 'test',
      updateId: 'retry-message',
    });
    try {
      await inbound.append(signal);
      await waitFor(() => first.cognition.calls.length === 1, 'first error attempt started');
      (first.cognition as { settleAll(result: unknown): void }).settleAll({
        ...answer(first.recipientId, 'failed apology'),
        disposition: 'error',
      });
      await waitForAsync(async () => {
        const snapshot = await store.read();
        const state = snapshot?.sections['inbound'] as { errorRetries?: Record<string, number> };
        return (
          state?.errorRetries?.['retry-message'] === 1 &&
          (await stores.redis.xlen(`${prefix}outbound`)) === 0
        );
      }, 'first failure committed without an apology event');
      first.coreLoop.haltForTest();

      const restartedStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
      const restartedBus = createBusSignalStream(stores.redis, prefix);
      const restartedInbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
      restartedStore.register(restartedBus);
      restartedStore.register(restartedInbound);
      await restartedStore.hydrate(await restartedStore.read());
      const restartedEpoch = await restartedStore.takeEpoch();
      const restartedPath = await makeScratchDir('turn-error-retry-second-');
      const restarted = await startInstance(restartedPath, {
        tickIntervalMs: 10,
        busSignalStream: restartedBus,
        commitSnapshot: async (tick, outbox) => {
          await restartedStore.commitOwners(restartedEpoch, tick, outbox);
        },
      });
      (restarted.coreLoop as unknown as { inboundStream: InboundMessageStream }).inboundStream =
        restartedInbound;
      try {
        (restarted.cognition as { result: unknown }).result = answer(
          restarted.recipientId,
          'real answer'
        );
        await waitForAsync(
          async () => (await stores.redis.xlen(`${prefix}outbound`)) === 1,
          'real retry answer committed'
        );
        const row = (await stores.redis.xrange(`${prefix}outbound`, '-', '+'))[0]!;
        const event = JSON.parse(row[1][row[1].indexOf('event') + 1] ?? 'null') as {
          eventId: string;
          payload: { text: string };
        };
        expect(event.payload.text).toBe('real answer');
        expect(event.eventId).toMatch(/^send:/);
        expect(await stores.redis.xlen(`${prefix}outbound`)).toBe(1);
      } finally {
        await restarted.coreLoop.stop();
        await rmDir(restartedPath);
      }
    } finally {
      first.coreLoop.haltForTest();
      await rmDir(path);
    }
  });

  it('replays a rejected internal trigger with its persisted turn identity', async () => {
    const prefix = `turn-rejected:${stores.workerId}:${Date.now()}:`;
    const firstStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const firstBus = createBusSignalStream(stores.redis, prefix);
    firstStore.register(firstBus);
    const firstEpoch = await firstStore.takeEpoch();
    const firstPath = await makeScratchDir('turn-rejected-first-');
    const first = await startInstance(firstPath, {
      cognitionMode: 'hang',
      tickIntervalMs: 10,
      busSignalStream: firstBus,
      commitSnapshot: async (tick, outbox) => {
        await firstStore.commitOwners(firstEpoch, tick, outbox);
      },
    });
    try {
      const signal = thoughtSignal('rejected internal', first.recipientId);
      first.coreLoop.pushSignal(signal);
      await waitFor(() => first.cognition.calls.length === 1, 'rejected trigger cognition started');
      const firstTurnId = (first.cognition.calls[0] as { context: { tickId: string } }).context
        .tickId;
      (first.cognition as { rejectAll(): void }).rejectAll();
      const entry = (await waitForEntries(firstBus, 1))[0]!;
      await waitForAsync(async () => {
        const state = firstBus.stateFor(entry.id);
        return state?.status === 'failed' && state.retries === 1;
      }, 'rejection stored as failed bus entry');
      await waitForAsync(async () => {
        const snapshot = await firstStore.read();
        const section = snapshot?.sections['busOffset'] as BusSnapshot | undefined;
        return section?.entries[entry.id]?.status === 'failed';
      }, 'failed state snapshotted');
      const committed = await firstStore.read();
      first.coreLoop.haltForTest();

      const restartedStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
      const restartedBus = createBusSignalStream(stores.redis, prefix);
      restartedStore.register(restartedBus);
      await restartedStore.hydrate(committed);
      const restartedEpoch = await restartedStore.takeEpoch();
      const restartedPath = await makeScratchDir('turn-rejected-second-');
      const restarted = await startInstance(restartedPath, {
        cognitionMode: 'hang',
        tickIntervalMs: 10,
        busSignalStream: restartedBus,
        commitSnapshot: async (tick, outbox) => {
          await restartedStore.commitOwners(restartedEpoch, tick, outbox);
        },
      });
      try {
        await waitFor(() => restarted.cognition.calls.length === 1, 'failed trigger replayed');
        const replayed = restarted.cognition.calls[0] as {
          context: { tickId: string; triggerSignals: { id: string }[] };
        };
        expect(replayed.context.tickId).toBe(firstTurnId);
        expect(replayed.context.triggerSignals.map((item) => item.id)).toContain(signal.id);
        expect(restartedBus.committedOffset()).toBe('0-0');
      } finally {
        restarted.coreLoop.haltForTest();
        await rmDir(restartedPath);
      }
    } finally {
      first.coreLoop.haltForTest();
      await rmDir(firstPath);
    }
  });

  it('commits exactly one distinct notice when inbound retries are exhausted', async () => {
    const prefix = `turn-exhausted:${stores.workerId}:${Date.now()}:`;
    let signal: ReturnType<typeof createUserMessageSignal> | undefined;
    let saved: Awaited<ReturnType<ReturnType<typeof createSnapshotStore>['read']>> = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
      const bus = createBusSignalStream(stores.redis, prefix);
      const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
      store.register(bus);
      store.register(inbound);
      if (saved) await store.hydrate(saved);
      const epoch = await store.takeEpoch();
      const path = await makeScratchDir(`turn-exhausted-${String(attempt)}-`);
      const instance = await startInstance(path, {
        cognitionMode: attempt === 1 ? 'hang' : 'immediate',
        tickIntervalMs: 10,
        busSignalStream: bus,
        commitSnapshot: async (tick, outbox) => {
          await store.commitOwners(epoch, tick, outbox);
        },
      });
      (instance.coreLoop as unknown as { inboundStream: InboundMessageStream }).inboundStream =
        inbound;
      try {
        if (attempt === 1) {
          signal = createUserMessageSignal({
            text: 'persistent failure',
            recipientId: instance.recipientId,
            channel: 'test',
            updateId: 'exhausted-message',
          });
          await inbound.append(signal);
        }
        (instance.cognition as { result: unknown }).result = {
          confidence: 0,
          intents: [
            {
              type: 'SEND_MESSAGE',
              payload: { recipientId: instance.recipientId, text: 'partial 1' },
            },
            {
              type: 'SEND_MESSAGE',
              payload: { recipientId: instance.recipientId, text: 'partial 2' },
            },
          ],
          response: undefined,
          disposition: 'error',
        };
        if (attempt === 1) {
          await waitFor(
            () => instance.cognition.calls.length === 1,
            'first failed attempt started'
          );
          (instance.cognition as { settleAll(result: unknown): void }).settleAll({
            ...answer(instance.recipientId, 'failure notice'),
            disposition: 'error',
          });
        }
        const expectedEvents = attempt === 1 ? 0 : 1;
        await waitForAsync(
          async () => {
            const snapshot = await store.read();
            saved = snapshot;
            const section = snapshot?.sections['inbound'] as
              | { pending: unknown[]; recentMessageIds: string[] }
              | undefined;
            const eventCount = await stores.redis.xlen(`${prefix}outbound`);
            return attempt === 1
              ? eventCount === 0 && section?.errorRetries?.['exhausted-message'] === 1
              : eventCount === expectedEvents &&
                  section?.pending.length === 0 &&
                  section.recentMessageIds.includes('exhausted-message');
          },
          attempt === 1
            ? 'first error remains retryable'
            : 'final notice and input outcome committed'
        );
        if (attempt === 1) {
          const section = saved?.sections['inbound'] as { errorRetries: Record<string, number> };
          expect(section.errorRetries['exhausted-message']).toBe(1);
          instance.coreLoop.haltForTest();
        } else {
          const rows = await stores.redis.xrange(`${prefix}outbound`, '-', '+');
          const event = JSON.parse(rows[0]![1][rows[0]![1].indexOf('event') + 1] ?? 'null') as {
            eventId: string;
            payload: { text: string };
          };
          expect(event.eventId).toMatch(/^error-notice:/);
          expect(event.payload.text).toBe('I could not complete that request after two attempts.');
          expect(event.payload.text).not.toMatch(/partial [12]/);
          expect(rows).toHaveLength(1);
        }
      } finally {
        if (attempt === 1) instance.coreLoop.haltForTest();
        else await instance.coreLoop.stop();
        await rmDir(path);
      }
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
