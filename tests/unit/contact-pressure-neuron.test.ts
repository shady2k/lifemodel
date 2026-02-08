/**
 * Unit tests for ContactPressureNeuron.
 *
 * Tests the two-threshold architecture:
 * - emitThreshold (0.2): Neuron emits while pressure is above this threshold
 * - wakeThreshold (0.35): ThresholdEngine decides when to wake Cognition
 *
 * The neuron's job is to continuously signal that desire exists,
 * keeping aggregates fresh for ThresholdEngine to evaluate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ContactPressureNeuron,
  DEFAULT_CONTACT_PRESSURE_CONFIG,
} from '../../src/plugins/contact-pressure/index.js';
import type { AgentState } from '../../src/types/agent/state.js';

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

function createTestLogger() {
  return mockLogger as any;
}

// Helper to create agent state with specific pressure factors
function createAgentState(overrides: Partial<AgentState> = {}): AgentState {
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
    ...overrides,
  };
}

// Calculate expected pressure from state using default weights
function calculateExpectedPressure(state: AgentState): number {
  const weights = DEFAULT_CONTACT_PRESSURE_CONFIG.weights;
  return (
    state.socialDebt * weights.socialDebt +
    state.taskPressure * weights.taskPressure +
    state.curiosity * weights.curiosity +
    state.acquaintancePressure * weights.acquaintancePressure
  );
}

describe('ContactPressureNeuron', () => {
  let neuron: ContactPressureNeuron;

  beforeEach(() => {
    vi.clearAllMocks();
    neuron = new ContactPressureNeuron(createTestLogger());
  });

  describe('Config defaults', () => {
    it('should have emitThreshold of 0.2', () => {
      expect(DEFAULT_CONTACT_PRESSURE_CONFIG.emitThreshold).toBe(0.2);
    });

    it('should have emitWhileAbove enabled by default', () => {
      expect(DEFAULT_CONTACT_PRESSURE_CONFIG.emitWhileAbove).toBe(true);
    });

    it('should have refractory period of 30 seconds', () => {
      expect(DEFAULT_CONTACT_PRESSURE_CONFIG.refractoryPeriodMs).toBe(30000);
    });
  });

  describe('Emission based on emitThreshold', () => {
    it('should emit signal on first check when pressure >= emitThreshold', () => {
      // socialDebt=0.6 -> pressure = 0.6 * 0.4 = 0.24 (above 0.2 threshold)
      const state = createAgentState({ socialDebt: 0.6 });
      const expectedPressure = calculateExpectedPressure(state);
      expect(expectedPressure).toBeGreaterThanOrEqual(0.2);

      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal).toBeDefined();
      expect(signal?.type).toBe('contact_pressure');
      expect(signal?.metrics.value).toBeCloseTo(expectedPressure, 4);
    });

    it('should NOT emit signal on first check when pressure < emitThreshold', () => {
      // socialDebt=0.3 -> pressure = 0.3 * 0.4 = 0.12 (below 0.2 threshold)
      const state = createAgentState({ socialDebt: 0.3 });
      const expectedPressure = calculateExpectedPressure(state);
      expect(expectedPressure).toBeLessThan(0.2);

      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal).toBeUndefined();
    });

    it('should emit exactly at emitThreshold', () => {
      // socialDebt=0.5 -> pressure = 0.5 * 0.4 = 0.2 (exactly at threshold)
      const state = createAgentState({ socialDebt: 0.5 });
      const expectedPressure = calculateExpectedPressure(state);
      expect(expectedPressure).toBe(0.2);

      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal).toBeDefined();
      expect(signal?.metrics.value).toBe(0.2);
    });
  });

  describe('Continuous emission while above threshold', () => {
    it('should continue emitting while pressure stays above threshold', () => {
      // First emission
      const state = createAgentState({ socialDebt: 1.0 }); // pressure = 0.4
      const signal1 = neuron.check(state, 1.0, 'test-corr-1');
      expect(signal1).toBeDefined();

      // Second emission should still work (after simulating time passing)
      // Note: We can't easily test refractory period without time mocking,
      // so this test verifies the logic path, not timing
      neuron.reset(); // Reset to bypass refractory period
      const signal2 = neuron.check(state, 1.0, 'test-corr-2');
      expect(signal2).toBeDefined();
    });

    it('should stop emitting when pressure drops below threshold', () => {
      // First: above threshold
      const highState = createAgentState({ socialDebt: 1.0 });
      neuron.check(highState, 1.0, 'test-corr-1');

      // Reset to bypass refractory and allow new check
      neuron.reset();

      // Second: below threshold
      const lowState = createAgentState({ socialDebt: 0.3 }); // pressure = 0.12
      const signal = neuron.check(lowState, 1.0, 'test-corr-2');
      expect(signal).toBeUndefined();
    });
  });

  describe('Refractory period', () => {
    it('should NOT emit during refractory period', () => {
      // First emission
      const state = createAgentState({ socialDebt: 1.0 });
      const signal1 = neuron.check(state, 1.0, 'test-corr-1');
      expect(signal1).toBeDefined();

      // Immediate second check should be blocked by refractory period
      const signal2 = neuron.check(state, 1.0, 'test-corr-2');
      expect(signal2).toBeUndefined();
    });

    it('should suppress stable value until keep-alive interval', async () => {
      // Create neuron with very short refractory period for testing
      const fastNeuron = new ContactPressureNeuron(createTestLogger(), {
        refractoryPeriodMs: 10, // 10ms → stable keep-alive = 120ms
      });

      const state = createAgentState({ socialDebt: 1.0 });

      // First emission
      const signal1 = fastNeuron.check(state, 1.0, 'test-corr-1');
      expect(signal1).toBeDefined();

      // Wait for base refractory but not stable keep-alive
      await new Promise((resolve) => setTimeout(resolve, 15));

      // Same value - suppressed until keep-alive
      const signal2 = fastNeuron.check(state, 1.0, 'test-corr-2');
      expect(signal2).toBeUndefined();

      // Wait for stable keep-alive (120ms total)
      await new Promise((resolve) => setTimeout(resolve, 120));

      // Keep-alive fires
      const signal3 = fastNeuron.check(state, 1.0, 'test-corr-3');
      expect(signal3).toBeDefined();
    });

    it('should emit immediately on value change after refractory', async () => {
      const fastNeuron = new ContactPressureNeuron(createTestLogger(), {
        refractoryPeriodMs: 10,
      });

      const state1 = createAgentState({ socialDebt: 1.0 });
      fastNeuron.check(state1, 1.0, 'test-corr-1');

      await new Promise((resolve) => setTimeout(resolve, 15));

      // Changed value - emits immediately
      const state2 = createAgentState({ socialDebt: 0.5 });
      const signal2 = fastNeuron.check(state2, 1.0, 'test-corr-2');
      expect(signal2).toBeDefined();
    });
  });

  describe('emitWhileAbove disabled (change-only mode)', () => {
    it('should only emit on significant change when emitWhileAbove is false', () => {
      const changeOnlyNeuron = new ContactPressureNeuron(createTestLogger(), {
        emitWhileAbove: false,
      });

      // First check at high pressure
      const state1 = createAgentState({ socialDebt: 1.0 });
      const signal1 = changeOnlyNeuron.check(state1, 1.0, 'test-corr-1');
      expect(signal1).toBeDefined(); // First check emits if above threshold

      // Reset to bypass refractory
      changeOnlyNeuron.reset();
      changeOnlyNeuron.check(state1, 1.0, 'test-corr-2'); // Establish baseline

      // Same pressure, no significant change
      const signal2 = changeOnlyNeuron.check(state1, 1.0, 'test-corr-3');
      expect(signal2).toBeUndefined(); // No emission without significant change
    });
  });

  describe('Weber-Fechner change detection', () => {
    it('should emit on significant change even when below emitThreshold', async () => {
      // Use neuron with short refractory and emitWhileAbove=true (default)
      const testNeuron = new ContactPressureNeuron(createTestLogger(), {
        refractoryPeriodMs: 10,
        changeConfig: {
          baseThreshold: 0.1,
          minAbsoluteChange: 0.02,
          maxThreshold: 0.4,
          alertnessInfluence: 0.3,
        },
      });

      // Start below emitThreshold (0.2)
      // socialDebt=0.2 -> pressure = 0.2 * 0.4 = 0.08
      const lowState1 = createAgentState({ socialDebt: 0.2 });
      const pressure1 = calculateExpectedPressure(lowState1);
      expect(pressure1).toBeLessThan(0.2); // Below emitThreshold

      // First check - no emission (below threshold, no previous value for change)
      const signal1 = testNeuron.check(lowState1, 1.0, 'test-corr-1');
      expect(signal1).toBeUndefined();

      // Wait for refractory
      await new Promise((r) => setTimeout(r, 15));

      // Significant change: socialDebt 0.2 -> 0.45 = pressure 0.08 -> 0.18
      // This is 125% relative increase - well above 10% change threshold
      // But still below emitThreshold (0.2)
      const lowState2 = createAgentState({ socialDebt: 0.45 });
      const pressure2 = calculateExpectedPressure(lowState2);
      expect(pressure2).toBeLessThan(0.2); // Still below emitThreshold
      expect(pressure2).toBeGreaterThan(pressure1); // But significantly higher

      // Should emit due to Weber-Fechner change detection
      const signal2 = testNeuron.check(lowState2, 1.0, 'test-corr-2');
      expect(signal2).toBeDefined();
      expect(signal2?.metrics.value).toBeCloseTo(pressure2, 4);
    });

    it('should NOT emit below threshold when change is insignificant', async () => {
      const testNeuron = new ContactPressureNeuron(createTestLogger(), {
        refractoryPeriodMs: 10,
        changeConfig: {
          baseThreshold: 0.1,
          minAbsoluteChange: 0.02,
          maxThreshold: 0.4,
          alertnessInfluence: 0.3,
        },
      });

      // Start below emitThreshold
      const lowState1 = createAgentState({ socialDebt: 0.3 }); // pressure = 0.12
      testNeuron.check(lowState1, 1.0, 'test-corr-1');

      await new Promise((r) => setTimeout(r, 15));

      // Tiny change: socialDebt 0.3 -> 0.31 = pressure 0.12 -> 0.124
      // This is ~3% change, below 10% threshold
      const lowState2 = createAgentState({ socialDebt: 0.31 });
      const signal = testNeuron.check(lowState2, 1.0, 'test-corr-2');

      // Should NOT emit - below emitThreshold AND insignificant change
      expect(signal).toBeUndefined();
    });
  });

  describe('Pressure calculation', () => {
    it('should correctly weight all contributing factors', () => {
      const state = createAgentState({
        socialDebt: 1.0, // weight 0.4
        taskPressure: 1.0, // weight 0.2
        curiosity: 1.0, // weight 0.1
        acquaintancePressure: 1.0, // weight 0.3
      });

      const signal = neuron.check(state, 1.0, 'test-corr-1');

      // All factors at 1.0: 0.4 + 0.2 + 0.1 + 0.3 = 1.0
      expect(signal?.metrics.value).toBe(1.0);
    });

    it('should calculate partial pressure correctly', () => {
      const state = createAgentState({
        socialDebt: 0.5, // 0.5 * 0.4 = 0.2
        taskPressure: 0.5, // 0.5 * 0.2 = 0.1
        curiosity: 0.0,
        acquaintancePressure: 0.0,
      });

      const signal = neuron.check(state, 1.0, 'test-corr-1');

      // (0.2 + 0.1) / 1.0 = 0.3 (weighted average)
      expect(signal?.metrics.value).toBeCloseTo(0.3, 4);
    });

    it('should include contribution metrics in signal', () => {
      const state = createAgentState({ socialDebt: 1.0 });
      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal?.metrics['contrib_socialDebt']).toBeDefined();
      expect(signal?.metrics['contrib_taskPressure']).toBeDefined();
      expect(signal?.metrics['contrib_curiosity']).toBeDefined();
      expect(signal?.metrics['contrib_acquaintancePressure']).toBeDefined();
    });
  });

  describe('Signal properties', () => {
    it('should set high priority when pressure >= highPriorityThreshold', () => {
      // Need pressure >= 0.6 for high priority
      // All factors at 1.0 gives pressure = 1.0
      const state = createAgentState({
        socialDebt: 1.0,
        taskPressure: 1.0,
        curiosity: 1.0,
        acquaintancePressure: 1.0,
      });

      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal?.priority).toBe(1); // Priority.HIGH = 1
    });

    it('should set normal priority when pressure < highPriorityThreshold', () => {
      const state = createAgentState({ socialDebt: 0.6 }); // pressure = 0.24
      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal?.priority).toBe(2); // Priority.NORMAL = 2
    });

    it('should include correlationId in signal', () => {
      const state = createAgentState({ socialDebt: 1.0 });
      const signal = neuron.check(state, 1.0, 'test-correlation-id');

      expect(signal?.correlationId).toBe('test-correlation-id');
    });
  });

  describe('Neuron result tracking', () => {
    it('should store last neuron result for debugging', () => {
      const state = createAgentState({ socialDebt: 1.0 });
      neuron.check(state, 1.0, 'test-corr-1');

      const result = neuron.getLastNeuronResult();

      expect(result).toBeDefined();
      expect(result?.output).toBeCloseTo(0.4, 4); // socialDebt * 0.4
      expect(result?.contributions).toHaveLength(4);
    });
  });

  describe('Backward compatibility', () => {
    it('should migrate userAvailability to acquaintancePressure in weights', () => {
      // Simulate persisted config with old key name
      const legacyNeuron = new ContactPressureNeuron(createTestLogger(), {
        weights: {
          socialDebt: 0.4,
          taskPressure: 0.2,
          curiosity: 0.1,
          userAvailability: 0.3, // Old key name
        } as any, // Cast to any since types don't include old key
      });

      // Should work without NaN - the old key gets migrated
      const state = createAgentState({
        socialDebt: 1.0,
        acquaintancePressure: 1.0,
      });
      const signal = legacyNeuron.check(state, 1.0, 'test-corr-1');

      expect(signal).toBeDefined();
      expect(signal?.metrics.value).not.toBeNaN();
      // With socialDebt=1, acquaintancePressure=1: 1*0.4 + 1*0.3 = 0.7
      expect(signal?.metrics.value).toBeCloseTo(0.7, 2);
    });

    it('should prefer explicit acquaintancePressure over userAvailability', () => {
      // If both keys provided, acquaintancePressure takes precedence
      const neuronWithBoth = new ContactPressureNeuron(createTestLogger(), {
        weights: {
          socialDebt: 0.4,
          taskPressure: 0.2,
          curiosity: 0.1,
          acquaintancePressure: 0.5, // New key with different value
          userAvailability: 0.1, // Old key - should be ignored
        } as any,
      });

      const state = createAgentState({
        socialDebt: 0,
        acquaintancePressure: 1.0,
      });
      const signal = neuronWithBoth.check(state, 1.0, 'test-corr-1');

      // Weighted average: 1.0*0.5 / (0.4+0.2+0.1+0.5) = 0.5/1.2 = 0.417
      // If it used userAvailability (0.1), it would be: 1.0*0.1 / (0.4+0.2+0.1+0.1) = 0.1/0.8 = 0.125
      expect(signal?.metrics.value).toBeCloseTo(0.417, 2); // Uses acquaintancePressure weight
      expect(signal?.metrics.value).not.toBeCloseTo(0.125, 2); // NOT using userAvailability
    });
  });

  describe('Edge cases', () => {
    it('should handle zero pressure state', () => {
      const state = createAgentState(); // All factors at 0
      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal).toBeUndefined();
    });

    it('should clamp values to 0-1 range', () => {
      // Neuron uses clamp internally, test that it handles edge cases
      const state = createAgentState({
        socialDebt: 1.0,
        taskPressure: 1.0,
        curiosity: 1.0,
        acquaintancePressure: 1.0,
      });

      const signal = neuron.check(state, 1.0, 'test-corr-1');

      expect(signal?.metrics.value).toBeLessThanOrEqual(1.0);
      expect(signal?.metrics.value).toBeGreaterThanOrEqual(0);
    });

    it('should handle reset correctly', () => {
      // First check establishes state
      const state = createAgentState({ socialDebt: 1.0 });
      neuron.check(state, 1.0, 'test-corr-1');

      // Reset clears state
      neuron.reset();

      expect(neuron.getLastValue()).toBeUndefined();

      // Next check is like first check again
      const signal = neuron.check(state, 1.0, 'test-corr-2');
      expect(signal).toBeDefined();
    });
  });
});
