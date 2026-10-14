import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { createUserMessageSignal } from '../../src/types/signal.js';

describe('snapshot outbox commit', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('atomically commits snapshot sections and keyed outbound events, refusing stale epochs without events', async () => {
    const prefix = `snapshot-outbox:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const owner = {
      section: 'inbound',
      exportSnapshot: () => ({ offset: '1-0' }),
      hydrateSnapshot: () => undefined,
    };
    store.register(owner);
    const event = {
      eventId: 'answer:message-1',
      type: 'send.command',
      payload: { text: 'answer' },
    };
    await expect(store.commitOwners(epoch, 3, [event])).resolves.toBe(true);
    const entries = await stores.redis.xrange(`${prefix}outbound`, '-', '+');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[1]).toContain(event.eventId);
    expect(await store.read()).toMatchObject({ tick: 3 });
    await store.takeEpoch();
    await expect(
      store.commitOwners(epoch, 4, [{ ...event, eventId: 'answer:message-2' }])
    ).rejects.toThrow(/epoch mismatch/i);
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(1);
  });
});

describe('inbound message stream', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('replays pending entries from the snapshot and drops a settled duplicate by message id', async () => {
    const key = `inbound-test:${stores.workerId}`;
    const first = new InboundMessageStream(stores.redis, key);
    const signal = createUserMessageSignal({
      text: 'hello',
      recipientId: 'recipient-1',
      channel: 'test',
      updateId: 'msg-1',
    });
    await first.append(signal);
    expect((await first.readNew()).map((entry) => entry.signal.id)).toEqual([signal.id]);
    const saved = first.exportSnapshot();
    const restarted = new InboundMessageStream(stores.redis, key);
    restarted.hydrateSnapshot(saved);
    expect((await restarted.readNew()).map((entry) => entry.signal.id)).toEqual([signal.id]);
    restarted.settle([signal.id]);
    const settled = new InboundMessageStream(stores.redis, key);
    settled.hydrateSnapshot(restarted.exportSnapshot());
    await settled.append(
      createUserMessageSignal({
        text: 'duplicate',
        recipientId: 'recipient-1',
        channel: 'test',
        updateId: 'msg-1',
      })
    );
    expect(await settled.readNew()).toEqual([]);
    expect(settled.exportSnapshot().recipientOffsets['recipient-1']).toBeTruthy();
  });
});
