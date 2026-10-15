import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import {
  applyCommittedOutboundEvents,
  InboundMessageStream,
} from '../../src/core/message-streams.js';
import { ConversationManager } from '../../src/storage/conversation-manager.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { createTestLogger } from '../helpers/test-logger.js';
import {
  PersistentRecipientRegistry,
  RecipientRegistry,
} from '../../src/core/recipient-registry.js';
import { getPrimaryRecipientId, setPrimaryRecipientId } from '../../src/core/globals.js';
import { startCoreHealthServer } from '../../src/core/health-server.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import {
  startInstance,
  thoughtSignal,
  makeScratchDir,
  rmDir,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';
import type { ConversationManager as ConversationManagerType } from '../../src/storage/conversation-manager.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForAsync(condition: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('inbound user history restart durability', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('creates the web owner when the core loop receives a cold registry', async () => {
    const registry = new RecipientRegistry();
    const path = await makeScratchDir('web-recipient-cold-');
    const instance = await startInstance(path, { recipientRegistry: registry });
    try {
      const ownerId = registry.lookup('web', 'owner');
      expect(ownerId).toBeDefined();
      expect(getPrimaryRecipientId()).toBe(ownerId);
      expect(instance.aggregation.primaryRecipientId).toBe(ownerId);
      expect(registry.lookup('test', 'chat-42')).toBe(instance.recipientId);
    } finally {
      await instance.coreLoop.stop();
      await rmDir(path);
      setPrimaryRecipientId(undefined);
    }
  });

  it('records proactive contact in the durable web transcript and reuses it after restart', async () => {
    const registry = new PersistentRecipientRegistry(stores.postgres, createTestLogger());
    await registry.init();
    const recipientId = registry.getOrCreate('web', 'owner');
    await registry.flush();
    const path = await makeScratchDir('web-recipient-');
    const conversation = new ConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    const prefix = `web-primary:${stores.workerId}:${Date.now()}:`;
    const committed = deferred<void>();
    let transcript: Awaited<ReturnType<typeof conversation.getFullHistory>>;
    const first = await startInstance(path, {
      tickIntervalMs: 10,
      recipientRegistry: registry,
      conversationManager: conversation,
      initialCognitionResult: {
        confidence: 1,
        intents: [
          {
            type: 'SEND_MESSAGE',
            payload: { recipientId, text: 'I wanted to tell you something.' },
          },
        ],
        response: undefined,
      },
      commitSnapshot: async (_tick, events) => {
        for (const event of events) {
          await stores.redis.xadd(
            `${prefix}outbound`,
            '*',
            'eventId',
            event.eventId,
            'event',
            JSON.stringify(event)
          );
        }
        if (events.length > 0) committed.resolve();
      },
    });
    try {
      expect(getPrimaryRecipientId()).toBe(recipientId);
      expect(first.aggregation.primaryRecipientId).toBe(recipientId);
      await first.coreLoop.pushInboundSignal(thoughtSignal('proactive contact'));
      await committed.promise;
      await applyCommittedOutboundEvents(
        stores.redis,
        conversation,
        `${prefix}pg-applied`,
        `${prefix}outbound`
      );
      transcript = await conversation.getFullHistory(recipientId);
      expect(transcript.map((row) => ({ role: row.role, content: row.content }))).toEqual([
        { role: 'assistant', content: 'I wanted to tell you something.' },
      ]);
      expect(
        await stores.postgres.query(
          "SELECT 1 FROM core.conversation_messages WHERE recipient_id = $1 AND payload->>'role' = $2",
          [recipientId, 'user']
        )
      ).toMatchObject({ rowCount: 0 });
    } finally {
      await first.coreLoop.stop();
      await rmDir(path);
      setPrimaryRecipientId(undefined);
    }

    const restartedRegistry = new PersistentRecipientRegistry(stores.postgres, createTestLogger());
    await restartedRegistry.init();
    expect(restartedRegistry.lookup('web', 'owner')).toBe(recipientId);
    const restartPath = await makeScratchDir('web-recipient-restart-');
    const restarted = await startInstance(restartPath, {
      tickIntervalMs: 10,
      recipientRegistry: restartedRegistry,
      conversationManager: conversation,
    });
    try {
      expect(getPrimaryRecipientId()).toBe(recipientId);
      expect(await conversation.getFullHistory(recipientId)).toEqual(transcript);
    } finally {
      await restarted.coreLoop.stop();
      await rmDir(restartPath);
      setPrimaryRecipientId(undefined);
    }
  });

  it('stops unhealthy when normalization rejects and replays every drained input', async () => {
    const manager = new ConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    let historyAttempts = 0;
    const failOnceManager = {
      addMessage: async (...args: Parameters<ConversationManagerType['addMessage']>) => {
        historyAttempts++;
        if (historyAttempts === 1) throw new Error('simulated transient Postgres failure');
        return manager.addMessage(...args);
      },
    } as ConversationManagerType;
    const prefix = `history-reject:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(inbound);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const first = createUserMessageSignal({
      text: 'first rejected message',
      recipientId: 'history-reject-recipient',
      channel: 'test',
      updateId: 'reject-1',
    });
    const second = createUserMessageSignal({
      text: 'second drained message',
      recipientId: 'history-reject-recipient',
      channel: 'test',
      updateId: 'reject-2',
    });
    let commits = 0;
    const fatalErrors: Error[] = [];
    const failedPath = await makeScratchDir('history-reject-');
    const failed = await startInstance(failedPath, {
      tickIntervalMs: 10,
      busSignalStream: bus,
      inboundStream: inbound,
      conversationManager: failOnceManager,
      onFatalError: (error) => fatalErrors.push(error),
      commitSnapshot: async (tick, outbox) => {
        commits++;
        await store.commitOwners(epoch, tick, outbox);
      },
    });
    const healthServer = await startCoreHealthServer(failed.coreLoop, 0);
    const address = healthServer.address();
    if (!address || typeof address === 'string')
      throw new Error('health server has no TCP address');
    let commitsAtFailure: number;
    let savedSnapshot: Awaited<ReturnType<typeof store.read>>;
    try {
      await waitFor(() => failed.coreLoop.getLastCommitAt() > 0, 'initial snapshot commit');
      expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(200);
      await inbound.append(first);
      await inbound.append(second);
      await waitFor(() => !failed.coreLoop.isRunning(), 'normalization failure stops core');
      await waitFor(() => fatalErrors.length === 1, 'fatal error invokes process failure callback');
      commitsAtFailure = commits;
      expect(fatalErrors[0]?.message).toContain('Signal normalization failed');
      expect(commitsAtFailure).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(503);
      expect(historyAttempts).toBe(1);
      savedSnapshot = await store.read();
      expect(savedSnapshot).not.toBeNull();
      expect((savedSnapshot?.sections.inbound as { pending: unknown[] }).pending).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        healthServer.close((error) => (error ? reject(error) : resolve()))
      );
      await failed.coreLoop.stop();
      await rmDir(failedPath);
    }

    const replayStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const replayInbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    const replayBus = createBusSignalStream(stores.redis, prefix);
    replayStore.register(replayInbound);
    replayStore.register(replayBus);
    if (!savedSnapshot) throw new Error('initial snapshot was not saved');
    await replayStore.hydrate(savedSnapshot);
    const replayEpoch = await replayStore.takeEpoch();
    const replayPath = await makeScratchDir('history-reject-replay-');
    const committedOutbox: { payload: Record<string, unknown> }[] = [];
    const replay = await startInstance(replayPath, {
      tickIntervalMs: 10,
      busSignalStream: replayBus,
      inboundStream: replayInbound,
      conversationManager: failOnceManager,
      initialCognitionResult: {
        confidence: 1,
        intents: [
          {
            type: 'SEND_MESSAGE',
            payload: { recipientId: 'history-reject-recipient', text: 'one replayed answer' },
          },
        ],
        response: undefined,
      },
      commitSnapshot: async (tick, outbox) => {
        committedOutbox.push(...outbox);
        await replayStore.commitOwners(replayEpoch, tick, outbox);
      },
    });
    try {
      await waitForAsync(async () => {
        const snapshot = await replayStore.read();
        const pending = (snapshot?.sections.inbound as { pending?: unknown[] } | undefined)
          ?.pending;
        return (
          historyAttempts === 3 && replay.cognition.calls.length === 1 && pending?.length === 0
        );
      }, 'all drained inputs replay and commit');
      expect(historyAttempts).toBe(3);
      for (const signal of [first, second]) {
        const rows = await stores.postgres.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM core.conversation_messages WHERE recipient_id = $1 AND message_id = $2',
          ['history-reject-recipient', `inbound:${signal.id}`]
        );
        expect(rows.rows[0]?.count).toBe('1');
      }
      expect(replay.cognition.calls).toHaveLength(1);
      expect(replay.cognition.triggerIds()).toEqual([first.id, second.id]);
      expect(
        committedOutbox.filter((event) => event.payload['text'] === 'one replayed answer')
      ).toHaveLength(1);
    } finally {
      await replay.coreLoop.stop();
      await rmDir(replayPath);
    }
    expect(commits).toBe(commitsAtFailure!);
  });

  it('awaits a held history write before snapshot commit and deduplicates a written row on replay', async () => {
    const manager = new ConversationManager(
      new PostgresConversationStore(stores.postgres),
      createTestLogger()
    );
    const gate = deferred<void>();
    const started = deferred<void>();
    const heldManager = {
      addMessage: async (...args: Parameters<ConversationManagerType['addMessage']>) => {
        started.resolve();
        await gate.promise;
        return manager.addMessage(...args);
      },
    } as ConversationManagerType;

    const prefix = `history-held:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const inbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(inbound);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('history-held-');
    const instance = await startInstance(path, {
      tickIntervalMs: 10,
      busSignalStream: bus,
      inboundStream: inbound,
      conversationManager: heldManager,
      commitSnapshot: async (tick, outbox) => store.commitOwners(epoch, tick, outbox),
    });
    (instance.cognition as { result: unknown }).result = {
      confidence: 1,
      intents: [
        {
          type: 'SEND_MESSAGE',
          payload: { recipientId: instance.recipientId, text: 'recorded answer' },
        },
      ],
      response: undefined,
    };
    const signal = createUserMessageSignal({
      text: 'history once',
      recipientId: instance.recipientId,
      channel: 'test',
      updateId: 'history-held',
    });
    try {
      await inbound.append(signal);
      await started.promise;
      expect(await store.read()).toBeNull();
      gate.resolve();
      await waitForAsync(async () => {
        const snapshot = await store.read();
        const pending = (snapshot?.sections.inbound as { pending?: unknown[] } | undefined)
          ?.pending;
        return pending?.length === 0;
      }, 'the write and input outcome commit');
      await instance.coreLoop.stop();
      const rowId = `inbound:${signal.id}`;
      const rows = await stores.postgres.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM core.conversation_messages WHERE recipient_id = $1 AND message_id = $2',
        [instance.recipientId, rowId]
      );
      expect(rows.rows[0]?.count).toBe('1');

      const saved = await store.read();
      const restartStore = createSnapshotStore(stores.redis, { keyPrefix: prefix });
      const restartInbound = new InboundMessageStream(stores.redis, `${prefix}inbound`);
      const restartBus = createBusSignalStream(stores.redis, prefix);
      restartStore.register(restartInbound);
      restartStore.register(restartBus);
      await restartStore.hydrate(saved);
      const restartEpoch = await restartStore.takeEpoch();
      const restartPath = await makeScratchDir('history-held-restart-');
      const restarted = await startInstance(restartPath, {
        tickIntervalMs: 10,
        busSignalStream: restartBus,
        inboundStream: restartInbound,
        conversationManager: manager,
        commitSnapshot: async (tick, outbox) =>
          restartStore.commitOwners(restartEpoch, tick, outbox),
      });
      try {
        await waitFor(() => restarted.coreLoop.getLastCommitAt() > 0, 'restart snapshot commit');
        const afterRestart = await stores.postgres.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM core.conversation_messages WHERE recipient_id = $1 AND message_id = $2',
          [instance.recipientId, rowId]
        );
        expect(afterRestart.rows[0]?.count).toBe('1');
      } finally {
        await restarted.coreLoop.stop();
        await rmDir(restartPath);
      }
    } finally {
      gate.resolve();
      await instance.coreLoop.stop();
      await rmDir(path);
    }

    const replayPrefix = `history-replay:${stores.workerId}:${Date.now()}:`;
    const replayStore = createSnapshotStore(stores.redis, { keyPrefix: replayPrefix });
    const replayInbound = new InboundMessageStream(stores.redis, `${replayPrefix}inbound`);
    const replayBus = createBusSignalStream(stores.redis, replayPrefix);
    replayStore.register(replayInbound);
    replayStore.register(replayBus);
    const replayEpoch = await replayStore.takeEpoch();
    const replayPath = await makeScratchDir('history-replay-');
    let failFirstCommit = true;
    const replaySignal = createUserMessageSignal({
      text: 'crash after history write',
      recipientId: 'stable-history-recipient',
      channel: 'test',
      updateId: 'history-replay',
    });
    await replayInbound.append(replaySignal);
    const replayGate = deferred<void>();
    const replayWriteStarted = deferred<void>();
    const replayHeldManager = {
      addMessage: async (...args: Parameters<ConversationManagerType['addMessage']>) => {
        replayWriteStarted.resolve();
        await replayGate.promise;
        return manager.addMessage(...args);
      },
    } as ConversationManagerType;
    const failing = await startInstance(replayPath, {
      tickIntervalMs: 10,
      busSignalStream: replayBus,
      inboundStream: replayInbound,
      conversationManager: replayHeldManager,
      commitSnapshot: async (tick, outbox) => {
        if (failFirstCommit) {
          failFirstCommit = false;
          throw new Error('simulated crash after history write');
        }
        await replayStore.commitOwners(replayEpoch, tick, outbox);
      },
    });
    (failing.cognition as { result: unknown }).result = {
      confidence: 1,
      intents: [
        {
          type: 'SEND_MESSAGE',
          payload: { recipientId: 'stable-history-recipient', text: 'answer' },
        },
      ],
      response: undefined,
    };
    try {
      await replayWriteStarted.promise;
      replayGate.resolve();
      await waitFor(() => !failing.coreLoop.isRunning(), 'first snapshot attempt fails');
      await failing.coreLoop.stop();
      const restartInbound = new InboundMessageStream(stores.redis, `${replayPrefix}inbound`);
      const restartBus = createBusSignalStream(stores.redis, replayPrefix);
      const restartStore = createSnapshotStore(stores.redis, { keyPrefix: replayPrefix });
      restartStore.register(restartInbound);
      restartStore.register(restartBus);
      const restartEpoch = await restartStore.takeEpoch();
      const restartPath = await makeScratchDir('history-replay-restart-');
      const replay = await startInstance(restartPath, {
        tickIntervalMs: 10,
        busSignalStream: restartBus,
        inboundStream: restartInbound,
        conversationManager: manager,
        commitSnapshot: async (tick, outbox) =>
          restartStore.commitOwners(restartEpoch, tick, outbox),
      });
      (replay.cognition as { result: unknown }).result = {
        confidence: 1,
        intents: [
          {
            type: 'SEND_MESSAGE',
            payload: { recipientId: 'stable-history-recipient', text: 'answer' },
          },
        ],
        response: undefined,
      };
      try {
        await waitForAsync(async () => {
          const snapshot = await restartStore.read();
          const pending = (snapshot?.sections.inbound as { pending?: unknown[] } | undefined)
            ?.pending;
          return pending?.length === 0;
        }, 'replayed input commits');
        const rows = await stores.postgres.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM core.conversation_messages WHERE recipient_id = $1 AND message_id = $2',
          ['stable-history-recipient', `inbound:${replaySignal.id}`]
        );
        expect(rows.rows[0]?.count).toBe('1');
      } finally {
        await replay.coreLoop.stop();
        await rmDir(restartPath);
      }
    } finally {
      replayGate.resolve();
      await failing.coreLoop.stop();
      await rmDir(replayPath);
    }
  });
});
