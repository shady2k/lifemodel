import { describe, it, expect } from 'vitest';
import {
  neuron,
  createNeuron,
  contactPressureNeuron,
} from '../../src/core/utils/weighted-score.js';

describe('Neuron', () => {
  describe('neuron function', () => {
    it('calculates weighted average correctly', () => {
      const result = neuron([
        { name: 'a', value: 1.0, weight: 0.5 },
        { name: 'b', value: 0.0, weight: 0.5 },
      ]);

      expect(result.output).toBe(0.5);
      expect(result.totalWeight).toBe(1.0);
    });

    it('handles empty inputs', () => {
      const result = neuron([]);

      expect(result.output).toBe(0);
      expect(result.contributions).toHaveLength(0);
    });

    it('clamps values to 0-1 range', () => {
      const result = neuron([
        { name: 'high', value: 1.5, weight: 0.5 },
        { name: 'low', value: -0.5, weight: 0.5 },
      ]);

      expect(result.output).toBe(0.5); // (1.0 + 0.0) / 2
    });

    it('provides contribution trace for explainability', () => {
      const result = neuron([
        { name: 'socialDebt', value: 0.8, weight: 0.7 },
        { name: 'taskPressure', value: 0.3, weight: 0.3 },
      ]);

      expect(result.contributions).toHaveLength(2);
      expect(result.contributions[0].name).toBe('socialDebt');
      expect(result.contributions[0].contribution).toBeCloseTo(0.56); // 0.8 * 0.7
      expect(result.contributions[1].contribution).toBeCloseTo(0.09); // 0.3 * 0.3
    });
  });

  describe('createNeuron factory', () => {
    it('creates reusable neuron with fixed weights', () => {
      const myNeuron = createNeuron({
        factor1: 0.6,
        factor2: 0.4,
      });

      const result = myNeuron({
        factor1: 1.0,
        factor2: 0.5,
      });

      // (1.0 * 0.6 + 0.5 * 0.4) / (0.6 + 0.4) = 0.8
      expect(result.output).toBeCloseTo(0.8);
    });

    it('handles missing values as 0', () => {
      const myNeuron = createNeuron({
        required: 0.5,
        optional: 0.5,
      });

      const result = myNeuron({
        required: 1.0,
        // optional not provided
      });

      // (1.0 * 0.5 + 0 * 0.5) / 1.0 = 0.5
      expect(result.output).toBe(0.5);
    });
  });

  describe('contactPressureNeuron', () => {
    it('combines contact pressure factors', () => {
      const result = contactPressureNeuron({
        socialDebt: 0.8,
        taskPressure: 0.2,
        curiosity: 0.5,
        userAvailability: 0.9,
      });

      expect(result.output).toBeGreaterThan(0);
      expect(result.output).toBeLessThanOrEqual(1);
      expect(result.contributions).toHaveLength(4);
    });

    it('produces higher output with higher social debt', () => {
      const lowDebt = contactPressureNeuron({
        socialDebt: 0.2,
        taskPressure: 0.2,
        curiosity: 0.5,
        userAvailability: 0.5,
      });

      const highDebt = contactPressureNeuron({
        socialDebt: 0.9,
        taskPressure: 0.2,
        curiosity: 0.5,
        userAvailability: 0.5,
      });

      expect(highDebt.output).toBeGreaterThan(lowDebt.output);
    });
  });
});

