/**
 * Tests for AutonomicProcessor dynamic neuron registration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAutonomicProcessor } from '../../../src/layers/autonomic/processor.js';
import type { Neuron } from '../../../src/layers/autonomic/neuron-registry.js';
import { createMockLogger, createAgentState } from '../../helpers/factories.js';
import type { Signal } from '../../../src/types/signal.js';

/**
 * Create a mock neuron for testing.
 */
function createMockNeuron(
  id: string,
  options: {
    signalValue?: number;
    shouldEmit?: boolean;
  } = {}
): Neuron {
  const { signalValue = 0.5, shouldEmit = true } = options;

  return {
    id,
    signalType: 'contact_pressure',
    source: `neuron.${id}`,
    description: `Mock neuron ${id}`,
    check: vi.fn((_state, _alertness, correlationId): Signal | undefined => {
      if (!shouldEmit) return undefined;
      return {
        id: `sig-${id}-${correlationId}`,
        type: 'contact_pressure',
        source: `neuron.${id}`,
        timestamp: new Date(),
        priority: 2,
        metrics: { value: signalValue, confidence: 1 },
        data: { kind: 'test' },
        expiresAt: new Date(Date.now() + 60000),
      };
    }),
    reset: vi.fn(),
    getLastValue: vi.fn().mockReturnValue(signalValue),
  };
}

/**
 * Create a mock AlertnessNeuron for testing.
 */
function createMockAlertnessNeuron(alertnessValue = 0.5): Neuron & {
  getCurrentAlertness: ReturnType<typeof vi.fn>;
  decayActivity: ReturnType<typeof vi.fn>;
  recordActivity: ReturnType<typeof vi.fn>;
} {
  return {
    id: 'alertness',
    signalType: 'alertness',
    source: 'neuron.alertness',
    description: 'Mock AlertnessNeuron',
    check: vi.fn().mockReturnValue(undefined),
    reset: vi.fn(),
    getLastValue: vi.fn().mockReturnValue(alertnessValue),
    getCurrentAlertness: vi.fn().mockReturnValue(alertnessValue),
    decayActivity: vi.fn(),
    recordActivity: vi.fn(),
  };
}

