/**
 * Unit tests for CaloriesDeficitNeuron state persistence.
 *
 * Tests that the neuron restores persisted state after a restart,
 * preventing duplicate emissions on the same day.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CaloriesDeficitNeuron, DEFAULT_CALORIES_DEFICIT_CONFIG } from '../../../src/plugins/calories/calories-neuron.js';
import type { AgentState } from '../../../src/types/agent/state.js';
import { DateTime, Settings } from 'luxon';

const NEURON_STATE_KEY = 'calories_deficit_neuron_state';

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

function createMockStorage(data: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...data };
  return {
    get: vi.fn(async <T>(key: string): Promise<T | null> => (store[key] as T) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { store[key] = value; }),
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => Object.keys(store)),
    query: vi.fn(async () => []),
    _store: store,
  };
}

function createAgentState(): AgentState {
  return {
    energy: 1.0,
    socialDebt: 0,
    taskPressure: 0,
    curiosity: 0,
    acquaintancePressure: 0,
    acquaintancePending: false,
    thoughtPressure: 0,
    pendingThoughtCount: 0,
    lastTickAt: new Date(),
    tickInterval: 1000,
  };
}

/**
 * Helper to set the fake "now" for both Luxon (getLocalHour, getCurrentFoodDate)
 * and Date.now (refractory period checks in BaseNeuron).
 */
function setFakeNow(isoString: string) {
  const dt = DateTime.fromISO(isoString, { zone: 'UTC' });
  Settings.now = () => dt.toMillis();
  vi.spyOn(Date, 'now').mockReturnValue(dt.toMillis());
}

function afterFakeNow() {
  Settings.now = () => Date.now();
  vi.restoreAllMocks();
}

describe('CaloriesDeficitNeuron persistence', () => {
  const TZ = 'UTC';
  const TODAY = '2025-06-15';  // a Sunday
  // 3 PM UTC → localHour=15, dayProgress=15/20=0.75
  const NOW_3PM = `${TODAY}T15:00:00.000Z`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    afterFakeNow();
  });

  function createNeuron(
    storage: ReturnType<typeof createMockStorage>,
    goal: number | null = 2000,
  ) {
    return new CaloriesDeficitNeuron(
      mockLogger as any,
      {},
      storage,
      () => TZ,
      () => null,
      async () => goal,
    );
  }

  it('should NOT emit on first tick after restart when persisted state is same-day with recent emission', async () => {
    // Simulate: neuron emitted 30 minutes ago, then agent restarted
    const emittedAt = DateTime.fromISO(NOW_3PM).minus({ minutes: 30 }).toISO()!;

    const storage = createMockStorage({
      [NEURON_STATE_KEY]: {
        lastEmittedAt: emittedAt,
        previousValue: 0.6,
        lastComputedDate: TODAY,
      },
      // No food logged → 100% deficit → pressure = 1.0 * 0.75 = 0.75
    });

    setFakeNow(NOW_3PM);
    const neuron = createNeuron(storage);

    // First tick — should restore state and hit refractory period
    neuron.check(createAgentState(), 0.8, 'test-1');

    // Let the async computation settle
    await vi.waitFor(() => {
      expect(storage.get).toHaveBeenCalledWith(NEURON_STATE_KEY);
    });
    // Give persist a chance to fire
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second tick — returns the pending signal from first tick's async
    const signal = neuron.check(createAgentState(), 0.8, 'test-2');

    // Should be undefined because refractory period (2h) hasn't elapsed
    expect(signal).toBeUndefined();
  });

  it('should treat different-day persisted state as fresh first tick', async () => {
    const YESTERDAY = '2025-06-14';
    const storage = createMockStorage({
      [NEURON_STATE_KEY]: {
        lastEmittedAt: `${YESTERDAY}T18:00:00.000Z`,
        previousValue: 0.6,
        lastComputedDate: YESTERDAY,
      },
      // No food today → full deficit
    });

    setFakeNow(NOW_3PM);
    const neuron = createNeuron(storage);

    // First tick — persisted date doesn't match today, so first-tick path
    neuron.check(createAgentState(), 0.8, 'test-1');
    await vi.waitFor(() => {
      expect(storage.get).toHaveBeenCalledWith(NEURON_STATE_KEY);
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second tick — should have a pending signal (first-tick emission for high deficit at 3 PM)
    const signal = neuron.check(createAgentState(), 0.8, 'test-2');
    expect(signal).toBeDefined();
    expect(signal!.data?.eventKind).toBe('calories:deficit');
  });

  it('should restore previousValue and use normal change detection when persisted state is same-day with expired refractory', async () => {
    // Emitted 3 hours ago (refractory = 2h, so it's expired)
    const emittedAt = DateTime.fromISO(NOW_3PM).minus({ hours: 3 }).toISO()!;

    const storage = createMockStorage({
      [NEURON_STATE_KEY]: {
        lastEmittedAt: emittedAt,
        previousValue: 0.75, // same as current pressure
        lastComputedDate: TODAY,
      },
      // No food → deficit=1.0, pressure=1.0*0.75=0.75
    });

    setFakeNow(NOW_3PM);
    const neuron = createNeuron(storage);

    // First tick: restores state, refractory expired, but previousValue≈currentValue → no significant change
    neuron.check(createAgentState(), 0.8, 'test-1');
    await vi.waitFor(() => {
      expect(storage.get).toHaveBeenCalledWith(NEURON_STATE_KEY);
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second tick — change detection: previous=0.75, current=0.75 → no change → no signal
    const signal = neuron.check(createAgentState(), 0.8, 'test-2');
    expect(signal).toBeUndefined();
  });

  it('should persist state after computation', async () => {
    const storage = createMockStorage({});

    setFakeNow(NOW_3PM);
    const neuron = createNeuron(storage);

    // First tick triggers persist
    neuron.check(createAgentState(), 0.8, 'test-1');
    await vi.waitFor(() => {
      expect(storage.set).toHaveBeenCalledWith(
        NEURON_STATE_KEY,
        expect.objectContaining({
          lastComputedDate: TODAY,
          previousValue: expect.any(Number),
        }),
      );
    });
  });

  it('should not crash if persisted state is corrupted', async () => {
    const storage = createMockStorage({
      [NEURON_STATE_KEY]: 'not-an-object',
    });

    setFakeNow(NOW_3PM);
    const neuron = createNeuron(storage);

    // Should fall back to normal first-tick behavior
    neuron.check(createAgentState(), 0.8, 'test-1');
    await vi.waitFor(() => {
      expect(storage.get).toHaveBeenCalledWith(NEURON_STATE_KEY);
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second tick — should have pending signal from first-tick path (high deficit at 3 PM)
    const signal = neuron.check(createAgentState(), 0.8, 'test-2');
    expect(signal).toBeDefined();
  });
});
