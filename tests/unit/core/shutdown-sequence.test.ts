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
 *   5. durable write intake is fenced after all awaited writes
 *
 * Nothing is persisted for the next run: internal signals are not durable and
 * inbound messages are carried by the durable inbound log. Whatever still
 * hangs at the deadline is abandoned by the hard exit (src/core/hard-exit.ts,
 * armed in src/index.ts), which names the STEP the stop never finished - what
 * `progress` records here.
 */
import { describe, expect, it } from 'vitest';

import {
  closeTaskResources,
  shutdownSequence,
  type StopProgress,
} from '../../../src/core/container.js';
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
  return { steps, channel, coreLoop, stateManager, recipientRegistry, ackRegistry };
}

describe('container shutdown sequence', () => {
  it.each([0, 1, 2])(
    'closes the command pool and stores even when task drain %s fails',
    async (failed) => {
      const steps: string[] = [];
      const fault = new Error('task drain failed');
      const drains = Promise.allSettled(
        [0, 1, 2].map((i) => (i === failed ? Promise.reject(fault) : Promise.resolve()))
      );
      await expect(
        closeTaskResources(drains, [
          async () => {
            steps.push('commandPool.end');
          },
          async () => {
            steps.push('trace.stop');
          },
          async () => {
            steps.push('redis.quit');
          },
          async () => {
            steps.push('postgres.end');
          },
        ])
      ).rejects.toMatchObject({ errors: [fault] });
      expect(steps).toEqual(['commandPool.end', 'trace.stop', 'redis.quit', 'postgres.end']);
    }
  );

  it('keeps the original shutdown failure first when drains and cleanup also fail', async () => {
    const d = makeDoubles();
    const primary = new Error('core shutdown failed');
    const drain = new Error('task drain failed');
    const cleanup = new Error('pool close failed');
    d.coreLoop.stop = async () => {
      throw primary;
    };
    const [outcome] = await Promise.allSettled([
      shutdownSequence({
        logger: noopLogger,
        deadline: Date.now() + 5_000,
        channels: [d.channel] as never,
        coreLoop: d.coreLoop as never,
        stateManager: d.stateManager as never,
        recipientRegistry: d.recipientRegistry as never,
      }),
    ]);
    const remaining = async () => {
      d.steps.push('remaining cleanup');
    };
    await expect(
      closeTaskResources(
        Promise.allSettled([Promise.reject(drain)]),
        [
          async () => {
            throw cleanup;
          },
          remaining,
        ],
        outcome
      )
    ).rejects.toMatchObject({ errors: [primary, drain, cleanup] });
    expect(d.steps.at(-1)).toBe('remaining cleanup');
  });

  it('still closes the shared stores if command pool close fails', async () => {
    const steps: string[] = [];
    await expect(
      closeTaskResources(Promise.allSettled([]), [
        async () => {
          throw new Error('pool failure');
        },
        async () => {
          steps.push('postgres.end');
        },
      ])
    ).rejects.toThrow('Task resource shutdown failed');
    expect(steps).toEqual(['postgres.end']);
  });
  it('stops intake first, drains the turn, releases the channels and flushes storage last', async () => {
    const d = makeDoubles();
    const progress: StopProgress = { step: 'done' };

    await shutdownSequence({
      logger: noopLogger,
      deadline: Date.now() + 5_000,
      channels: [d.channel] as never,
      coreLoop: d.coreLoop as never,
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
      'channel.stop',
      // the fence is closed just before the LAST step: nothing writes after it
      'coreLoop.closeDurableWrites',
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
    };

    await shutdownSequence({
      logger: noopLogger,
      deadline: Date.now() + 5_000,
      channels: [watched.channel] as never,
      coreLoop: watched.coreLoop as never,
      progress,
      stateManager: d.stateManager as never,
      recipientRegistry: d.recipientRegistry as never,
      ackRegistry: d.ackRegistry as never,
    });

    expect(seen).toEqual(['intake_stop', 'loop_drain', 'channel_stop']);
  });

  it('a caller without a progress recorder still stops in order', async () => {
    const d = makeDoubles();
    await shutdownSequence({
      logger: noopLogger,
      deadline: Date.now() + 5_000,
      channels: [d.channel] as never,
      coreLoop: d.coreLoop as never,
      stateManager: d.stateManager as never,
      recipientRegistry: d.recipientRegistry as never,
      ackRegistry: d.ackRegistry as never,
    });
    expect(d.steps.at(-1)).toBe('coreLoop.closeDurableWrites');
  });
});
