import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createThresholdEngine } from '../../src/layers/aggregation/threshold-engine.js';
import { createSignal } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';
import type { SignalAggregate } from '../../src/types/signal.js';
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

describe('ThresholdEngine', () => {
  let engine: ReturnType<typeof createThresholdEngine>;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = createThresholdEngine(mockLogger as any);
  });

  const createAgentState = (overrides: Partial<AgentState> = {}): AgentState => ({
    energy: 0.8,
    socialDebt: 0.1,
    taskPressure: 0,
    curiosity: 0.5,
    acquaintancePressure: 0,
    acquaintancePending: false,
    lastTickAt: new Date(),
    tickInterval: 1000,
    ...overrides,
  });

  describe('Energy gate', () => {
    it('blocks COGNITION wake when energy is below threshold', () => {
      const state = createAgentState({ energy: 0.2 }); // Below 0.3 threshold
      const signals: any[] = [];
      const aggregates: SignalAggregate[] = [];

      const decision = engine.evaluate(signals, aggregates, state);

      expect(decision.shouldWake).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ energy: '0.20' }),
        'Skipping COGNITION wake - energy too low'
      );
    });

    it('allows COGNITION wake when energy is above threshold', () => {
      const state = createAgentState({ energy: 0.5 }); // Above 0.3 threshold
      const signals: any[] = [];
      const aggregates: SignalAggregate[] = [
        {
          type: 'contact_pressure',
          source: 'neuron.contact_pressure',
          currentValue: 0.8, // High pressure
          rateOfChange: 0,
          count: 1,
          maxValue: 0.8,
          minValue: 0.8,
          avgValue: 0.8,
          trend: 'stable',
        },
      ];

      const decision = engine.evaluate(signals, aggregates, state);

      // Should wake because pressure is high and energy is sufficient
      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('threshold_crossed');
    });

    it('always wakes for user messages regardless of energy', () => {
      const state = createAgentState({ energy: 0.1 }); // Very low energy
      const userMessage = createSignal(
        'user_message',
        'sense.telegram',
        { value: 1, confidence: 1 },
        {
          priority: Priority.HIGH,
          data: {
            kind: 'user_message',
            text: 'Hello!',
            chatId: '123',
            userId: '456',
          },
        }
      );
      const signals = [userMessage];
      const aggregates: SignalAggregate[] = [];

      const decision = engine.evaluate(signals, aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('user_message');
      expect(decision.reason).toBe('User sent a message');
    });
  });

  describe('Internal patterns filtering', () => {
    it('does not wake for rate_spike patterns (internal)', () => {
      const state = createAgentState({ energy: 0.8 });
      const rateSpikeSignal = createSignal(
        'pattern_break',
        'meta.pattern_detector',
        { value: 0.8, confidence: 0.8 },
        {
          priority: Priority.NORMAL,
          data: {
            kind: 'pattern',
            patternName: 'rate_spike',
            description: 'energy is decreasing rapidly',
          },
        }
      );
      const signals = [rateSpikeSignal];
      const aggregates: SignalAggregate[] = [];

      const decision = engine.evaluate(signals, aggregates, state);

      // Should NOT wake for internal pattern
      expect(decision.shouldWake).toBe(false);
    });

    it('wakes for sudden_silence patterns (user behavior)', () => {
      const state = createAgentState({ energy: 0.8 });
      const silenceSignal = createSignal(
        'pattern_break',
        'meta.pattern_detector',
        { value: 0.8, confidence: 0.8 },
        {
          priority: Priority.NORMAL,
          data: {
            kind: 'pattern',
            patternName: 'sudden_silence',
            description: 'User was active but has gone quiet',
          },
        }
      );
      const signals = [silenceSignal];
      const aggregates: SignalAggregate[] = [];

      const decision = engine.evaluate(signals, aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('pattern_break');
      expect(decision.reason).toBe('User behavior pattern detected');
    });
  });

  describe('Trigger signals', () => {
    it('provides trigger signal for threshold_crossed wakes', () => {
      const state = createAgentState({ energy: 0.8 });
      const signals: any[] = [];
      const aggregates: SignalAggregate[] = [
        {
          type: 'contact_pressure',
          source: 'neuron.contact_pressure',
          currentValue: 0.9, // Very high pressure
          rateOfChange: 0,
          count: 1,
          maxValue: 0.9,
          minValue: 0.9,
          avgValue: 0.9,
          trend: 'stable',
        },
      ];

      const decision = engine.evaluate(signals, aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.triggerSignals.length).toBeGreaterThan(0);
      expect(decision.triggerSignals[0].type).toBe('threshold_crossed');
    });
  });
});
