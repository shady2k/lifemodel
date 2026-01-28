import { describe, it, expect, beforeEach } from 'vitest';
import { createContactPressureNeuron } from '../../../src/plugins/neurons/contact-pressure.js';
import { Priority } from '../../../src/types/priority.js';
import { createMockLogger, createAgentState } from '../../helpers/factories.js';

describe('ContactPressureNeuron', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe('Signal emission', () => {
    it('emits signal with current pressure value', () => {
      const neuron = createContactPressureNeuron(logger);
      const state = createAgentState({
        socialDebt: 1.0,
        energy: 1.0,
        curiosity: 0.5,
        taskPressure: 0,
        acquaintancePressure: 0,
      });
      // Pressure = (1.0*0.4 + 0*0.2 + 0.5*0.1 + 0*0.3) = 0.45

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeDefined();
      expect(signal?.type).toBe('contact_pressure');
      expect(signal?.metrics.value).toBeCloseTo(0.45, 2);
    });

    it('emits with HIGH priority when pressure exceeds threshold', () => {
      const neuron = createContactPressureNeuron(logger);
      const state = createAgentState({
        socialDebt: 1.0,
        curiosity: 1.0,
        taskPressure: 0.5,
        acquaintancePressure: 0.5,
      });
      // Pressure = (1.0*0.4 + 0.5*0.2 + 1.0*0.1 + 0.5*0.3) = 0.75 > 0.6

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeDefined();
      expect(signal?.priority).toBe(Priority.HIGH);
    });

    it('emits with NORMAL priority when pressure below threshold', () => {
      const neuron = createContactPressureNeuron(logger);
      const state = createAgentState({
        socialDebt: 0.5,
        curiosity: 0.3,
        taskPressure: 0,
        acquaintancePressure: 0,
      });
      // Pressure = (0.5*0.4 + 0*0.2 + 0.3*0.1 + 0*0.3) = 0.23 < 0.6

      const signal = neuron.check(state, 0.5, 'test-tick-1');

      expect(signal).toBeDefined();
      expect(signal?.priority).toBe(Priority.NORMAL);
    });

    it('respects refractory period', () => {
      const neuron = createContactPressureNeuron(logger, {
        refractoryPeriodMs: 10000, // 10 seconds
      });
      const state = createAgentState({ socialDebt: 1.0 });

      // First emission
      const first = neuron.check(state, 0.5, 'tick-1');
      expect(first).toBeDefined();

      // Immediate second call - should be blocked by refractory
      const second = neuron.check(state, 0.5, 'tick-2');
      expect(second).toBeUndefined();
    });

    it('emits on every tick after refractory period', async () => {
      const neuron = createContactPressureNeuron(logger, {
        refractoryPeriodMs: 10, // 10ms for testing
      });
      const state = createAgentState({ socialDebt: 1.0 });

      const first = neuron.check(state, 0.5, 'tick-1');
      expect(first).toBeDefined();

      // Wait for refractory to expire
      await new Promise((r) => setTimeout(r, 15));

      const second = neuron.check(state, 0.5, 'tick-2');
      expect(second).toBeDefined();
    });
  });

  describe('Pressure calculation', () => {
    it('calculates pressure from weighted state values', () => {
      const neuron = createContactPressureNeuron(logger);

      // All factors at 1.0
      const maxState = createAgentState({
        socialDebt: 1.0,
        taskPressure: 1.0,
        curiosity: 1.0,
        acquaintancePressure: 1.0,
      });
      const maxSignal = neuron.check(maxState, 0.5, 'tick-1');
      expect(maxSignal?.metrics.value).toBeCloseTo(1.0, 2);
    });

    it('uses custom weights when configured', () => {
      const neuron = createContactPressureNeuron(logger, {
        weights: {
          socialDebt: 1.0, // Only socialDebt matters
          taskPressure: 0,
          curiosity: 0,
          acquaintancePressure: 0,
        },
      });

      const state = createAgentState({
        socialDebt: 0.7,
        taskPressure: 1.0, // Ignored
        curiosity: 1.0, // Ignored
        acquaintancePressure: 1.0, // Ignored
      });

      const signal = neuron.check(state, 0.5, 'tick-1');
      expect(signal?.metrics.value).toBeCloseTo(0.7, 2);
    });
  });
});
