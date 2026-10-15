import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { ConversationManager } from '../../src/storage/conversation-manager.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import {
  startInstance,
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
