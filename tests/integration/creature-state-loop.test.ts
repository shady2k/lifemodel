import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeScratchDir,
  rmDir,
  startInstance,
  thoughtSignal,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';
import type { CreatureState } from '../../src/ports/creature-state.js';

let active: Awaited<ReturnType<typeof startInstance>> | undefined;
let scratch: string | undefined;

afterEach(async () => {
  active?.cognition.settleAll();
  await active?.coreLoop.stop();
  active = undefined;
  if (scratch) await rmDir(scratch);
  scratch = undefined;
});

describe('core creature-state publication', () => {
  it('publishes thinking during a turn and awake when it settles', async () => {
    scratch = await makeScratchDir('creature-state-loop-');
    const published: CreatureState[] = [];
    active = await startInstance(scratch, {
      cognitionMode: 'hang',
      tickIntervalMs: 1_000,
      creatureStateEpoch: 7,
      publishCreatureState: async (state) => {
        published.push(state);
      },
    });
    await waitFor(() => published.includes('awake'), 'initial awake state');
    active.coreLoop.pushSignal(thoughtSignal('hold the turn', active.recipientId));
    await waitFor(() => active?.cognition.calls.length === 1, 'cognition start', 10_000);
    await waitFor(() => published.includes('thinking'), 'thinking state', 10_000);

    active.cognition.settleAll();
    await waitFor(() => published.at(-1) === 'awake', 'awake after turn', 10_000);
    expect(published).toContain('thinking');
    expect(published.at(-1)).toBe('awake');
  }, 15_000);

  it('stops publishing when a snapshot commit rejects', async () => {
    vi.useFakeTimers();
    try {
      scratch = await makeScratchDir('creature-state-stopped-');
      const published: CreatureState[] = [];
      active = await startInstance(scratch, {
        tickIntervalMs: 10,
        creatureStateEpoch: 9,
        publishCreatureState: async (state) => {
          published.push(state);
        },
        commitSnapshot: async () => {
          throw new Error('snapshot commit rejected');
        },
      });
      expect(published).toEqual(['awake']);
      active.coreLoop.pushSignal(thoughtSignal('trigger failed commit', active.recipientId));
      await vi.advanceTimersByTimeAsync(20);
      expect(active.coreLoop.isRunning()).toBe(false);
      const stoppedPublicationCount = published.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(published).toHaveLength(stoppedPublicationCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps the core sleeping alertness mode to asleep', async () => {
    scratch = await makeScratchDir('creature-state-asleep-');
    const published: CreatureState[] = [];
    active = await startInstance(scratch, {
      initialSleepState: { mode: 'sleeping' },
      creatureStateEpoch: 8,
      publishCreatureState: async (state) => {
        published.push(state);
      },
    });

    await waitFor(() => published.includes('asleep'), 'initial asleep state');
    expect(published[0]).toBe('asleep');
  });
});
