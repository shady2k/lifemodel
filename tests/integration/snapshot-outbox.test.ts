import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import {
  InboundMessageStream,
  applyCommittedOutboundEvents,
  startOutboundDelivery,
  trimOutboundEvents,
} from '../../src/core/message-streams.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createConversationManager } from '../../src/storage/conversation-manager.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { createTestLogger } from '../helpers/test-logger.js';

describe('snapshot outbox commit', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
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
      payload: {
        text: 'answer',
        recipientId: 'recipient-1',
        channel: 'test',
        destination: 'recipient-1',
      },
    };
    await expect(store.commitOwners(epoch, 3, [event])).resolves.toBe(true);
    const entries = await stores.redis.xrange(`${prefix}outbound`, '-', '+');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[1]).toContain(event.eventId);
    expect(await store.read()).toMatchObject({ tick: 3 });
    await store.commitOwners(epoch, 4, [event]);
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(1);
    const manager = createConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    await applyCommittedOutboundEvents(
      stores.redis,
      manager,
      `${prefix}pg-applied`,
      `${prefix}outbound`
    );
    await applyCommittedOutboundEvents(
      stores.redis,
      manager,
      `${prefix}pg-applied`,
      `${prefix}outbound`
    );
    const historyRows = await stores.postgres.query(
      `SELECT message_id, payload FROM core.conversation_messages WHERE recipient_id = $1 AND kind = 'message'`,
      ['recipient-1']
    );
    expect(historyRows.rows).toHaveLength(1);
    expect(historyRows.rows[0]?.payload.content).toBe('answer');
    let resolveDelivered: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });
    let deliveryCount = 0;
    const sendMessage = async () => {
      deliveryCount += 1;
      resolveDelivered?.();
      return { success: true, messageId: 'external-1' };
    };
    const worker = startOutboundDelivery(
      stores.redis,
      new Map([['test', { sendMessage } as never]]),
      createTestLogger(),
      { streamKey: `${prefix}outbound`, offsetKey: `${prefix}delivery-offset` }
    );
    await delivered;
    worker.stop();
    await worker.done;
    expect(deliveryCount).toBe(1);
    const restartedWorker = startOutboundDelivery(
      stores.redis,
      new Map([['test', { sendMessage } as never]]),
      createTestLogger(),
      { streamKey: `${prefix}outbound`, offsetKey: `${prefix}delivery-offset` }
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    restartedWorker.stop();
    await restartedWorker.done;
    expect(deliveryCount).toBe(1);
    await store.takeEpoch();
    await expect(
      store.commitOwners(epoch, 5, [{ ...event, eventId: 'answer:message-2' }])
    ).rejects.toThrow(/epoch mismatch/i);
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(1);
  });
  it('trims only events below the slower Postgres and delivery cursors', async () => {
    const prefix = `outbound-trim:${stores.workerId}:`;
    const streamKey = `${prefix}events`;
    const postgresOffsetKey = `${prefix}pg-applied`;
    const deliveryOffsetKey = `${prefix}delivered`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await stores.redis.xadd(streamKey, '*', 'eventId', `trim-${i}`);
      if (!id) throw new Error('Valkey returned no outbound stream id');
      ids.push(id);
    }
    await stores.redis.set(postgresOffsetKey, ids[2]!);
    await stores.redis.set(deliveryOffsetKey, ids[1]!);
    await trimOutboundEvents(stores.redis, {
      streamKey,
      postgresOffsetKey,
      deliveryOffsetKey,
    });
    expect((await stores.redis.xrange(streamKey, '-', '+')).map(([id]) => id)).toEqual([
      ids[1],
      ids[2],
    ]);
  });
});

