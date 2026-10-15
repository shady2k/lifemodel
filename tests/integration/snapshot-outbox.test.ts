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
import {
  createFencedPostgres,
  StalePostgresEpochError,
} from '../../src/storage/fenced-postgres.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../helpers/test-logger.js';
import { SignalAggregator } from '../../src/layers/aggregation/aggregator.js';

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
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(0);
    await store.takeEpoch();
    await expect(
      store.commitOwners(epoch, 5, [{ ...event, eventId: 'answer:message-2' }])
    ).rejects.toThrow(/epoch mismatch/i);
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(0);
  });
  it('trims through the Postgres apply offset even when no delivery cursor advances', async () => {
    const prefix = `outbound-trim:${stores.workerId}:`;
    const streamKey = `${prefix}events`;
    const postgresOffsetKey = `${prefix}pg-applied`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await stores.redis.xadd(streamKey, '*', 'eventId', `trim-${i}`);
      if (!id) throw new Error('Valkey returned no outbound stream id');
      ids.push(id);
    }
    await stores.redis.set(postgresOffsetKey, ids[1]!);
    await trimOutboundEvents(stores.redis, {
      streamKey,
      postgresOffsetKey,
    });
    expect((await stores.redis.xrange(streamKey, '-', '+')).map(([id]) => id)).toEqual([ids[2]]);
  });

  it('keeps event keys aligned with rows when the HDEL cleanup path is configured to fail', async () => {
    const prefix = `outbound-atomic-trim:${stores.workerId}:`;
    const streamKey = `${prefix}events`;
    const eventKeysKey = `${streamKey}:event-keys`;
    for (let i = 0; i < 6; i += 1) {
      const eventId = `atomic-${i}`;
      const id = await stores.redis.xadd(streamKey, '*', 'eventId', eventId, 'event', '{}');
      if (!id) throw new Error('Valkey returned no stream id');
      await stores.redis.hset(eventKeysKey, eventId, id);
    }
    let hdelCalls = 0;
    const failHdel = new Proxy(stores.redis, {
      get(target, property) {
        if (property === 'hdel') {
          return async () => {
            hdelCalls += 1;
            throw new Error('injected HDEL failure');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await trimOutboundEvents(failHdel as never, {
      streamKey,
      postgresOffsetKey: `${prefix}pg`,
      eventKeysKey,
      maxLength: 2,
      maxAgeMs: 60_000,
    });
    expect(hdelCalls).toBe(0);
    expect(await stores.redis.xlen(streamKey)).toBe(2);
    expect(await stores.redis.hlen(eventKeysKey)).toBe(2);
  });

  it('trims the full default horizon with bounded key-delete batches and the exact drop count', async () => {
    const prefix = `outbound-default-horizon:${stores.workerId}:${Date.now()}:`;
    const streamKey = `${prefix}events`;
    const eventKeysKey = `${streamKey}:event-keys`;
    const pipeline = stores.redis.pipeline();
    const count = 10_001;
    for (let index = 1; index <= count; index += 1) {
      const id = `${index}-0`;
      const eventId = `horizon-${index}`;
      pipeline.xadd(streamKey, id, 'eventId', eventId, 'event', '{}');
      pipeline.hset(eventKeysKey, eventId, id);
    }
    const inserted = await pipeline.exec();
    if (!inserted) throw new Error('Valkey did not execute the retention fixture pipeline');
    const calls: RecordedLog[] = [];
    await trimOutboundEvents(stores.redis, {
      streamKey,
      eventKeysKey,
      postgresOffsetKey: `${prefix}pg`,
      logger: recordingLogger(createTestLogger(), calls),
    });
    expect(await stores.redis.xlen(streamKey)).toBe(0);
    expect(await stores.redis.hlen(eventKeysKey)).toBe(0);
    expect(calls.filter((call) => call.level === 'warn')).toEqual([
      expect.objectContaining({ obj: expect.objectContaining({ count }) }),
    ]);
  });

  it('bounds no-channel backlog and event-key growth with one warning per trim', async () => {
    const prefix = `outbound-retention:${stores.workerId}:`;
    const streamKey = `${prefix}events`;
    const eventKeysKey = `${streamKey}:event-keys`;
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = await stores.redis.xadd(
        streamKey,
        '*',
        'eventId',
        `retention-${i}`,
        'event',
        '{}'
      );
      if (!id) throw new Error('Valkey returned no stream id');
      ids.push(id);
      await stores.redis.hset(eventKeysKey, `retention-${i}`, id);
    }
    const calls: RecordedLog[] = [];
    await trimOutboundEvents(stores.redis, {
      streamKey,
      postgresOffsetKey: `${prefix}pg`,
      eventKeysKey,
      maxLength: 5,
      maxAgeMs: 60_000,
      logger: recordingLogger(createTestLogger(), calls),
    });
    expect(await stores.redis.xlen(streamKey)).toBe(5);
    expect(await stores.redis.hlen(eventKeysKey)).toBe(5);
    expect(calls.filter((call) => call.level === 'warn' && call.obj['count'] === 7)).toHaveLength(
      1
    );
    const remaining = await stores.redis.xrange(streamKey, '-', '+');
    await stores.redis.set(`${prefix}pg`, remaining[4]![0]);
    await stores.redis.set(`${prefix}delivery`, remaining[4]![0]);
    await trimOutboundEvents(stores.redis, {
      streamKey,
      postgresOffsetKey: `${prefix}pg`,
      eventKeysKey,
      maxLength: 5,
      maxAgeMs: 60_000,
    });
    expect(await stores.redis.xlen(streamKey)).toBe(0);
    expect(await stores.redis.hlen(eventKeysKey)).toBe(0);
    expect(ids.length).toBe(12);
  });
});

describe('outbound Postgres apply restart cuts', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('leaves the cursor unchanged after a real insert failure and retries after restart', async () => {
    const prefix = `outbound-insert-fail:${stores.workerId}:`;
    const stream = `${prefix}events`,
      offset = `${prefix}pg`;
    const eventId = `insert-fail-${stores.workerId}-${Date.now()}`;
    const id = await stores.redis.xadd(
      stream,
      '*',
      'eventId',
      eventId,
      'event',
      JSON.stringify({
        eventId,
        type: 'send.command',
        payload: {
          recipientId: eventId,
          channel: 'test',
          destination: eventId,
          text: 'retry insert',
        },
      })
    );
    if (!id) throw new Error('Valkey returned no stream id');
    const functionName = `core.fail_outbound_${stores.workerId}`;
    const triggerName = `fail_outbound_${stores.workerId}`;
    await stores.postgres.query(
      `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected Postgres insert failure'; END $$`
    );
    await stores.postgres.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON core.conversation_messages FOR EACH ROW WHEN (NEW.message_id = 'channel:test:${eventId}') EXECUTE FUNCTION ${functionName}()`
    );
    const manager = createConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    try {
      await expect(
        applyCommittedOutboundEvents(stores.redis, manager, offset, stream)
      ).rejects.toThrow('injected Postgres insert failure');
      expect(await stores.redis.get(offset)).toBeNull();
      await stores.postgres.query(`DROP TRIGGER ${triggerName} ON core.conversation_messages`);
      await stores.postgres.query(`DROP FUNCTION ${functionName}()`);
      await applyCommittedOutboundEvents(stores.redis, manager, offset, stream);
      expect(await stores.redis.get(offset)).toBe(id);
      const row = await stores.postgres.query(
        'SELECT message_id FROM core.conversation_messages WHERE message_id = $1',
        [`channel:test:${eventId}`]
      );
      expect(row.rowCount).toBe(1);
    } finally {
      await stores.postgres.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON core.conversation_messages`
      );
      await stores.postgres.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it('replays an inserted natural-key row when cursor advancement fails and fences a stale holder before insert', async () => {
    const prefix = `outbound-cursor-cut:${stores.workerId}:`;
    const stream = `${prefix}events`,
      offset = `${prefix}pg`;
    const eventId = `cursor-cut-${stores.workerId}-${Date.now()}`;
    const id = await stores.redis.xadd(
      stream,
      '*',
      'eventId',
      eventId,
      'event',
      JSON.stringify({
        eventId,
        type: 'send.command',
        payload: {
          recipientId: eventId,
          channel: 'test',
          destination: eventId,
          text: 'cursor cut',
        },
      })
    );
    if (!id) throw new Error('Valkey returned no stream id');
    const manager = createConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    const cursorFailingRedis = new Proxy(stores.redis, {
      get(target, property) {
        if (property === 'set')
          return async (key: string, ...args: unknown[]) => {
            if (key === offset) throw new Error('injected cursor write failure');
            return (target.set as (...values: unknown[]) => Promise<unknown>)(key, ...args);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof stores.redis;
    await expect(
      applyCommittedOutboundEvents(cursorFailingRedis, manager, offset, stream)
    ).rejects.toThrow('injected cursor write failure');
    expect(await stores.redis.get(offset)).toBeNull();
    const restartManager = createConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    await applyCommittedOutboundEvents(stores.redis, restartManager, offset, stream);
    expect(await stores.redis.get(offset)).toBe(id);
    const rows = await stores.postgres.query(
      'SELECT message_id FROM core.conversation_messages WHERE message_id = $1',
      [`channel:test:${eventId}`]
    );
    expect(rows.rowCount).toBe(1);

    await stores.postgres.query(
      `INSERT INTO core.active_holder (id, epoch) VALUES (true, 1) ON CONFLICT (id) DO UPDATE SET epoch = 1`
    );
    const staleManager = createConversationManager(
      new PostgresConversationStore(createFencedPostgres(stores.postgres, 1)),
      createTestLogger()
    );
    const staleEventId = `${eventId}-stale`;
    const staleStream = `${stream}:stale`;
    const staleOffset = `${offset}:stale`;
    await stores.redis.xadd(
      staleStream,
      '*',
      'eventId',
      staleEventId,
      'event',
      JSON.stringify({
        eventId: staleEventId,
        type: 'send.command',
        payload: {
          recipientId: staleEventId,
          channel: 'test',
          destination: staleEventId,
          text: 'stale',
        },
      })
    );
    await stores.postgres.query('UPDATE core.active_holder SET epoch = 2 WHERE id = true');
    await expect(
      applyCommittedOutboundEvents(stores.redis, staleManager, staleOffset, staleStream)
    ).rejects.toBeInstanceOf(StalePostgresEpochError);
    expect(await stores.redis.get(staleOffset)).toBeNull();
    const currentManager = createConversationManager(
      new PostgresConversationStore(createFencedPostgres(stores.postgres, 2)),
      createTestLogger()
    );
    await applyCommittedOutboundEvents(stores.redis, currentManager, staleOffset, staleStream);
    expect(await stores.redis.get(staleOffset)).not.toBeNull();
    const staleRows = await stores.postgres.query(
      'SELECT message_id FROM core.conversation_messages WHERE message_id = $1',
      [`channel:test:${staleEventId}`]
    );
    expect(staleRows.rowCount).toBe(1);
  });
});

describe('outbound retention with delivery consumers', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('trims outbound rows and event keys once Postgres applies them', async () => {
    const prefix = `outbound-consumer-retention:${stores.workerId}:`;
    const streamKey = `${prefix}outbound`;
    const eventKeysKey = `${streamKey}:event-keys`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const events = Array.from({ length: 12 }, (_, i) => ({
      eventId: `consumer-retention-${stores.workerId}-${i}`,
      type: 'send.command',
      payload: {
        recipientId: `consumer-${i}`,
        channel: 'test',
        destination: `consumer-${i}`,
        text: `answer ${i}`,
      },
    }));
    await store.commitOwners(epoch, 1, events);
    const manager = createConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    await applyCommittedOutboundEvents(stores.redis, manager, `${prefix}pg`, streamKey);
    expect(await stores.redis.xlen(streamKey)).toBe(0);
    expect(await stores.redis.hlen(eventKeysKey)).toBe(0);
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
    expect(await stores.redis.get(`${prefix}delivery-offset`)).toBeNull();
    expect(await stores.redis.xrange(`${prefix}outbound`, '-', '+')).toHaveLength(1);
  });

  it('revives signal dates from inbound stream reads and hydrated pending snapshots before aggregation pruning', async () => {
    const key = `inbound-dates:${stores.workerId}`;
    const original = new InboundMessageStream(stores.redis, key);
    const signal = createUserMessageSignal({
      text: 'date replay',
      recipientId: 'date-recipient',
      channel: 'test',
      updateId: 'date-replay',
    });
    await original.append(signal);
    const [read] = await original.readNew();
    expect(read?.signal.timestamp).toBeInstanceOf(Date);
    expect(read?.signal.expiresAt).toBeInstanceOf(Date);
    const restarted = new InboundMessageStream(stores.redis, key);
    restarted.hydrateSnapshot(JSON.parse(JSON.stringify(original.exportSnapshot())));
    const [pending] = await restarted.readNew();
    expect(pending?.signal.timestamp).toBeInstanceOf(Date);
    expect(pending?.signal.expiresAt).toBeInstanceOf(Date);
    const aggregator = new SignalAggregator(createTestLogger());
    aggregator.add(pending!.signal);
    expect(() => aggregator.prune()).not.toThrow();
  });

  it('keeps recipient offsets and the snapshot envelope unchanged until a CAS succeeds', async () => {
    const prefix = `inbound-offset-cas:${stores.workerId}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const epoch = await store.takeEpoch();
    const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    store.register(inbound);
    const signal = createUserMessageSignal({
      text: 'offset',
      recipientId: 'offset-r',
      channel: 'test',
      updateId: 'offset-id',
    });
    await inbound.append(signal);
    await inbound.readNew();
    await store.commitOwners(epoch, 1);
    const key = `${prefix}current`;
    const before = await stores.redis.get(key);
    inbound.settle([signal.id]);
    await store.takeEpoch();
    await expect(store.commitOwners(epoch, 2)).rejects.toThrow(/epoch mismatch/i);
    expect(await stores.redis.get(key)).toBe(before);
    const restarted = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    restarted.hydrateSnapshot((await store.read())?.sections['inbound'] as never);
    expect((await restarted.readNew()).map((entry) => entry.messageId)).toEqual(['offset-id']);
  });

  it('deduplicates committed message ids on a new stream entry and evicts only beyond the bounded ring', async () => {
    const key = `inbound-ring:${stores.workerId}`;
    const inbound = new InboundMessageStream(stores.redis, key, 2);
    const pushAndSettle = async (id: string) => {
      await inbound.append(
        createUserMessageSignal({ text: id, recipientId: 'ring-r', channel: 'test', updateId: id })
      );
      const entries = await inbound.readNew();
      inbound.settle(entries.map((entry) => entry.signal.id));
    };
    await pushAndSettle('ring-a');
    const restarted = new InboundMessageStream(stores.redis, key, 2);
    restarted.hydrateSnapshot(inbound.exportSnapshot());
    await restarted.append(
      createUserMessageSignal({
        text: 'redelivery',
        recipientId: 'ring-r',
        channel: 'test',
        updateId: 'ring-a',
      })
    );
    expect(await restarted.readNew()).toEqual([]);
    await pushAndSettle('ring-b');
    await pushAndSettle('ring-c');
    expect(inbound.exportSnapshot().recentMessageIds).toEqual(['ring-b', 'ring-c']);
    await inbound.append(
      createUserMessageSignal({
        text: 'evicted',
        recipientId: 'ring-r',
        channel: 'test',
        updateId: 'ring-a',
      })
    );
    expect((await inbound.readNew()).map((entry) => entry.messageId)).toEqual(['ring-a']);
  });

  it('leaves a twice-failed input pending without blocking later input for its recipient', async () => {
    const key = `inbound-error-retry:${stores.workerId}`;
    const first = new InboundMessageStream(stores.redis, key);
    const stuck = createUserMessageSignal({
      text: 'stuck',
      recipientId: 'same-recipient',
      channel: 'test',
      updateId: 'stuck-id',
    });
    await first.append(stuck);
    expect((await first.readNew()).map((entry) => entry.messageId)).toEqual(['stuck-id']);
    expect(first.markFailedTurn([stuck.id])).toEqual([]);
    const afterOne = new InboundMessageStream(stores.redis, key);
    afterOne.hydrateSnapshot(first.exportSnapshot());
    expect((await afterOne.readNew()).map((entry) => entry.messageId)).toEqual(['stuck-id']);
    expect(afterOne.markFailedTurn([stuck.id])).toEqual([stuck.id]);
    const afterTwo = new InboundMessageStream(stores.redis, key);
    afterTwo.hydrateSnapshot(afterOne.exportSnapshot());
    expect(await afterTwo.readNew()).toEqual([]);
    await afterTwo.append(
      createUserMessageSignal({
        text: 'later',
        recipientId: 'same-recipient',
        channel: 'test',
        updateId: 'later-id',
      })
    );
    expect((await afterTwo.readNew()).map((entry) => entry.messageId)).toEqual(['later-id']);
    expect(afterTwo.exportSnapshot().pending.map((entry) => entry.messageId)).toEqual([
      'stuck-id',
      'later-id',
    ]);
  });
});
