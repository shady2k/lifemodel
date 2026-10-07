/**
 * The acknowledgement cursor moves AFTER processing (lifemodel-ctc.1.2, review
 * round 1 findings 2 and 3).
 *
 * A signal the loop took off the queue is reported to its source through the
 * container's `onSignalProcessed` hook only once the tick really processed it:
 * a signal DEFERRED back to the queue (COGNITION busy) is not reported, and a
 * signal the stop dropped is never reported - which is what makes its source
 * deliver the event again after the next start.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createSignal, type Signal } from '../../src/types/signal.js';

import {
  makeScratchDir,
  rmDir,
  startInstance,
  stopInstance,
  thoughtSignal,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';

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

/** A motor_result signal, the shape Motor Cortex pushes. */
function motorResult(runId: string): Signal {
  return createSignal(
    'motor_result',
    'motor.cortex',
    { value: 1, confidence: 1 },
    {
      data: {
        kind: 'motor_result',
        runId,
        status: 'completed',
        result: { ok: true, summary: 'done', stats: {} },
      },
    }
  );
}

describe('the processed-signal hook (lifemodel-ctc.1.2)', () => {
  it('reports a signal the tick processed, exactly once', async () => {
    const storagePath = await fresh('ctc-ack-processed-');
    const processed: string[] = [];
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'immediate',
      tickIntervalMs: 5,
      onSignalProcessed: (signal) => {
        processed.push(signal.id);
      },
    });
    const signal = motorResult('run-a');
    h1.coreLoop.pushSignal(signal);

    await waitFor(() => processed.includes(signal.id), 'the processed signal was reported');
    await waitFor(() => h1.autonomic.ticks() >= 5, 'more ticks ran');
    expect(processed.filter((id) => id === signal.id)).toHaveLength(1);

    await stopInstance(h1, h1.storage);
  });

  it('does not report a signal that was DEFERRED (COGNITION busy) until a tick processes it', async () => {
    const storagePath = await fresh('ctc-ack-deferred-');
    const processed: string[] = [];
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'hang', // COGNITION busy: motor_result is deferred
      tickIntervalMs: 5,
      drainTimeoutMs: 150,
      onSignalProcessed: (signal) => {
        processed.push(signal.id);
      },
    });
    // a turn in flight, so every motor_result is deferred
    h1.coreLoop.pushSignal(thoughtSignal('the busy turn'));
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    const signal = motorResult('run-b');
    h1.coreLoop.pushSignal(signal);
    await waitFor(() => h1.autonomic.ticks() >= 5, 'ticks ran with the signal deferred');
    expect(processed).not.toContain(signal.id); // still deferred, not processed
    expect(h1.coreLoop.pendingSignalCount()).toBe(1); // still in the queue

    // the turn ends: the next tick processes the queued signal and reports it
    h1.cognition.settleAll();
    await waitFor(() => processed.includes(signal.id), 'reported once the tick processed it');
    await waitFor(() => h1.autonomic.ticks() >= 10, 'more ticks ran');
    expect(processed.filter((id) => id === signal.id)).toHaveLength(1);

    // the motor_result woke a new turn (this fake never settles it): end it so
    // the stop has nothing to drain
    h1.cognition.settleAll();
    await stopInstance(h1, h1.storage);
  });

  it('never reports a signal the stop dropped', async () => {
    const storagePath = await fresh('ctc-ack-dropped-');
    const processed: string[] = [];
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'hang',
      tickIntervalMs: 5,
      drainTimeoutMs: 100,
      onSignalProcessed: (signal) => {
        processed.push(signal.id);
      },
    });
    h1.coreLoop.pushSignal(thoughtSignal('the busy turn'));
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    const signal = motorResult('run-c');
    h1.coreLoop.pushSignal(signal);
    await waitFor(() => h1.coreLoop.pendingSignalCount() === 1, 'the result is queued, deferred');

    await stopInstance(h1, h1.storage);
    h1.cognition.settleAll();

    // the queued result was dropped with the stop, never processed
    expect(processed).not.toContain(signal.id);
  });
});
