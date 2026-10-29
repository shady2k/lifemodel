import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { RecipientRegistry } from '../../src/core/recipient-registry.js';
import { AggregationProcessor } from '../../src/layers/aggregation/processor.js';
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
  stopInstance,
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

  it.each(['same-core', 'restart'] as const)(
    'defers a scheduler-fired reminder during a running turn exactly once (%s)',
    async (mode) => {
      const t = await setup(`busy-reminder-${mode}`);
      const h = await t.start();
      let resumed: Awaited<ReturnType<typeof t.start>> | undefined;
      let verified: Awaited<ReturnType<typeof t.start>> | undefined;
      try {
        const head = thoughtSignal('busy turn');
        const headId = await t.bus.append(head);
        await waitFor(() => h.cognition.calls.length === 1, 'head turn is running');
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
          data: { kind: 'reminder:due', text: 'busy reminder' },
        });
        const scheduler = createSchedulerService(logger);
        scheduler.registerScheduler('reminder', primitive);
        const emitted: Signal[] = [];
        scheduler.setSignalCallback((signal) => {
          emitted.push(signal);
          h.coreLoop.pushSignal(signal);
        });
        await scheduler.tick();
        expect(primitive.getSchedules()).toHaveLength(0);
        expect(emitted).toHaveLength(1);
        const reminder = emitted[0]!;
        await waitFor(
          () => h.autonomic.seen.some((batch) => batch.some((s) => s.id === reminder.id)),
          'busy tick sees scheduled reminder'
        );
        await waitFor(
          () => Object.keys(t.saved().entries).length === 2,
          'busy tick commits both ledger entries'
        );
        const reminderId = Object.keys(t.saved().entries).find((id) => id !== headId)!;
        expect(t.saved().entries[reminderId]?.status).toBe('owned');
        expect(h.cognition.triggerIds()).toEqual([head.id]);
        expect(
          h.recordedLogs.some(
            (log) =>
              log.msg === 'Deferring signals to next tick: COGNITION busy' &&
              log.obj?.pluginEvents === 1
          )
        ).toBe(true);

        if (mode === 'restart') {
          // Drain the head, but stop intake/ticks before the deferred reminder
          // can start. Only the committed Valkey snapshot survives the restart.
          const stopping = stopInstance(h);
          h.cognition.settleAll(quiet);
          await stopping;
          await t.store.hydrate(await t.store.read());
          resumed = await t.start();
        } else {
          h.cognition.settleAll(quiet);
        }
        const active = resumed ?? h;
        const expectedCalls = mode === 'restart' ? 1 : 2;
        await waitFor(
          () => active.cognition.calls.length === expectedCalls,
          'deferred reminder starts its own turn'
        );
        expect(active.cognition.calls.at(-1)!.context.triggerSignals.map((s) => s.id)).toEqual([
          reminder.id,
        ]);
        active.cognition.settleAll(quiet);
        await waitFor(() => t.saved().watermark === reminderId, 'reminder outcome commits');
        expect([...h.cognition.triggerIds(), ...(resumed?.cognition.triggerIds() ?? [])]).toEqual([
          head.id,
          reminder.id,
        ]);
        await stopInstance(active);
        await t.store.hydrate(await t.store.read());
        const before = t.saved();
        verified = await t.start();
        await waitFor(() => t.saved() !== before, 'post-completion restart commits a tick');
        expect(verified.cognition.calls).toHaveLength(0);
      } finally {
        h.coreLoop.haltForTest();
        resumed?.coreLoop.haltForTest();
        verified?.coreLoop.haltForTest();
        await rmDir(t.path);
      }
    }
  );

  it.each(['same-core', 'restart'] as const)(
    'keeps a reminder sharing an owner-message tick for its own later turn (%s)',
    async (mode) => {
      const t = await setup(`shared-owner-${mode}`);
      const registry = new RecipientRegistry();
      const owner = registry.getOrCreate('web', 'owner');
      const reminder = createSignal(
        'plugin_event',
        'reminder.scheduler',
        { value: 1 },
        {
          data: {
            kind: 'plugin_event',
            pluginId: 'reminder',
            eventKind: 'reminder_due',
            fireId: 'shared-fire',
            payload: { text: 'shared tick reminder' },
          },
        }
      );
      const message = createUserMessageSignal({
        recipientId: owner,
        channel: 'web',
        updateId: 'shared-owner-message',
        text: 'Owner wins this tick',
      });
      const reminderId = await t.bus.append(reminder);
      const ownerId = await t.bus.append(message);
      if (mode === 'restart') {
        for (const id of [reminderId, ownerId]) t.bus.ensureOwned(id, `pending:${id}`);
        await t.store.commitOwners(t.epoch, 0);
        await t.store.hydrate(await t.store.read());
      }
      let saved = t.bus.exportSnapshot();
      const h = await startInstance(t.path, {
        cognitionMode: 'hang',
        busSignalStream: t.bus,
        recipientRegistry: registry,
        commitSnapshot: async (tick, events) => {
          await t.store.commitOwners(t.epoch, tick, events);
          saved = t.bus.exportSnapshot();
        },
      });
      const aggregation = new AggregationProcessor(createTestLogger(), {
        enablePatternDetection: false,
      });
      h.aggregation.process = (signals, state) => aggregation.process(signals, state);
      try {
        await waitFor(() => h.cognition.calls.length === 1, 'owner wins shared tick');
        expect(h.cognition.triggerIds()).toEqual([message.id]);
        h.cognition.settleAll(quiet);
        await waitFor(() => h.cognition.calls.length === 2, 'reminder runs after owner');
        expect(h.cognition.triggerIds()).toEqual([message.id, reminder.id]);
        h.cognition.settleAll(quiet);
        await waitFor(() => saved.watermark === ownerId, 'both shared inputs commit');
        await stopInstance(h);
        expect(h.cognition.calls).toHaveLength(2);
        await t.store.hydrate(await t.store.read());
        const before = t.saved();
        const verified = await t.start();
        try {
          await waitFor(() => t.saved() !== before, 'restart after both outcomes');
          expect(verified.cognition.calls).toHaveLength(0);
        } finally {
          verified.coreLoop.haltForTest();
        }
      } finally {
        h.coreLoop.haltForTest();
        await rmDir(t.path);
      }
    }
  );

  it('does not defer an in-memory autonomic plugin event while cognition is busy', async () => {
    const t = await setup('derived-plugin');
    const h = await t.start();
    const derived = createSignal('plugin_event', 'calories.anomaly', { value: 1 });
    try {
      await t.bus.append(thoughtSignal('hold cognition'));
      await waitFor(() => h.cognition.calls.length === 1, 'cognition busy');
      const process = h.autonomic.process.bind(h.autonomic);
      h.autonomic.process = (state, signals, correlationId) => {
        const result = process(state, signals, correlationId);
        return { ...result, signals: [...result.signals, derived] };
      };
      await waitFor(
        () => h.aggregation.sawAllOf(derived),
        'derived plugin reaches aggregation while busy'
      );
      expect(h.cognition.calls).toHaveLength(1);
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });

  it.each(['idle', 'owner-message', '120-events'] as const)(
    'completes non-waking bus plugin events after one quiet evaluation (%s)',
    async (mode) => {
      const t = await setup(`quiet-plugin-${mode}`);
      const count = mode === '120-events' ? 120 : 1;
      const facts = Array.from({ length: count }, (_, i) =>
        createSignal(
          'plugin_event',
          'news.facts',
          { value: 0.1 },
          {
            data: {
              kind: 'fact_batch',
              pluginId: 'news',
              eventKind: 'news:interesting',
              urgent: false,
              facts: [
                {
                  content: `quiet fact ${i}`,
                  confidence: 0.5,
                  tags: ['quiet'],
                  provenance: { source: 'test', originalId: `quiet-${i}` },
                },
              ],
            },
          }
        )
      );
      const ids: string[] = [];
      for (const fact of facts) ids.push(await t.bus.append(fact));
      let lastId = ids.at(-1)!;
      let ownerId: string | undefined;
      if (mode === 'owner-message') {
        const registry = new RecipientRegistry();
        const owner = registry.getOrCreate('web', 'owner');
        const message = createUserMessageSignal({
          recipientId: owner,
          channel: 'web',
          updateId: 'quiet-owner',
          text: 'Owner first',
        });
        lastId = await t.bus.append(message);
        ownerId = message.id;
      }
      const h = await t.start();
      const save = vi.fn(async () => undefined);
      const aggregation = new AggregationProcessor(createTestLogger(), {
        enablePatternDetection: false,
      });
      aggregation.updateDeps({ memoryProvider: { save } as never });
      const evaluations: { signals: Signal[]; selected: string[] }[] = [];
      h.aggregation.process = async (signals, state) => {
        const result = await aggregation.process(signals, state);
        evaluations.push({
          signals: [...signals],
          selected: result.triggerSignals.map((s) => s.id),
        });
        return result;
      };
      try {
        if (ownerId) {
          await waitFor(() => h.cognition.calls.length === 1, 'owner wins quiet-fact batch');
          expect(h.cognition.triggerIds()).toEqual([ownerId]);
          expect(save).not.toHaveBeenCalled();
          h.cognition.settleAll(quiet);
        }
        await waitFor(
          () => t.saved().watermark === lastId,
          'quiet facts complete and release admission'
        );
        expect(save).toHaveBeenCalledTimes(count);
        expect(h.cognition.calls).toHaveLength(ownerId ? 1 : 0);
        for (const fact of facts) {
          const quietEvaluations = evaluations.filter(
            (entry) => entry.selected.length === 0 && entry.signals.some((s) => s.id === fact.id)
          );
          expect(quietEvaluations).toHaveLength(1);
        }
        if (ownerId) {
          const ownerEvaluation = evaluations.findIndex((entry) =>
            entry.selected.includes(ownerId!)
          );
          const factEvaluation = evaluations.findIndex(
            (entry) =>
              entry.selected.length === 0 && entry.signals.some((s) => s.id === facts[0]!.id)
          );
          expect(factEvaluation).toBeGreaterThan(ownerEvaluation);
        }
        expect(t.saved().entries).toEqual({});
        await stopInstance(h);
        expect(save).toHaveBeenCalledTimes(count);
      } finally {
        h.coreLoop.haltForTest();
        await rmDir(t.path);
      }
    }
  );

  it('loads and drains a hydrated legacy snapshot with 150 owned entries', async () => {
    const t = await setup('legacy-150');
    const signals = Array.from({ length: 150 }, (_, i) => thoughtSignal(`legacy ${i}`));
    const ids: string[] = [];
    for (const signal of signals) ids.push(await t.bus.append(signal));
    t.bus.hydrateSnapshot({
      version: 1,
      watermark: '0-0',
      entries: Object.fromEntries(
        ids.map((id) => [id, { status: 'owned', turnId: 'legacy-turn', retries: 0 }])
      ),
    });
    await t.store.commitOwners(t.epoch, 0);
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
      }, 'legacy ledger drains without an oversized probe');
      expect(h.cognition.triggerIds()).toEqual(signals.map((s) => s.id));
      expect(t.saved().entries).toEqual({});
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
