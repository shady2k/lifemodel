import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore, StaleSnapshotEpochError } from '../../src/storage/snapshot-store.js';
import { startInstance, waitFor } from '../helpers/core-loop-drain-harness.js';
import { createStateManager } from '../../src/storage/state-manager.js';
import { PersistentAckRegistry } from '../../src/layers/aggregation/persistent-ack-registry.js';
import type { PersistedAckRegistryState } from '../../src/layers/aggregation/ack-registry.js';
import { createNewUserWithModel } from '../../src/models/user-model.js';
import { createTestLogger } from '../helpers/test-logger.js';
import type { PersistableState } from '../../src/storage/persistable-state.js';

describe('tick snapshot store', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('commits all state sections once per tick and a restarted core hydrates them', async () => {
    const store = createSnapshotStore(stores.redis, {
      keyPrefix: `tick-state:${stores.workerId}:`,
    });
    const epoch = await store.takeEpoch();
    const logger = createTestLogger('error');
    const stateManager = createStateManager(null as never, logger);
    const ackRegistry = new PersistentAckRegistry(logger);
    await ackRegistry.load();
    ackRegistry.registerAck({
      signalType: 'thought',
      ackType: 'suppressed',
      reason: 'snapshot test',
    });
    const userModel = createNewUserWithModel('user-1', 'Owner', logger);
    let tickBeingCommitted = 0;
    store.register({
      section: 'agentState',
      exportSnapshot: () => stateManager.exportSnapshot(),
      hydrateSnapshot: () => undefined,
    });
    store.register({
      section: 'ackRegistry',
      exportSnapshot: () => ackRegistry.exportSnapshot(),
      hydrateSnapshot: () => undefined,
    });
    store.register({
      section: 'tickCounter',
      exportSnapshot: () => tickBeingCommitted,
      hydrateSnapshot: () => undefined,
    });
    const committed: NonNullable<Awaited<ReturnType<typeof store.read>>>[] = [];
    const core = await startInstance('/tmp/lifemodel-snapshot-e2e', {
      tickIntervalMs: 10,
      commitSnapshot: async (tick) => {
        tickBeingCommitted = tick;
        await store.commitOwners(epoch, tick);
        const snapshot = await store.read();
        if (snapshot) committed.push(snapshot);
      },
      onStaleSnapshot: () => undefined,
    });
    stateManager.registerComponents({ agent: core.agent, userModel });
    await waitFor(() => committed.length >= 3, 'three tick snapshots committed');
    await core.coreLoop.stop();

    const snapshot = committed.at(-1)!;
    expect(committed.map(({ tick }) => tick)).toEqual([1, 2, 3]);
    expect(snapshot.sections['tickCounter']).toBe(snapshot.tick);
    const savedState = snapshot.sections['agentState'] as PersistableState;
    expect(savedState).toMatchObject({
      version: expect.any(Number),
      savedAt: expect.any(String),
      agent: {
        state: expect.objectContaining({
          energy: expect.any(Number),
          lastTickAt: expect.any(String),
        }),
        sleepState: expect.objectContaining({ mode: expect.any(String) }),
      },
      user: expect.objectContaining({ id: 'user-1', name: 'Owner' }),
      rules: [],
      neuronWeights: expect.objectContaining({
        contactPressure: expect.any(Object),
        alertness: expect.any(Object),
      }),
    });
    expect(snapshot.sections['ackRegistry']).toMatchObject({
      version: expect.any(Number),
      acks: expect.arrayContaining([expect.objectContaining({ reason: 'snapshot test' })]),
      handledSignalIds: expect.any(Array),
      lastProactiveContact: null,
      savedAt: expect.any(String),
    });

    const restoredAckRegistry = new PersistentAckRegistry(logger);
    await restoredAckRegistry.load(snapshot.sections['ackRegistry'] as PersistedAckRegistryState);
    expect(restoredAckRegistry.exportSnapshot().acks).toEqual(
      (snapshot.sections['ackRegistry'] as PersistedAckRegistryState).acks
    );
    const restoredManager = createStateManager(null as never, logger);
    restoredManager.setSnapshotState(savedState);
    const restored = await restoredManager.load();
    expect(restored).not.toBeNull();
    const restarted = await startInstance('/tmp/lifemodel-snapshot-restart', {
      initialTickCount: snapshot.tick,
      initialState: restored!.agent.state,
      initialSleepState: restored!.agent.sleepState,
      tickIntervalMs: 10_000,
    });
    expect(restarted.coreLoop.getTickCount()).toBe(snapshot.tick);
    expect(restarted.agent.getState()).toEqual(restored!.agent.state);
    expect(restarted.agent.getSleepState()).toEqual(restored!.agent.sleepState);
    await restarted.coreLoop.stop();
  });

  it('fences and stops a core after another core takes the epoch without changing the snapshot', async () => {
    const store = createSnapshotStore(stores.redis, {
      keyPrefix: `stale-core:${stores.workerId}:`,
    });
    const firstEpoch = await store.takeEpoch();
    let firstCommitted: Awaited<ReturnType<typeof store.read>> | undefined;
    const commits: {
      version: number;
      epoch: number;
      tick: number;
      sections: Record<string, unknown>;
    }[] = [];
    let staleError: StaleSnapshotEpochError | null = null;
    let allowStaleAttempt!: () => void;
    const staleAttemptGate = new Promise<void>((resolve) => {
      allowStaleAttempt = resolve;
    });
    let firstCommitDone = false;
    const first = await startInstance('/tmp/lifemodel-stale-core', {
      tickIntervalMs: 10,
      commitSnapshot: async (tick) => {
        if (firstCommitDone) await staleAttemptGate;
        const envelope = {
          version: 1,
          epoch: firstEpoch,
          tick,
          sections: { agentState: { state: { energy: 0.5 } }, ackRegistry: {}, tickCounter: tick },
        };
        if (!(await store.commit(firstEpoch, envelope))) {
          throw new StaleSnapshotEpochError(firstEpoch, await store.currentEpoch());
        }
        commits.push(envelope);
        firstCommitted = await store.read();
        firstCommitDone = true;
      },
      onStaleSnapshot: (error) => {
        staleError = error;
      },
    });
    await waitFor(() => commits.length > 0, 'first core snapshot committed');
    const bytesBeforeStaleAttempt = await stores.redis.get(`stale-core:${stores.workerId}:current`);
    const secondEpoch = await store.takeEpoch();
    expect(secondEpoch).toBe(firstEpoch + 1);
    const second = await startInstance('/tmp/lifemodel-second-core', {
      initialTickCount: firstCommitted!.tick,
      tickIntervalMs: 10_000,
    });
    expect(second.coreLoop.stopReport().loopStopped).toBe(false);
    allowStaleAttempt();
    await waitFor(() => staleError !== null, 'stale core stopped');
    await waitFor(() => !first.coreLoop.stopReport().tickInFlight, 'stale tick settled');
    expect(staleError).toMatchObject({ committerEpoch: firstEpoch, storedEpoch: secondEpoch });
    expect(first.coreLoop.stopReport().loopStopped).toBe(true);
    expect(await stores.redis.get(`stale-core:${stores.workerId}:current`)).toBe(
      bytesBeforeStaleAttempt
    );
    expect(await store.read()).toEqual(firstCommitted);
    await first.coreLoop.stop();
    await second.coreLoop.stop();
  });

  it('takes a new epoch, commits only for that epoch, and refuses newer formats', async () => {
    const store = createSnapshotStore(stores.redis, { keyPrefix: `snapshot:${stores.workerId}:` });
    const epoch = await store.takeEpoch();
    const initial = await store.read();
    expect(initial).toBeNull();
    const envelope = {
      version: 1,
      epoch,
      tick: 1,
      sections: { state: { energy: 0.3 }, later: true },
    };
    expect(await store.commit(epoch, envelope)).toBe(true);
    const before = await stores.redis.get(`snapshot:${stores.workerId}:current`);
    expect(await store.read()).toEqual(envelope);
    const newer = { ...envelope, version: 2 };
    await stores.redis.set(`snapshot:${stores.workerId}:current`, JSON.stringify(newer));
    await expect(store.read()).rejects.toThrow(/version 2/);
    expect(await store.commit(epoch - 1, { ...envelope, epoch: epoch - 1 })).toBe(false);
    expect(await stores.redis.get(`snapshot:${stores.workerId}:current`)).toBe(
      JSON.stringify(newer)
    );
    expect(before).not.toBeNull();
  });
});
