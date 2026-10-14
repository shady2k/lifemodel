import { describe, it, expect } from 'vitest';
import { createTestStores } from '../helpers/test-stores.js';
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
  type: 'SEND_MESSAGE' as const,
  payload: { recipientId, text },
});
describe('new ledger and exhaustion boundaries', () => {
  for (const mode of [
    'two-first-error-sends',
    'empty-exhausted-error',
    'two-exhausted-error-sends',
  ] as const) {
    it(mode, async () => {
      const stores = await createTestStores();
      const prefix = `review-new-${mode}:${stores.workerId}:`;
      const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
      const epoch = await store.takeEpoch();
      const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
      store.register(inbound);
      const path = await makeScratchDir('review-new-error-');
      let outcomeCommitted = false;
      const instance = await startInstance(path, {
        cognitionMode: 'hang',
        tickIntervalMs: 10,
        commitSnapshot: async (tick, events) => {
          await store.commitOwners(epoch, tick, events);
          const s = inbound.exportSnapshot();
          outcomeCommitted =
            mode === 'two-first-error-sends'
              ? s.errorRetries['new-error'] === 1
              : s.recentMessageIds.includes('new-error');
        },
      });
      (instance.coreLoop as any).inboundStream = inbound;
      try {
        const signal = createUserMessageSignal({
          text: 'error',
          recipientId: instance.recipientId,
          channel: 'test',
          updateId: 'new-error',
        });
        await inbound.append(signal);
        await waitFor(() => instance.cognition.calls.length === 1, 'error turn started');
        if (mode !== 'two-first-error-sends') inbound.markFailedTurn([signal.id]);
        (instance.cognition as any).settleAll({
          confidence: 0,
          disposition: 'error',
          intents:
            mode === 'empty-exhausted-error'
              ? []
              : [
                  answer(instance.recipientId, 'partial 1'),
                  answer(instance.recipientId, 'partial 2'),
                ],
          response: undefined,
        });
        await waitFor(() => outcomeCommitted, 'error outcome committed');
        instance.coreLoop.haltForTest();
        const rows = await stores.redis.xrange(`${prefix}outbound`, '-', '+');
        const events = rows.map(([, f]) => JSON.parse(f[f.indexOf('event') + 1]!));
        expect(events).toHaveLength(mode === 'two-first-error-sends' ? 0 : 1);
      } finally {
        instance.coreLoop.haltForTest();
        await rmDir(path);
        await stores.redis.quit();
        await stores.postgres.end();
      }
    });
  }
  it('clears a failed head on its same-core retry before a 105-signal FIFO burst', async () => {
    const stores = await createTestStores();
    const prefix = `review-ledger-growth:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('review-growth-');
    const instance = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 5,
      busSignalStream: bus,
      commitSnapshot: async (tick, events) => {
        await store.commitOwners(epoch, tick, events);
      },
    });
    try {
      const head = thoughtSignal('failed head', instance.recipientId);
      instance.coreLoop.pushSignal(head);
      await waitFor(() => instance.cognition.calls.length === 1, 'first head attempt');
      instance.cognition.rejectAll();
      await waitFor(() => instance.cognition.calls.length === 2, 'same-core head retry');
      instance.cognition.settleAll({
        confidence: 1,
        intents: [],
        disposition: 'no_reply',
        response: undefined,
      });
      await waitFor(() => bus.committedOffset() !== '0-0', 'head gap completed');

      const later = Array.from({ length: 105 }, (_, n) =>
        thoughtSignal(`later ${n}`, instance.recipientId)
      );
      for (let n = 0; n < later.length; n++) {
        instance.coreLoop.pushSignal(later[n]!);
        await waitFor(() => instance.cognition.calls.length === n + 3, `later turn ${n}`);
        instance.cognition.settleAll({
          confidence: 1,
          intents: [],
          disposition: 'no_reply',
          response: undefined,
        });
      }
      await waitFor(
        () =>
          bus.exportSnapshot().entries && Object.keys(bus.exportSnapshot().entries).length === 0,
        'all later turns committed'
      );
      expect(instance.cognition.triggerIds()).toEqual([
        head.id,
        head.id,
        ...later.map((signal) => signal.id),
      ]);
      expect(instance.coreLoop.isRunning()).toBe(true);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
      await stores.redis.quit();
      await stores.postgres.end();
    }
  });

  it('atomic retention handles a full default-sized batch without orphan keys', async () => {
    const stores = await createTestStores();
    const prefix = `review-many-trim:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    try {
      await store.commitOwners(
        epoch,
        1,
        Array.from({ length: 10000 }, (_, i) => ({
          eventId: `many-${i}`,
          type: 'send.command',
          payload: { text: String(i) },
        }))
      );
      const { trimOutboundEvents } = await import('../../src/core/message-streams.js');
      let error: unknown;
      try {
        await trimOutboundEvents(stores.redis, {
          streamKey: `${prefix}outbound`,
          postgresOffsetKey: `${prefix}pg`,
          deliveryOffsetKey: `${prefix}delivery`,
          maxLength: 1,
          maxAgeMs: 60000,
        });
      } catch (e) {
        error = e;
      }
      const streamLength = await stores.redis.xlen(`${prefix}outbound`);
      const keyLength = await stores.redis.hlen(`${prefix}outbound:event-keys`);
    } finally {
      await stores.redis.quit();
      await stores.postgres.end();
    }
  });
});
