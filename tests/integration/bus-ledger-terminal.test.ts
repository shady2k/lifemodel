import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream, type BusSnapshot } from '../../src/core/bus-stream.js';
import { createSignal } from '../../src/types/signal.js';
import {
  makeScratchDir,
  rmDir,
  startInstance,
  thoughtSignal,
  waitFor as waitForCondition,
} from '../helpers/core-loop-drain-harness.js';

const waitFor = (condition: () => boolean, what: string) => waitForCondition(condition, what, 1500);

const silent = { confidence: 1, intents: [], disposition: 'no_reply' as const };

describe('internal bus terminal outcomes', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  async function setup(name: string) {
    const prefix = `bus-terminal:${name}:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('bus-terminal-');
    let saved: BusSnapshot | undefined;
    const start = () => startInstance(path, {
      cognitionMode: 'hang',
      recordLogs: true,
      busSignalStream: bus,
      commitSnapshot: async (tick, events) => {
        await store.commitOwners(epoch, tick, events);
        saved = bus.exportSnapshot();
      },
    });
    return { prefix, store, bus, epoch, path, start, saved: () => saved };
  }

  it('counts a proactive final web answer without a registered channel as answered', async () => {
    const t = await setup('web-answer');
    const signal = createSignal('plugin_event', 'news:daily_digest', { value: 1 });
    const id = await t.bus.append(signal);
    const h = await t.start();
    try {
      await waitFor(() => h.cognition.calls.length === 1, 'proactive turn');
      const owner = h.registry.lookup('web', 'owner')!;
      h.cognition.settleAll({
        confidence: 1,
        disposition: 'respond',
        intents: [{ type: 'SEND_MESSAGE', payload: { recipientId: owner, text: 'Digest' } }],
      });
      await waitFor(() => t.saved()?.watermark === id, 'web answer and bus completion committed');
      expect(h.cognition.calls).toHaveLength(1);
      const rows = await stores.redis.xrange(`${t.prefix}outbound`, '-', '+');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]![1][1]!)).toMatchObject({
        type: 'send.command', payload: { recipientId: owner, channel: 'web', text: 'Digest' },
      });
      expect(h.channel.sent).toHaveLength(0);
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });

  it.each(['empty-result', 'unaccounted-final-send'] as const)(
    'bounds an undefined %s outcome to two attempts and admits 105 later signals', async (mode) => {
      const t = await setup(mode);
      const h = await t.start();
      try {
        const head = thoughtSignal('undecided head', h.recipientId);
        const id = await t.bus.append(head);
        await waitFor(() => h.cognition.calls.length === 1, 'first attempt');
        // A send to somebody else does not answer this turn. This exercises a
        // real final send that is not counted delivered for the owned trigger.
        const result = {
          confidence: 1,
          disposition: 'respond' as const,
          intents: mode === 'empty-result' ? [] : [{
            type: 'SEND_MESSAGE' as const,
            payload: { recipientId: h.registry.getOrCreate('web', 'other'), text: 'Other' },
          }],
        };
        h.cognition.settleAll(result);
        await waitFor(() => h.cognition.calls.length === 2, 'undefined outcome retried once');
        expect(h.cognition.calls[1]!.context.tickId).toBe(h.cognition.calls[0]!.context.tickId);
        h.cognition.settleAll(result);
        await waitFor(() => t.saved()?.watermark === id, 'retry budget releases watermark');
        expect(h.cognition.calls).toHaveLength(2);
        expect(h.recordedLogs.some((log) => log.msg ===
          'Internal signals failed twice and were completed with their recorded failure')).toBe(true);
        h.cognition.result = silent;
        const later = Array.from({ length: 105 }, (_, i) => thoughtSignal(`later ${i}`, h.recipientId));
        const laterIds = [];
        for (const signal of later) laterIds.push(await t.bus.append(signal));
        let handled = 2;
        await waitFor(() => {
          if (h.cognition.calls.length > handled) {
            handled = h.cognition.calls.length;
            h.cognition.settleAll(silent);
          }
          return t.saved()?.watermark === laterIds.at(-1);
        }, '105 later signals admitted and committed');
        expect(h.cognition.triggerIds()).toEqual([head.id, head.id, ...later.map((s) => s.id)]);
        expect(t.saved()?.entries).toEqual({});
      } finally {
        h.coreLoop.haltForTest();
        await rmDir(t.path);
      }
    }
  );

  it.each([false, true])('recovers a full hydrated ledger with retries=3 (expired=%s) without another turn', async (expired) => {
    const t = await setup(`stuck-${expired}`);
    const head = thoughtSignal('stuck');
    if (expired) head.expiresAt = new Date(0);
    const seeds = [head, ...Array.from({ length: 99 }, (_, i) => thoughtSignal(`completed ${i}`))];
    const ids = [];
    for (const signal of seeds) ids.push(await t.bus.append(signal));
    const snapshot: BusSnapshot = {
      version: 1, watermark: '0-0', entries: Object.fromEntries(ids.map((id, i) => [id,
        i === 0 ? { status: 'failed', turnId: 'vm-stuck-turn', retries: 3 } : { status: 'completed' },
      ])),
    };
    t.bus.hydrateSnapshot(snapshot);
    await t.store.commitOwners(t.epoch, 0);
    const restored = createBusSignalStream(stores.redis, t.prefix);
    restored.hydrateSnapshot(t.bus.exportSnapshot());
    t.bus.hydrateSnapshot(restored.exportSnapshot());
    const later = Array.from({ length: 105 }, (_, i) => thoughtSignal(`waiting ${i}`));
    const laterIds = [];
    for (const signal of later) laterIds.push(await t.bus.append(signal));
    const h = await t.start();
    try {
      let handled = 0;
      await waitFor(() => {
        if (h.cognition.calls.length > handled) {
          handled = h.cognition.calls.length;
          h.cognition.settleAll(silent);
        }
        return t.saved()?.watermark === laterIds.at(-1);
      }, 'stuck snapshot self-recovers and waiting signals commit');
      expect(h.cognition.triggerIds()).toEqual(later.map((s) => s.id));
      expect(t.saved()?.entries).toEqual({});
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });

  it.each(['new', 'owned', 'failed'] as const)('completes an expired %s signal without cognition', async (status) => {
    const t = await setup(`expired-${status}`);
    const signal = thoughtSignal('expired');
    signal.expiresAt = new Date(0);
    const id = await t.bus.append(signal);
    if (status !== 'new') {
      t.bus.ensureOwned(id, 'persisted-turn');
      if (status === 'failed') t.bus.markFailed([id]);
    }
    const h = await t.start();
    try {
      await waitFor(() => t.saved()?.watermark === id, 'expired entry completed');
      expect(h.cognition.calls).toHaveLength(0);
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(t.path);
    }
  });
});
