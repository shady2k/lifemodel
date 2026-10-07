/**
 * Unit tests for the container shutdown sequence.
 *
 * Pins the stop order (lifemodel-ctc.1.1, bounded by lifemodel-ctc.1.2):
 *   1. channel intake stops first
 *   2. the cognition turn in flight is drained (coreLoop.stop), bounded by the
 *      ONE deadline together with the tick, the scheduler callback and the
 *      sends it scheduled
 *   3. state and registries persist
 *   4. the channels stop fully (sending released)
 *   5. storage flushes LAST
 *
 * Nothing is persisted for the next run: internal signals are not durable and
 * inbound messages are carried by the durable inbound log. Whatever still
 * hangs at the deadline is abandoned by the hard exit (src/core/hard-exit.ts,
 * armed in src/index.ts), which names the STEP the stop never finished - what
 * `progress` records here.
 */
import { describe, expect, it } from 'vitest';

import { shutdownSequence, type StopProgress } from '../../../src/core/container.js';
import type { StopReport } from '../../../src/core/core-loop.js';
import type { Logger } from '../../../src/types/logger.js';

const noopLogger = {
  child: () => noopLogger,
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const idleReport: StopReport = {
  loopStopped: true,
  tickInFlight: false,
  schedulerInFlight: false,
  turnInFlight: false,
  sendsOutstanding: 0,
  queuedSignals: 0,
};

function makeDoubles() {
  const steps: string[] = [];
  const channel = {
    name: 'test',
    stopIntake: async () => {
      steps.push('channel.stopIntake');
    },
    stop: async () => {
      steps.push('channel.stop');
    },
  };
  const coreLoop = {
    stop: async () => {
      steps.push('coreLoop.stop');
    },
    stopReport: () => idleReport,
    closeDurableWrites: () => {
      steps.push('coreLoop.closeDurableWrites');
    },
  };
  const stateManager = { shutdown: async () => steps.push('stateManager.shutdown') };
  const recipientRegistry = { flush: async () => steps.push('recipientRegistry.flush') };
  const ackRegistry = { flush: async () => steps.push('ackRegistry.flush') };
  const storage = { shutdown: async () => steps.push('storage.shutdown') };
  return { steps, channel, coreLoop, stateManager, recipientRegistry, ackRegistry, storage };
}

describe('container shutdown sequence', () => {
  it('stops intake first, drains the turn, releases the channels and flushes storage last', async () => {
    const d = makeDoubles();
    const progress: StopProgress = { step: 'done' };

    await shutdownSequence({
      logger: noopLogger,
      deadline: Date.now() + 5_000,
      channels: [d.channel] as never,
      coreLoop: d.coreLoop as never,
      storage: d.storage as never,
      progress,
      stateManager: d.stateManager as never,
      recipientRegistry: d.recipientRegistry as never,
      ackRegistry: d.ackRegistry as never,
    });

    expect(d.steps).toEqual([
      'channel.stopIntake',
      'coreLoop.stop',
      'stateManager.shutdown',
      'recipientRegistry.flush',
      'ackRegistry.flush',
      'channel.stop',
      // the fence is closed just before the LAST step: nothing writes after it
      'coreLoop.closeDurableWrites',
      'storage.shutdown',
    ]);
    // the stop finished: the hard exit is disarmed on 'done'
    expect(progress.step).toBe('done');
  });

  it('names the step it reached while it runs (what the hard exit logs)', async () => {
    const d = makeDoubles();
    const progress: StopProgress = { step: 'done' };
    const seen: string[] = [];
    const watched = {
      ...d,
      channel: {
        name: 'test',
        stopIntake: async () => {
          seen.push(progress.step);
        },
        stop: async () => {
          seen.push(progress.step);
        },
      },
      coreLoop: {
        stop: async () => {
          seen.push(progress.step);
        },
        stopReport: () => idleReport,
        closeDurableWrites: () => undefined,
      },
      storage: {
        shutdown: async () => {
          seen.push(progress.step);
        },
      },
    };

    await shutdownSequence({
      logger: noopLogger,
      deadline: Date.now() + 5_000,
      channels: [watched.channel] as never,
      coreLoop: watched.coreLoop as never,
      storage: watched.storage as never,
      progress,
      stateManager: d.stateManager as never,
      recipientRegistry: d.recipientRegistry as never,
      ackRegistry: d.ackRegistry as never,
    });

    expect(seen).toEqual(['intake_stop', 'loop_drain', 'channel_stop', 'storage_flush']);
  });

  it('a caller without a progress recorder still stops in order', async () => {
    const d = makeDoubles();
    await shutdownSequence({
      logger: noopLogger,
      deadline: Date.now() + 5_000,
      channels: [d.channel] as never,
      coreLoop: d.coreLoop as never,
      storage: d.storage as never,
      stateManager: d.stateManager as never,
      recipientRegistry: d.recipientRegistry as never,
      ackRegistry: d.ackRegistry as never,
    });
    expect(d.steps.at(-1)).toBe('storage.shutdown');
  });
});
