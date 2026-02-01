import { describe, it, expect, beforeEach } from 'vitest';
import { createThresholdEngine } from '../../src/layers/aggregation/threshold-engine.js';
import { createSignal } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';
import { createMockLogger, createAgentState } from '../helpers/factories.js';

describe('ThresholdEngine - thought_pressure handling', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe('High thought pressure wake', () => {
    it('wakes COGNITION when thought_pressure >= 0.7', async () => {
      const engine = createThresholdEngine(logger);
      const state = createAgentState({ energy: 0.8 });

      const thoughtPressureSignal = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.75, confidence: 1.0, thoughtCount: 5 },
        { priority: Priority.HIGH }
      );

      const result = await engine.evaluate([thoughtPressureSignal], [], state);

      expect(result.shouldWake).toBe(true);
      expect(result.trigger).toBe('threshold_crossed');
      expect(result.reason).toContain('High thought pressure');
      expect(result.triggerSignals).toContain(thoughtPressureSignal);
    });

    it('does not wake for thought_pressure < 0.7', async () => {
      const engine = createThresholdEngine(logger);
      const state = createAgentState({ energy: 0.8 });

      const thoughtPressureSignal = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.5, confidence: 1.0, thoughtCount: 3 },
        { priority: Priority.NORMAL }
      );

      const result = await engine.evaluate([thoughtPressureSignal], [], state);

      expect(result.shouldWake).toBe(false);
    });

    it('includes value and threshold in wake decision', async () => {
      const engine = createThresholdEngine(logger);
      const state = createAgentState({ energy: 0.8 });

      const thoughtPressureSignal = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.85, confidence: 1.0, thoughtCount: 6 },
        { priority: Priority.HIGH }
      );

      const result = await engine.evaluate([thoughtPressureSignal], [], state);

      expect(result.value).toBe(0.85);
      expect(result.threshold).toBe(0.7);
    });
  });

  describe('Energy gate', () => {
    it('thought_pressure respects energy gate (unlike thought signals)', async () => {
      const engine = createThresholdEngine(logger, { lowEnergy: 0.2 });
      const state = createAgentState({ energy: 0.1 }); // Very low energy

      const thoughtPressureSignal = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.9, confidence: 1.0, thoughtCount: 7 },
        { priority: Priority.HIGH }
      );

      const result = await engine.evaluate([thoughtPressureSignal], [], state);

      // thought_pressure is blocked by energy gate (unlike raw thought signals)
      expect(result.shouldWake).toBe(false);
    });
  });

  describe('Priority with other signals', () => {
    it('user_message takes priority over thought_pressure', async () => {
      const engine = createThresholdEngine(logger);
      const state = createAgentState({ energy: 0.8 });

      const userMessage = createSignal(
        'user_message',
        'sense.telegram',
        { value: 1, confidence: 1 },
        {
          priority: Priority.HIGH,
          data: { kind: 'user_message', text: 'hello', chatId: '123' },
        }
      );

      const thoughtPressureSignal = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.9, confidence: 1.0, thoughtCount: 7 },
        { priority: Priority.HIGH }
      );

      const result = await engine.evaluate([userMessage, thoughtPressureSignal], [], state);

      expect(result.shouldWake).toBe(true);
      expect(result.trigger).toBe('user_message');
    });

    it('thought signal takes priority over thought_pressure', async () => {
      const engine = createThresholdEngine(logger);
      const state = createAgentState({ energy: 0.8 });

      const thoughtSignal = createSignal(
        'thought',
        'cognition.thought',
        { value: 1, confidence: 1 },
        { priority: Priority.NORMAL, data: { kind: 'thought', content: 'I should...' } }
      );

      const thoughtPressureSignal = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.9, confidence: 1.0, thoughtCount: 7 },
        { priority: Priority.HIGH }
      );

      const result = await engine.evaluate([thoughtSignal, thoughtPressureSignal], [], state);

      expect(result.shouldWake).toBe(true);
      expect(result.trigger).toBe('thought');
    });
  });

  describe('Multiple thought_pressure signals', () => {
    it('uses maximum pressure value when multiple signals present', async () => {
      const engine = createThresholdEngine(logger);
      const state = createAgentState({ energy: 0.8 });

      const lowPressure = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.72, confidence: 1.0, thoughtCount: 4 },
        { priority: Priority.HIGH }
      );

      const highPressure = createSignal(
        'thought_pressure',
        'neuron.thought_pressure',
        { value: 0.88, confidence: 1.0, thoughtCount: 6 },
        { priority: Priority.HIGH }
      );

      const result = await engine.evaluate([lowPressure, highPressure], [], state);

      expect(result.shouldWake).toBe(true);
      expect(result.value).toBe(0.88);
    });
  });
});
