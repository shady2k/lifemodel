import { describe, it, expect } from 'vitest';
import { createTestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { InboundMessageStream, trimOutboundEvents } from '../../src/core/message-streams.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import {
  startInstance,
  thoughtSignal,
  waitFor,
  makeScratchDir,
  rmDir,
  makeDeferred,
} from '../helpers/core-loop-drain-harness.js';
const answer = (recipientId: string, text: string) => ({
  type: 'SEND_MESSAGE' as const,
  payload: { recipientId, text },
});
async function waitAsync(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(label);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const events = async (redis: any, key: string) =>
  (await redis.xrange(key, '-', '+')).map(([, f]: any) => JSON.parse(f[f.indexOf('event') + 1]));
describe('new mechanism regression boundaries', () => {
  for (const stopDrain of [false, true])
    for (const rejected of [false, true]) {
      it(`exhausted notice takeover drain=${stopDrain} rejected=${rejected}`, async () => {
        const stores = await createTestStores();
        const prefix = `review-notice-${stopDrain}-${rejected}:${stores.workerId}:`;
        const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
        const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
        store.register(inbound);
        const epoch = await store.takeEpoch();
        const path = await makeScratchDir('review-notice-takeover-');
        let secondPath: string | undefined;
        let second: any;
        let sawStale = false;
        let stopping: Promise<void> | undefined;
        let attempted = false;
        const release = makeDeferred<void>();
        const first = await startInstance(path, {
          cognitionMode: 'hang',
          tickIntervalMs: 10,
          drainTimeoutMs: 5000,
          onStaleSnapshot: () => {
            sawStale = true;
          },
          commitSnapshot: async (tick, outbox) => {
            if (outbox.some((e) => e.eventId.startsWith('error-notice:'))) {
              attempted = true;
              await release.promise;
            }
            await store.commitOwners(epoch, tick, outbox);
          },
        });
        (first.coreLoop as any).inboundStream = inbound;
        try {
          const signal = createUserMessageSignal({
            text: 'fail twice',
            recipientId: first.recipientId,
            channel: 'test',
            updateId: 'takeover-input',
          });
          await inbound.append(signal);
          await waitFor(() => first.cognition.calls.length === 1, 'first cognition starts');
          inbound.markFailedTurn([signal.id]);
          await waitAsync(
            async () =>
              ((await store.read())?.sections.inbound as any)?.errorRetries['takeover-input'] === 1,
            'retry count stored'
          );
          first.coreLoop.applyImmediateIntent(answer(first.recipientId, 'ack 1'));
          first.coreLoop.applyImmediateIntent(answer(first.recipientId, 'ack 2'));
          if (stopDrain) stopping = first.coreLoop.stop();
          if (rejected) (first.cognition as any).rejectAll();
          else
            (first.cognition as any).settleAll({
              confidence: 0,
              disposition: 'error',
              intents: [
                answer(first.recipientId, 'partial 1'),
                answer(first.recipientId, 'partial 2'),
              ],
              response: undefined,
            });
          await waitFor(() => attempted, 'notice final CAS reached');
          const bytes = await stores.redis.get(`${prefix}current`);
          await store.takeEpoch();
          release.resolve();
          if (stopping) await stopping;
          else await waitFor(() => sawStale, 'stale tick writer stops');
          first.coreLoop.haltForTest();
          expect(await stores.redis.get(`${prefix}current`)).toBe(bytes);
          expect(await stores.redis.xlen(`${prefix}outbound`)).toBe(0);
          expect((first.coreLoop as any).running).toBe(false);
          const freshStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
          const freshInbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
          freshStore.register(freshInbound);
          await freshStore.hydrate(await store.read());
          const freshEpoch = await freshStore.takeEpoch();
          secondPath = await makeScratchDir('review-notice-fresh-');
          let done = false;
          second = await startInstance(secondPath, {
            cognitionMode: 'hang',
            tickIntervalMs: 10,
            commitSnapshot: async (tick, outbox) => {
              await freshStore.commitOwners(freshEpoch, tick, outbox);
              done = freshInbound.exportSnapshot().recentMessageIds.includes('takeover-input');
            },
          });
          (second.coreLoop as any).inboundStream = freshInbound;
          await waitFor(() => second.cognition.calls.length === 1, 'fresh core retries');
          if (rejected) second.cognition.rejectAll();
          else
            second.cognition.settleAll({
              confidence: 0,
              disposition: 'error',
              intents: [],
              response: undefined,
            });
          await waitFor(() => done, 'fresh notice and completion committed');
          second.coreLoop.haltForTest();
          const rows = await events(stores.redis, `${prefix}outbound`);
        } finally {
          release.resolve();
          first.coreLoop.haltForTest();
          second?.coreLoop.haltForTest();
          if (stopping) await stopping;
          await rmDir(path);
          if (secondPath) await rmDir(secondPath);
          await stores.redis.quit();
          await stores.postgres.end();
        }
      });
    }
  it('success batch retains stable ownership for two answers and an intervening other-recipient send', async () => {
    const stores = await createTestStores();
    const prefix = `review-success-batch:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    store.register(inbound);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('review-success-');
    let done = false;
    const h = await startInstance(path, {
      cognitionMode: 'hang',
      tickIntervalMs: 10,
      commitSnapshot: async (tick, outbox) => {
        await store.commitOwners(epoch, tick, outbox);
        done = inbound.exportSnapshot().recentMessageIds.includes('success-batch');
      },
    });
    (h.coreLoop as any).inboundStream = inbound;
    try {
      const registry = (h.coreLoop as any).intentApplicator.deps.recipientRegistry;
      const other = registry.getOrCreate('test', 'other-chat');
      await inbound.append(
        createUserMessageSignal({
          text: 'answer',
          recipientId: h.recipientId,
          channel: 'test',
          updateId: 'success-batch',
        })
      );
      await waitFor(() => h.cognition.calls.length === 1, 'batch starts');
      h.cognition.settleAll({
        confidence: 1,
        disposition: 'answered',
        response: undefined,
        intents: [
          answer(h.recipientId, 'final 1'),
          answer(other, 'other'),
          answer(h.recipientId, 'final 2'),
        ],
      });
      await waitFor(() => done, 'whole batch committed');
      h.coreLoop.haltForTest();
      const rows = await events(stores.redis, `${prefix}outbound`);
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(path);
      await stores.redis.quit();
      await stores.postgres.end();
    }
  });
  it('concurrent full-horizon trim and keyed append keep rows and key hash in sync', async () => {
    const stores = await createTestStores();
    const prefix = `review-race-trim:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const streamKey = `${prefix}outbound`;
    const hashKey = `${streamKey}:event-keys`;
    try {
      await store.commitOwners(
        epoch,
        1,
        Array.from({ length: 10000 }, (_, i) => ({
          eventId: `race-${i}`,
          type: 'send.command',
          payload: { text: String(i) },
        }))
      );
      const appendEvents = [
        { eventId: 'race-fresh', type: 'send.command', payload: { text: 'fresh' } },
        { eventId: 'race-0', type: 'send.command', payload: { text: 'reused' } },
      ];
      await Promise.all([
        trimOutboundEvents(stores.redis, {
          streamKey,
          postgresOffsetKey: `${prefix}pg`,
          deliveryOffsetKey: `${prefix}delivery`,
          maxLength: 1,
          maxAgeMs: 60000,
        }),
        store.commitOwners(epoch, 2, appendEvents),
      ]);
      const rows = await stores.redis.xrange(streamKey, '-', '+');
      const keys = await stores.redis.hgetall(hashKey);
      expect(Object.keys(keys)).toHaveLength(rows.length);
      for (const [id, fields] of rows) {
        const eventId = fields[fields.indexOf('eventId') + 1]!;
        expect(keys[eventId]).toBe(id);
      }
      expect(Object.hasOwn(keys, 'race-fresh')).toBe(true);
      const count = rows.length;
      await store.commitOwners(epoch, 3, [appendEvents[0]!]);
      expect(await stores.redis.xlen(streamKey)).toBe(count);
    } finally {
      await stores.redis.quit();
      await stores.postgres.end();
    }
  });
  it('a key deletion error leaves every stream row discoverable for retry', async () => {
    const stores = await createTestStores();
    const prefix = `review-trim-wrongtype:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const streamKey = `${prefix}outbound`;
    const hashKey = `${streamKey}:event-keys`;
    try {
      await store.commitOwners(
        epoch,
        1,
        Array.from({ length: 1000 }, (_, i) => ({
          eventId: `wrong-${i}`,
          type: 'send.command',
          payload: { text: String(i) },
        }))
      );
      const previous = await stores.redis.xrange(streamKey, '-', '+');
      await stores.redis.del(hashKey);
      await stores.redis.set(hashKey, 'wrong type');
      await expect(
        trimOutboundEvents(stores.redis, { streamKey, maxLength: 1, maxAgeMs: 60000 })
      ).rejects.toThrow(/WRONGTYPE/);
      expect(await stores.redis.xrange(streamKey, '-', '+')).toEqual(previous);
      await stores.redis.del(hashKey);
      for (const [id, f] of previous)
        await stores.redis.hset(hashKey, f[f.indexOf('eventId') + 1]!, id);
      await trimOutboundEvents(stores.redis, { streamKey, maxLength: 1, maxAgeMs: 60000 });
      expect(await stores.redis.xlen(streamKey)).toBe(1);
      expect(await stores.redis.hlen(hashKey)).toBe(1);
    } finally {
      await stores.redis.quit();
      await stores.postgres.end();
    }
  });
});
