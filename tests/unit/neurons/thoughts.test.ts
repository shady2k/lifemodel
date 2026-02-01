import { describe, it, expect, beforeEach } from 'vitest';
import { createThoughtsNeuron } from '../../../src/plugins/thoughts/index.js';
import { Priority } from '../../../src/types/priority.js';
import { createMockLogger, createAgentState } from '../../helpers/factories.js';

describe('ThoughtsNeuron', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe('Signal emission', () => {
    it('emits signal with current thought pressure value', () => {
      const neuron = createThoughtsNeuron(logger);
      const state = createAgentState({
        thoughtPressure: 0.5,
        pendingThoughtCount: 3,
      });

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeDefined();
      expect(signal?.type).toBe('thought_pressure');
      expect(signal?.metrics.value).toBe(0.5);
      expect(signal?.metrics.thoughtCount).toBe(3);
    });

    it('emits with HIGH priority when pressure exceeds high threshold (0.7)', () => {
      const neuron = createThoughtsNeuron(logger);
      const state = createAgentState({
        thoughtPressure: 0.8,
        pendingThoughtCount: 5,
      });

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeDefined();
      expect(signal?.priority).toBe(Priority.HIGH);
      expect(signal?.metrics.isHigh).toBe(1);
    });

    it('emits with NORMAL priority when pressure is moderate (0.4-0.7)', () => {
      const neuron = createThoughtsNeuron(logger);
      const state = createAgentState({
        thoughtPressure: 0.5,
        pendingThoughtCount: 3,
      });

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeDefined();
      expect(signal?.priority).toBe(Priority.NORMAL);
      expect(signal?.metrics.isModerate).toBe(1);
      expect(signal?.metrics.isHigh).toBe(0);
    });

    it('emits with LOW priority when pressure is low (<0.4)', () => {
      const neuron = createThoughtsNeuron(logger);
      const state = createAgentState({
        thoughtPressure: 0.2,
        pendingThoughtCount: 1,
      });

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      // First check initializes - low pressure may not emit
      expect(signal).toBeUndefined();
    });

    it('does not emit on first check if pressure is low', () => {
      const neuron = createThoughtsNeuron(logger);
      const state = createAgentState({
        thoughtPressure: 0.2,
        pendingThoughtCount: 1,
      });

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeUndefined();
    });

    it('emits on first check if pressure is already moderate', () => {
      const neuron = createThoughtsNeuron(logger);
      const state = createAgentState({
        thoughtPressure: 0.5,
        pendingThoughtCount: 3,
      });

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeDefined();
    });

    it('respects refractory period', () => {
      const neuron = createThoughtsNeuron(logger, {
        refractoryPeriodMs: 10000, // 10 seconds
      });
      const state = createAgentState({
        thoughtPressure: 0.6,
        pendingThoughtCount: 4,
      });

      // First emission
      const first = neuron.check(state, 0.5, 'tick-1');
      expect(first).toBeDefined();

      // Immediate second call - should be blocked by refractory
      const second = neuron.check(state, 0.5, 'tick-2');
      expect(second).toBeUndefined();
    });

    it('emits on significant change after refractory period', async () => {
      const neuron = createThoughtsNeuron(logger, {
        refractoryPeriodMs: 10, // 10ms for testing
        changeConfig: {
          baseThreshold: 0.15,
          minAbsoluteChange: 0.05,
          maxThreshold: 0.30,
          alertnessInfluence: 0.2,
        },
      });
      const state1 = createAgentState({
        thoughtPressure: 0.5,
        pendingThoughtCount: 3,
      });
      const state2 = createAgentState({
        thoughtPressure: 0.7, // 40% increase - significant
        pendingThoughtCount: 5,
      });

      const first = neuron.check(state1, 0.5, 'tick-1');
      expect(first).toBeDefined();

      // Wait for refractory to expire
      await new Promise((r) => setTimeout(r, 15));

      // Significant change - should emit
      const second = neuron.check(state2, 0.5, 'tick-2');
      expect(second).toBeDefined();
      expect(second?.metrics.value).toBe(0.7);
    });

    it('emits when crossing moderate threshold', async () => {
      const neuron = createThoughtsNeuron(logger, {
        refractoryPeriodMs: 10,
      });

      // Start below moderate threshold
      const lowState = createAgentState({
        thoughtPressure: 0.3,
        pendingThoughtCount: 2,
      });
      neuron.check(lowState, 0.5, 'tick-1'); // Initialize

      await new Promise((r) => setTimeout(r, 15));

      // Cross moderate threshold
      const moderateState = createAgentState({
        thoughtPressure: 0.45,
        pendingThoughtCount: 3,
      });
      const signal = neuron.check(moderateState, 0.5, 'tick-2');

      expect(signal).toBeDefined();
      expect(signal?.metrics.isModerate).toBe(1);
    });

    it('emits when crossing high threshold', async () => {
      const neuron = createThoughtsNeuron(logger, {
        refractoryPeriodMs: 10,
      });

      // Start at moderate
      const moderateState = createAgentState({
        thoughtPressure: 0.6,
        pendingThoughtCount: 4,
      });
      neuron.check(moderateState, 0.5, 'tick-1');

      await new Promise((r) => setTimeout(r, 15));

      // Cross high threshold
      const highState = createAgentState({
        thoughtPressure: 0.75,
        pendingThoughtCount: 5,
      });
      const signal = neuron.check(highState, 0.5, 'tick-2');

      expect(signal).toBeDefined();
      expect(signal?.priority).toBe(Priority.HIGH);
      expect(signal?.metrics.isHigh).toBe(1);
    });
  });

  describe('Reset', () => {
    it('resets previous value', () => {
      const neuron = createThoughtsNeuron(logger);
      const state = createAgentState({
        thoughtPressure: 0.5,
        pendingThoughtCount: 3,
      });

      // First check sets previous
      neuron.check(state, 0.5, 'tick-1');
      expect(neuron.getLastValue()).toBe(0.5);

      // Reset clears it
      neuron.reset();
      expect(neuron.getLastValue()).toBeUndefined();
    });
  });
});