describe('AutonomicProcessor Dynamic Registration', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe('registerNeuron', () => {
    it('queues neuron for registration', () => {
      const processor = createAutonomicProcessor(logger);
      const neuron = createMockNeuron('test-neuron');

      processor.registerNeuron(neuron);

      // Should be queued, not immediately registered
      expect(processor.getRegistry().get('test-neuron')).toBeUndefined();
    });

    it('applies registration on applyPendingChanges', () => {
      const processor = createAutonomicProcessor(logger);
      const neuron = createMockNeuron('test-neuron');

      processor.registerNeuron(neuron);
      processor.applyPendingChanges();

      expect(processor.getRegistry().get('test-neuron')).toBe(neuron);
    });

    it('tracks AlertnessNeuron specially', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron(0.7);

      processor.registerNeuron(alertness);
      processor.applyPendingChanges();

      // Validate should now pass
      expect(() => processor.validateRequiredNeurons()).not.toThrow();
    });
  });

  describe('unregisterNeuron', () => {
    it('queues neuron for unregistration', () => {
      const processor = createAutonomicProcessor(logger);
      const neuron = createMockNeuron('test-neuron');

      // Register first
      processor.registerNeuron(neuron);
      processor.applyPendingChanges();
      expect(processor.getRegistry().get('test-neuron')).toBe(neuron);

      // Queue unregistration
      processor.unregisterNeuron('test-neuron');
      // Should still be there until applyPendingChanges
      expect(processor.getRegistry().get('test-neuron')).toBe(neuron);

      // Now apply
      processor.applyPendingChanges();
      expect(processor.getRegistry().get('test-neuron')).toBeUndefined();
    });

    it('deduplicates unregistration requests', () => {
      const processor = createAutonomicProcessor(logger);
      const neuron = createMockNeuron('test-neuron');

      processor.registerNeuron(neuron);
      processor.applyPendingChanges();

      // Queue multiple unregistrations
      processor.unregisterNeuron('test-neuron');
      processor.unregisterNeuron('test-neuron');
      processor.unregisterNeuron('test-neuron');

      // Should work without issues
      expect(() => processor.applyPendingChanges()).not.toThrow();
    });
  });

  describe('applyPendingChanges', () => {
    it('processes unregistrations before registrations (for hot-swap)', () => {
      const processor = createAutonomicProcessor(logger);
      const oldNeuron = createMockNeuron('swappable', { signalValue: 0.3 });
      const newNeuron = createMockNeuron('swappable', { signalValue: 0.7 });

      // Register old
      processor.registerNeuron(oldNeuron);
      processor.applyPendingChanges();

      // Queue unregister old, register new (simulates hot-swap)
      processor.unregisterNeuron('swappable');
      processor.registerNeuron(newNeuron);
      processor.applyPendingChanges();

      // New neuron should be registered
      const registered = processor.getRegistry().get('swappable');
      expect(registered).toBe(newNeuron);
      expect(registered?.getLastValue()).toBe(0.7);
    });

    it('clears pending queues after applying', () => {
      const processor = createAutonomicProcessor(logger);
      const neuron = createMockNeuron('test');

      processor.registerNeuron(neuron);
      processor.applyPendingChanges();

      // Second apply should be a no-op
      processor.applyPendingChanges();
      expect(processor.getRegistry().get('test')).toBe(neuron);
    });

    it('is idempotent when called multiple times on empty queues', () => {
      const processor = createAutonomicProcessor(logger);

      // Should not throw
      processor.applyPendingChanges();
      processor.applyPendingChanges();
      processor.applyPendingChanges();
    });
  });

  describe('validateRequiredNeurons', () => {
    it('throws if AlertnessNeuron is not registered', () => {
      const processor = createAutonomicProcessor(logger);

      expect(() => processor.validateRequiredNeurons()).toThrow('AlertnessNeuron');
    });

    it('passes if AlertnessNeuron is registered', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron();

      processor.registerNeuron(alertness);
      processor.applyPendingChanges();

      expect(() => processor.validateRequiredNeurons()).not.toThrow();
      expect(processor.isValidated()).toBe(true);
    });

    it('applies pending changes before validating', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron();

      // Register but don't apply yet
      processor.registerNeuron(alertness);

      // Validate should apply changes first, then pass
      expect(() => processor.validateRequiredNeurons()).not.toThrow();
    });
  });

  describe('process', () => {
    it('applies pending changes at start of tick', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron();
      const testNeuron = createMockNeuron('test');

      // Set up AlertnessNeuron first (required)
      processor.registerNeuron(alertness);
      processor.validateRequiredNeurons();

      // Queue a new neuron
      processor.registerNeuron(testNeuron);

      // Process should apply pending changes first
      const state = createAgentState();
      processor.process(state, [], 'tick-1');

      // Neuron should now be registered
      expect(processor.getRegistry().get('test')).toBe(testNeuron);
    });

    it('throws if AlertnessNeuron missing after validation', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron();

      // Register and validate
      processor.registerNeuron(alertness);
      processor.validateRequiredNeurons();

      // Now unregister it
      processor.unregisterNeuron('alertness');
      processor.applyPendingChanges();

      // Next process should throw
      const state = createAgentState();
      expect(() => processor.process(state, [], 'tick-1')).toThrow('AlertnessNeuron missing');
    });

    it('calls check on all registered neurons', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron();
      const neuron1 = createMockNeuron('n1');
      const neuron2 = createMockNeuron('n2');

      processor.registerNeuron(alertness);
      processor.registerNeuron(neuron1);
      processor.registerNeuron(neuron2);
      processor.validateRequiredNeurons();

      const state = createAgentState();
      processor.process(state, [], 'tick-1');

      expect(neuron1.check).toHaveBeenCalled();
      expect(neuron2.check).toHaveBeenCalled();
    });

    it('includes signals from registered neurons in result', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron();
      const neuron = createMockNeuron('test', { shouldEmit: true });

      processor.registerNeuron(alertness);
      processor.registerNeuron(neuron);
      processor.validateRequiredNeurons();

      const state = createAgentState();
      const result = processor.process(state, [], 'tick-1');

      // Should include the signal from the neuron
      expect(result.signals.some((s) => s.source === 'neuron.test')).toBe(true);
    });
  });

  describe('getAlertness', () => {
    it('throws if AlertnessNeuron not registered', () => {
      const processor = createAutonomicProcessor(logger);
      const state = createAgentState();

      expect(() => processor.getAlertness(state)).toThrow('AlertnessNeuron not registered');
    });

    it('returns alertness value from neuron', () => {
      const processor = createAutonomicProcessor(logger);
      const alertness = createMockAlertnessNeuron(0.8);

      processor.registerNeuron(alertness);
      processor.validateRequiredNeurons();

      const state = createAgentState();
      expect(processor.getAlertness(state)).toBe(0.8);
    });
  });
});
