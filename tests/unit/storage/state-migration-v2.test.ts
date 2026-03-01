/**
 * Tests for v1→v2 state migration (binary alertness modes).
 */

import { describe, it, expect, vi } from 'vitest';
import { StateManager } from '../../../src/storage/state-manager.js';
import { createMockLogger } from '../../helpers/factories.js';

describe('StateManager v1→v2 migration', () => {
  function createManager() {
    const logger = createMockLogger();
    const storage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };
    return { manager: new StateManager(storage, logger as any), storage };
  }

  it('maps v1 "normal" mode to "awake"', async () => {
    const { manager, storage } = createManager();
    storage.load.mockResolvedValue({
      version: 1,
      savedAt: new Date().toISOString(),
      agent: {
        state: { energy: 0.8, tickInterval: 30000, lastTickAt: new Date() },
        sleepState: { mode: 'normal', disturbance: 0, disturbanceDecay: 0.95, wakeThreshold: 0.5 },
      },
      user: null,
      rules: [],
      neuronWeights: { contactPressure: {}, alertness: {} },
    });

    const state = await manager.load();
    expect(state).not.toBeNull();
    expect(state!.agent.sleepState.mode).toBe('awake');
    expect(state!.version).toBe(2);
  });

  it('maps v1 "sleep" mode to "sleeping"', async () => {
    const { manager, storage } = createManager();
    storage.load.mockResolvedValue({
      version: 1,
      savedAt: new Date().toISOString(),
      agent: {
        state: { energy: 0.3, tickInterval: 120000, lastTickAt: new Date() },
        sleepState: { mode: 'sleep', disturbance: 0.1, disturbanceDecay: 0.95, wakeThreshold: 0.5 },
      },
      user: null,
      rules: [],
      neuronWeights: { contactPressure: {}, alertness: {} },
    });

    const state = await manager.load();
    expect(state!.agent.sleepState.mode).toBe('sleeping');
  });

  it('maps v1 "alert" and "relaxed" modes to "awake"', async () => {
    for (const oldMode of ['alert', 'relaxed']) {
      const { manager, storage } = createManager();
      storage.load.mockResolvedValue({
        version: 1,
        savedAt: new Date().toISOString(),
        agent: {
          state: { energy: 0.8, tickInterval: 1000, lastTickAt: new Date() },
          sleepState: { mode: oldMode, disturbance: 0, disturbanceDecay: 0.95, wakeThreshold: 0.5 },
        },
        user: null,
        rules: [],
        neuronWeights: { contactPressure: {}, alertness: {} },
      });

      const state = await manager.load();
      expect(state!.agent.sleepState.mode).toBe('awake');
    }
  });

  it('removes tickInterval from agent state', async () => {
    const { manager, storage } = createManager();
    storage.load.mockResolvedValue({
      version: 1,
      savedAt: new Date().toISOString(),
      agent: {
        state: { energy: 0.8, tickInterval: 30000, lastTickAt: new Date() },
        sleepState: { mode: 'normal', disturbance: 0, disturbanceDecay: 0.95, wakeThreshold: 0.5 },
      },
      user: null,
      rules: [],
      neuronWeights: { contactPressure: {}, alertness: {} },
    });

    const state = await manager.load();
    expect('tickInterval' in state!.agent.state).toBe(false);
  });

  it('preserves "sleeping" if already present in v1 snapshot', async () => {
    const { manager, storage } = createManager();
    storage.load.mockResolvedValue({
      version: 1,
      savedAt: new Date().toISOString(),
      agent: {
        state: { energy: 0.5, lastTickAt: new Date() },
        sleepState: { mode: 'sleeping', disturbance: 0, disturbanceDecay: 0.95, wakeThreshold: 0.5 },
      },
      user: null,
      rules: [],
      neuronWeights: { contactPressure: {}, alertness: {} },
    });

    const state = await manager.load();
    expect(state!.agent.sleepState.mode).toBe('sleeping');
  });

  it('skips migration for v2 state', async () => {
    const { manager, storage } = createManager();
    storage.load.mockResolvedValue({
      version: 2,
      savedAt: new Date().toISOString(),
      agent: {
        state: { energy: 0.8, lastTickAt: new Date() },
        sleepState: { mode: 'awake', disturbance: 0, disturbanceDecay: 0.95, wakeThreshold: 0.5 },
      },
      user: null,
      rules: [],
      neuronWeights: { contactPressure: {}, alertness: {} },
    });

    const state = await manager.load();
    expect(state!.agent.sleepState.mode).toBe('awake');
    expect(state!.version).toBe(2);
  });
});
