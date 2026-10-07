/**
 * One-shot schedule firings across a stop (lifemodel-ctc.1.2, review round 1
 * finding 2).
 *
 * A one-time occurrence is NOT regenerable by later ticks, so its firing is
 * complete only once the plugin_event signal it emitted was PROCESSED: the
 * scheduler records the fire id and removes the schedule at that point, not
 * before. A stop that drops the queued signal leaves the schedule due, and the
 * next start fires it again - once. A firing that WAS processed is never
 * delivered twice (the fire-id dedup).
 *
 * Real CoreLoop + real SchedulerService + real SchedulerPrimitive over real
 * storage (JSONStorage behind DeferredStorage), doubles only at the layers.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  makeScratchDir,
  rmDir,
  startInstance,
  stopInstance,
  waitFor,
  type CoreLoopInstance,
} from '../helpers/core-loop-drain-harness.js';

const PLUGIN_ID = 'reminder';

const scratchRoots: string[] = [];

async function fresh(prefix: string): Promise<string> {
  const root = await makeScratchDir(prefix);
  scratchRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rmDir(root);
  }
});

/** Schedule one due one-time reminder on the instance's scheduler. */
async function scheduleReminder(instance: CoreLoopInstance, id: string): Promise<void> {
  await instance.schedulerPrimitive!.schedule({
    id,
    fireAt: new Date(Date.now() - 1_000),
    data: { kind: 'reminder', text: 'wake up' },
  });
}

/** How many plugin_event signals the instance's cognition has been woken by. */
function reminderTriggers(instance: CoreLoopInstance): number {
  return instance.cognition.calls.filter((call) =>
    call.context.triggerSignals.some((signal) => signal.type === 'plugin_event')
  ).length;
}

describe('one-shot schedule firing across a stop (lifemodel-ctc.1.2)', () => {
  it('a firing whose signal was never processed fires once after the restart', async () => {
    const storagePath = await fresh('ctc-sched-unprocessed-');
    // No tick inside the test (60 s away): the firing is driven directly, so
    // nothing can process its signal before the stop - deterministic.
    const h1 = await startInstance(storagePath, {
      schedulerPluginId: PLUGIN_ID,
      cognitionMode: 'immediate',
      tickIntervalMs: 60_000,
    });
    await scheduleReminder(h1, 'rem-1');
    await h1.schedulerService!.tick();

    // the firing queued its signal and nothing processed it
    expect(h1.coreLoop.pendingSignalCount()).toBe(1);
    expect(h1.cognition.calls).toHaveLength(0);

    await stopInstance(h1, h1.storage);

    // The stop dropped the queued signal, so the firing was never
    // acknowledged: the schedule is still due in storage.
    expect(h1.cognition.calls).toHaveLength(0);
    const h2 = await startInstance(storagePath, {
      schedulerPluginId: PLUGIN_ID,
      cognitionMode: 'immediate',
      tickIntervalMs: 5,
    });
    expect(h2.schedulerPrimitive!.getSchedules().map((s) => s.id)).toEqual(['rem-1']);

    // it fires again and is delivered exactly once
    await waitFor(() => reminderTriggers(h2) === 1, 'the reminder was delivered after the restart');
    await waitFor(
      () => h2.schedulerPrimitive!.getSchedules().length === 0,
      'the processed firing was acknowledged and the schedule removed'
    );
    await waitFor(() => h2.autonomic.ticks() >= 5, 'instance 2 ran more ticks');
    expect(reminderTriggers(h2)).toBe(1);

    await stopInstance(h2, h2.storage);

    // and a third start has nothing left to deliver
    const h3 = await startInstance(storagePath, {
      schedulerPluginId: PLUGIN_ID,
      cognitionMode: 'immediate',
      tickIntervalMs: 5,
    });
    await waitFor(() => h3.autonomic.ticks() >= 5, 'instance 3 ran ticks');
    expect(reminderTriggers(h3)).toBe(0);
    expect(h3.schedulerPrimitive!.getSchedules()).toHaveLength(0);
    await stopInstance(h3, h3.storage);
  });

  it('a firing whose signal WAS processed is not delivered again after a restart', async () => {
    const storagePath = await fresh('ctc-sched-processed-');
    const h1 = await startInstance(storagePath, {
      schedulerPluginId: PLUGIN_ID,
      cognitionMode: 'immediate',
      tickIntervalMs: 5,
    });
    await scheduleReminder(h1, 'rem-2');

    await waitFor(() => reminderTriggers(h1) === 1, 'the reminder was delivered');
    await waitFor(
      () => h1.schedulerPrimitive!.getSchedules().length === 0,
      'the processed firing was acknowledged and the schedule removed'
    );

    await stopInstance(h1, h1.storage);

    const h2 = await startInstance(storagePath, {
      schedulerPluginId: PLUGIN_ID,
      cognitionMode: 'immediate',
      tickIntervalMs: 5,
    });
    await waitFor(() => h2.autonomic.ticks() >= 5, 'instance 2 ran ticks');
    expect(reminderTriggers(h2)).toBe(0);
    expect(h2.schedulerPrimitive!.getSchedules()).toHaveLength(0);
    await stopInstance(h2, h2.storage);
  });

  it('a one-time firing does not fire twice within one run while it is unprocessed', async () => {
    const storagePath = await fresh('ctc-sched-nodouble-');
    const h1 = await startInstance(storagePath, {
      schedulerPluginId: PLUGIN_ID,
      cognitionMode: 'immediate',
      tickIntervalMs: 60_000,
    });
    await scheduleReminder(h1, 'rem-3');
    await h1.schedulerService!.tick();
    expect(h1.coreLoop.pendingSignalCount()).toBe(1);

    // the schedule is still due, but the pending firing keeps it from firing
    // again while its signal waits in the queue
    await h1.schedulerService!.tick();
    await h1.schedulerService!.tick();
    expect(h1.coreLoop.pendingSignalCount()).toBe(1);

    await stopInstance(h1, h1.storage);
  });
});
