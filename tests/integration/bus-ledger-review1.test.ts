import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { RecipientRegistry } from '../../src/core/recipient-registry.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { SchedulerPrimitiveImpl } from '../../src/core/scheduler-primitive.js';
import { StoragePrimitiveImpl } from '../../src/core/storage-primitive.js';
import { createSchedulerService } from '../../src/core/scheduler-service.js';
import type { Storage } from '../../src/storage/storage.js';
import { createSignal, createUserMessageSignal, type Signal } from '../../src/types/signal.js';
import { createTestLogger } from '../helpers/test-logger.js';
import {
  makeScratchDir,
  rmDir,
  startInstance,
  thoughtSignal,
  waitFor as waitCondition,
} from '../helpers/core-loop-drain-harness.js';
const waitFor = (fn: () => boolean, label: string) => waitCondition(fn, label, 1500);
const quiet = { confidence: 1, disposition: 'no_reply' as const, intents: [] };
const failureWarning =
  'Internal signals failed twice and were completed with their recorded failure';

describe('bus ledger review round 1', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });
  async function setup(name: string) {
    const prefix = `bus-round1:${name}:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('bus-round1-');
    let saved = bus.exportSnapshot();
    const start = (
      commit = async (tick: number) => {
        await store.commitOwners(epoch, tick);
      }
    ) =>
      startInstance(path, {
        cognitionMode: 'hang',
        recordLogs: true,
        busSignalStream: bus,
        commitSnapshot: async (tick, events) => {
          if (events.length) await store.commitOwners(epoch, tick, events);
          else await commit(tick);
          saved = bus.exportSnapshot();
        },
      });
    return { prefix, store, bus, epoch, path, start, saved: () => saved };
  }

  it('replays a scheduler-fired reminder after a restart longer than its TTL', async () => {
    const t = await setup('reminder');
    const logger = createTestLogger();
    const values = new Map<string, unknown>();
    const storage = {
      load: async (k: string) => values.get(k) ?? null,
      save: async (k: string, v: unknown) => {
        values.set(k, structuredClone(v));
      },
      delete: async (k: string) => {
        values.delete(k);
      },
    } as unknown as Storage;
    const primitive = new SchedulerPrimitiveImpl(
      'reminder',
      new StoragePrimitiveImpl(storage, 'reminder', logger),
      logger
    );
    await primitive.schedule({
      fireAt: new Date(0),
      data: { kind: 'reminder:due', text: 'private reminder' },
    });
    const scheduler = createSchedulerService(logger);
    scheduler.registerScheduler('reminder', primitive);
    const emitted: Signal[] = [];
    scheduler.setSignalCallback((s) => emitted.push(s));
    const firedAt = Date.now() - 120_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(firedAt);
    try {
      await scheduler.tick();
    } finally {
      vi.useRealTimers();
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.expiresAt!.getTime()).toBeLessThan(Date.now());
    expect(primitive.getSchedules()).toHaveLength(0);
    const id = await t.bus.append(emitted[0]!);
    await t.store.commitOwners(t.epoch, 0);
    await t.store.hydrate(await t.store.read());
    const h = await t.start();
    try {
      await waitFor(() => h.cognition.calls.length === 1, 'expired durable reminder runs');
      h.cognition.settleAll(quiet);
      await waitFor(() => t.saved().watermark === id, 'reminder outcome committed');
      expect(h.cognition.triggerIds()).toEqual([emitted[0]!.id]);
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });

  it('runs an expired same-core retry instead of discarding it', async () => {
    const t = await setup('retry');
    const h = await t.start();
    try {
      const signal = thoughtSignal('retry expires', h.recipientId);
      const id = await t.bus.append(signal);
      await waitFor(() => h.cognition.calls.length === 1, 'first turn');
      h.cognition.calls[0]!.context.triggerSignals[0]!.expiresAt = new Date(0);
      h.cognition.rejectAll();
      await waitFor(() => h.cognition.calls.length === 2, 'expired retry runs');
      h.cognition.settleAll(quiet);
      await waitFor(() => t.saved().watermark === id, 'retry committed');
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });

  it.each(['tools-only', 'other-recipient-send'] as const)(
    'completes a quiet proactive %s turn once',
    async (mode) => {
      const t = await setup(mode);
      const signal = createSignal('plugin_event', 'plugin.scheduler', { value: 1 });
      const id = await t.bus.append(signal);
      const h = await t.start();
      try {
        await waitFor(() => h.cognition.calls.length === 1, 'quiet turn');
        h.cognition.settleAll({
          confidence: 1,
          disposition: 'respond',
          intents:
            mode === 'tools-only'
              ? [{ type: 'UPDATE_STATE', payload: { key: 'curiosity', value: 0.1, delta: true } }]
              : [
                  {
                    type: 'SEND_MESSAGE',
                    payload: { recipientId: h.recipientId, text: 'Other recipient' },
                  },
                ],
        });
        await waitFor(() => t.saved().watermark === id, 'quiet outcome committed');
        expect(h.cognition.calls).toHaveLength(1);
      } finally {
        h.coreLoop.haltForTest();
        await rmDir(t.path);
      }
    }
  );

  it('never trims through an in-memory watermark before its CAS', async () => {
    const t = await setup('trim');
    const signals = Array.from({ length: 3 }, (_, i) => thoughtSignal(`durable ${i}`));
    const ids = [];
    for (const signal of signals) ids.push(await t.bus.append(signal));
    for (const id of ids) t.bus.ensureOwned(id, 'persisted-turn');
    await t.store.commitOwners(t.epoch, 0);
    const persisted = await t.store.read();
    const h = await t.start();
    try {
      await waitFor(() => h.cognition.calls.length === 1, 'turn owns inputs');
      // Settlement can run between ticks; simulate its in-memory progress,
      // then fail the next CAS exactly as a crash before commit would.
      t.bus.markCompleted(ids.slice(0, 2));
      const commitFault = vi
        .spyOn(t.store, 'commitOwners')
        .mockRejectedValue(new Error('crash before CAS'));
      try {
        await waitFor(() => !h.coreLoop.isRunning(), 'failed CAS stops core');
        const rows = await stores.redis.xrange(`${t.prefix}bus`, '-', '+');
        expect(rows.map(([id]) => id)).toEqual(ids);
        await t.store.hydrate(persisted);
        expect((await t.bus.readAfter(t.bus.committedOffset(), 10)).map((e) => e.id)).toEqual(ids);
      } finally {
        commitFault.mockRestore();
      }
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });

  it('trims only the watermark captured by CAS when settlement advances during the commit', async () => {
    const t = await setup('inflight-trim');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await t.bus.append(thoughtSignal(`inflight ${i}`)));
    for (const id of ids) t.bus.ensureOwned(id, 'persisted-turn');
    await t.store.commitOwners(t.epoch, 0);
    const realCommit = t.store.commitOwners.bind(t.store);
    let advanced = false;
    const commitWindow = vi.spyOn(t.store, 'commitOwners').mockImplementation(async (...args) => {
      if (advanced) throw new Error('crash after previous CAS');
      const result = await realCommit(...args);
      // These completions are not in the envelope that just committed.
      t.bus.markCompleted(ids.slice(0, 2));
      advanced = true;
      return result;
    });
    const h = await t.start();
    try {
      await waitFor(() => !h.coreLoop.isRunning(), 'next CAS fails');
      expect((await stores.redis.xrange(`${t.prefix}bus`, '-', '+')).map(([id]) => id)).toEqual(
        ids
      );
    } finally {
      commitWindow.mockRestore();
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });

  it.each(['before-head', 'hole', 'empty'] as const)(
    'recovers a persisted missing stream row (%s) with a warning',
    async (mode) => {
      const t = await setup(mode);
      const signals = Array.from({ length: 3 }, (_, i) => thoughtSignal(`missing ${i}`));
      const ids = [];
      for (const signal of signals) ids.push(await t.bus.append(signal));
      for (const id of ids) t.bus.ensureOwned(id, 'old-turn');
      t.bus.markFailed(ids);
      await t.store.commitOwners(t.epoch, 0);
      const missing = mode === 'empty' ? ids : [ids[mode === 'hole' ? 1 : 0]!];
      await stores.redis.xdel(`${t.prefix}bus`, ...missing);
      await t.store.hydrate(await t.store.read());
      const h = await t.start();
      try {
        let handled = 0;
        await waitFor(() => {
          if (h.cognition.calls.length > handled) {
            handled = h.cognition.calls.length;
            h.cognition.settleAll(quiet);
          }
          return t.saved().watermark === ids.at(-1);
        }, 'orphan ledger entries completed');
        expect(h.cognition.triggerIds()).toEqual(
          signals.filter((_, i) => !missing.includes(ids[i]!)).map((s) => s.id)
        );
        expect(
          h.recordedLogs.filter(
            (l) =>
              l.msg === 'Internal bus ledger entry has no stream row; completed with recorded loss'
          )
        ).toHaveLength(missing.length);
      } finally {
        h.coreLoop.haltForTest();
        await rmDir(t.path);
      }
    }
  );

  it.each(['fresh', 'restored', 'answered'] as const)(
    'preserves pending inbound for %s proactive settlement and logs safe exhaustion details',
    async (mode) => {
      const t = await setup(`warning-${mode}`);
      const inbound = new InboundMessageStream(stores.redis, `${t.prefix}inbound`);
      t.store.register(inbound);
      const registry = new RecipientRegistry();
      const owner = registry.getOrCreate('web', 'owner');
      const user = createUserMessageSignal({
        recipientId: owner,
        channel: 'web',
        updateId: 'pending-owner',
        text: 'private owner text',
      });
      await inbound.append(user);
      await inbound.readNew();
      const before = inbound.exportSnapshot();
      const readGate = vi.spyOn(inbound, 'readNew').mockResolvedValue([]);
      const signal = createSignal(
        'plugin_event',
        'plugin.scheduler',
        { value: 987654 },
        {
          data: {
            kind: 'plugin_event',
            eventKind: 'private_event',
            pluginId: 'reminder',
            fireId: 'private_fire',
            payload: { text: 'private payload' },
          },
        }
      );
      const id = await t.bus.append(signal);
      if (mode === 'restored') {
        t.bus.ensureOwned(id, 'stuck');
        t.bus.markFailed([id]);
        t.bus.markFailed([id]);
      }
      const h = await startInstance(t.path, {
        cognitionMode: 'hang',
        recordLogs: true,
        busSignalStream: t.bus,
        inboundStream: inbound,
        recipientRegistry: registry,
        commitSnapshot: async (tick, events) => {
          await t.store.commitOwners(t.epoch, tick, events);
        },
      });
      try {
        if (mode === 'fresh') {
          await waitFor(() => h.cognition.calls.length === 1, 'proactive turn');
          h.cognition.rejectAll();
          await waitFor(() => h.cognition.calls.length === 2, 'proactive retry');
          h.cognition.rejectAll();
        }
        if (mode === 'answered') {
          await waitFor(() => h.cognition.calls.length === 1, 'proactive answer');
          h.cognition.settleAll({
            confidence: 1,
            disposition: 'respond',
            intents: [
              { type: 'SEND_MESSAGE', payload: { recipientId: owner, text: 'Proactive answer' } },
            ],
          });
        }
        await waitFor(() => t.bus.committedOffset() === id, 'proactive outcome');
        expect(inbound.exportSnapshot()).toEqual(before);
        const warnings = h.recordedLogs.filter((l) => l.msg === failureWarning);
        expect(warnings).toHaveLength(mode === 'answered' ? 0 : 1);
        if (mode !== 'answered')
          expect(warnings[0]!.obj).toMatchObject({
            signalType: signal.type,
            signalSource: signal.source,
          });
        expect(JSON.stringify(warnings)).not.toMatch(/private_|987654/);
      } finally {
        readGate.mockRestore();
        h.coreLoop.haltForTest();
        await rmDir(t.path);
      }
    }
  );
});
