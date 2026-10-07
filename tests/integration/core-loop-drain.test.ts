/**
 * Integration tests for shutdown draining (lifemodel-ctc.1.1).
 *
 * Real CoreLoop + real storage chain (JSONStorage behind DeferredStorage) +
 * real journal, doubles only at the layer boundary (no LLM, no network).
 *
 * Required scenarios:
 * 1. Stop while a cognition turn is in flight and the turn finishes within
 *    the drain deadline -> turn completed once, nothing persisted for redo.
 * 2. Stop while a turn overruns the deadline -> after a fresh start the
 *    trigger is processed exactly once.
 * 3. Signals accepted but not yet processed at stop -> processed after a
 *    fresh start, in order, once.
 */
import type { Signal } from '../../src/types/signal.js';

import {
  FakeAutonomicLayer,
  FakeCognitionLayer,
  FakeAggregationLayer,
  startInstance,
  stopInstance,
  openStorage,
  readJournal,
  makeScratchDir,
  rmDir,
  waitFor,
  thoughtSignal,
} from '../helpers/core-loop-drain-harness.js';

const DRAIN_DEADLINE_MS = 100;

// How many ticks to expect: 5 ms tick interval, generous deadline
const SETTLE_TICKS = 5;

const scratchRoots: string[] = [];

async function freshScratch(prefix: string): Promise<{ storagePath: string; logDir: string }> {
  const root = await makeScratchDir(prefix);
  scratchRoots.push(root);
  const storagePath = root;
  const logDir = `${root}-logs`;
  return { storagePath, logDir };
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rmDir(root);
    await rmDir(`${root}-logs`);
  }
});

describe('shutdown drain (lifemodel-ctc.1.1)', () => {
  it('stop during a turn that finishes within the deadline: turn completed once, nothing persisted for redo', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-finish-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 5_000,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);

    // The turn starts and completes
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'turn settled');
    expect(h1.cognition.triggerIds()).toEqual([trigger.id]);

    // ...and stays completed (its result is not re-run)
    const callsBeforeStop = h1.cognition.calls.length;

    await stopInstance(h1, await openStorage(storagePath), storagePath);

    expect(h1.cognition.calls.length).toBe(callsBeforeStop);
    // nothing persisted for redo
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([]);

    // Fresh start: no redo
    const h2 = await startInstance(storagePath, logDir, { cognitionMode: 'immediate' });
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.triggerIds()).toEqual([]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
  });

  it('stop during a turn that overruns the deadline: the trigger is processed exactly once after a fresh start', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-overrun-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // Stop overruns the deadline and requeues the trigger
    await stopInstance(h1, await openStorage(storagePath), storagePath);

    // the overrunning turn's trigger is what got persisted
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([trigger.id]);

    // Fresh start processes it exactly once
    const h2 = await startInstance(storagePath, logDir, { cognitionMode: 'immediate' });
    await waitFor(() => h2.cognition.triggerIds().includes(trigger.id), 'trigger redone');
    expect(h2.cognition.triggerIds()).toEqual([trigger.id]);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    // ...and no second redo ever appears
    expect(h2.cognition.triggerIds()).toEqual([trigger.id]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
    h2.cognition.settleAll();
  });

  it('pending signals at stop: processed after a fresh start, in order, once', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-pending-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // Messages arrive while COGNITION is busy: they are accepted as pending
    // signals and deferred, not consumed.
    const first = thoughtSignal('queued first');
    const second = thoughtSignal('queued second');
    h1.coreLoop.pushSignal(first);
    h1.coreLoop.pushSignal(second);
    await waitFor(
      () => h1.autonomic.sawAgainInOrder(first, second),
      'queued messages re-drained untouched while COGNITION is busy'
    );
    expect(h1.cognition.calls.length).toBe(1); // consumed nothing
    expect(h1.cognition.triggerIds()).toEqual([trigger.id]);

    await stopInstance(h1, await openStorage(storagePath), storagePath);

    // FIFO with the requeued trigger in front (it was accepted first)
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([
      trigger.id,
      first.id,
      second.id,
    ]);

    // Fresh start processes all three, in order, each exactly once
    const h2 = await startInstance(storagePath, logDir, { cognitionMode: 'immediate' });
    await waitFor(() => h2.cognition.triggerIds().includes(second.id), 'messages redone');
    expect(h2.cognition.triggerIds()).toEqual([trigger.id, first.id, second.id]);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.triggerIds()).toEqual([trigger.id, first.id, second.id]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
    h2.cognition.settleAll();
  });
});