describe('inbound message stream', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('replaces a photo receipt with its completed message before queuing the turn', async () => {
    const key = `photo-inbound:${stores.workerId}`;
    const stream = new InboundMessageStream(stores.redis, key);
    const receipt = createUserMessageSignal({
      text: 'photo caption',
      recipientId: 'photo-recipient',
      channel: 'test',
      updateId: 'photo-update',
      pendingPhoto: { fileId: 'photo-file' },
    });
    const completed = createUserMessageSignal({
      text: 'photo caption',
      recipientId: 'photo-recipient',
      channel: 'test',
      updateId: 'photo-update',
    });
    await stream.append(receipt);
    await stream.append(completed);
    expect((await stream.readNew()).map((entry) => entry.signal.id)).toEqual([completed.id]);
  });

  it('XADDs one answer and row for a message, drops duplicate IDs, and replays only pre-commit input', async () => {
    const prefix = `inbound-e2e:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    let inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    store.register(inbound);
    const signal = createUserMessageSignal({
      text: 'hello',
      recipientId: 'recipient-1',
      channel: 'test',
      updateId: 'message-accepted',
    });
    await inbound.append(signal);
    expect((await inbound.readNew()).map((entry) => entry.signal.id)).toEqual([signal.id]);
    await inbound.append(
      createUserMessageSignal({
        text: 'redelivery',
        recipientId: 'recipient-1',
        channel: 'test',
        updateId: 'message-accepted',
      })
    );
    expect(await inbound.readNew()).toEqual([]);

    const event = {
      eventId: 'answer:message-accepted',
      type: 'send.command',
      payload: {
        text: 'answer once',
        recipientId: 'recipient-1',
        channel: 'test',
        destination: 'recipient-1',
      },
    };
    inbound.settle([signal.id]);
    await store.commitOwners(epoch, 1, [event]);
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(1);
    const manager = createConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    await applyCommittedOutboundEvents(
      stores.redis,
      manager,
      `${prefix}pg-applied`,
      `${prefix}outbound`
    );
    await applyCommittedOutboundEvents(
      stores.redis,
      manager,
      `${prefix}pg-applied`,
      `${prefix}outbound`
    );
    const rows = await stores.postgres.query(
      `SELECT message_id, payload FROM core.conversation_messages WHERE recipient_id = $1 AND kind = 'message' AND payload->>'content' = $2`,
      ['recipient-1', 'answer once']
    );
    expect(rows.rows).toHaveLength(1);
    const committed = await store.read();
    inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    inbound.hydrateSnapshot(
      committed?.sections['inbound'] as Parameters<typeof inbound.hydrateSnapshot>[0]
    );
    expect(await inbound.readNew()).toEqual([]);

    const beforeCommit = createUserMessageSignal({
      text: 'replay me',
      recipientId: 'recipient-1',
      channel: 'test',
      updateId: 'message-before-commit',
    });
    await inbound.append(beforeCommit);
    const restartedBeforeCommit = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    restartedBeforeCommit.hydrateSnapshot(
      committed?.sections['inbound'] as Parameters<typeof inbound.hydrateSnapshot>[0]
    );
    expect((await restartedBeforeCommit.readNew()).map((entry) => entry.signal.data)).toHaveLength(
      1
    );
  });

  it('commits delivery progress when no channel is registered', async () => {
    const prefix = `outbound-no-channel:${stores.workerId}:`;
    const event = {
      eventId: 'answer:no-channel',
      type: 'send.command',
      payload: {
        text: 'answer',
        recipientId: 'recipient-no-channel',
        channel: 'future-gateway',
        destination: 'recipient-no-channel',
      },
    };
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    await store.commitOwners(epoch, 1, [event]);
    const worker = startOutboundDelivery(stores.redis, new Map(), createTestLogger(), {
      streamKey: `${prefix}outbound`,
      offsetKey: `${prefix}delivery-offset`,
    });
    const deadline = Date.now() + 2_000;
    while ((await stores.redis.get(`${prefix}delivery-offset`)) === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    worker.stop();
    await worker.done;
    expect(await stores.redis.get(`${prefix}delivery-offset`)).not.toBeNull();
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(1);
  });
});
