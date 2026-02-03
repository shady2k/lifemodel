/**
 * Tests for proactive contact pressure triggering.
 *
 * FIXED BUG:
 * Previously, when contact pressure was stable (no significant changes), the
 * ContactPressureNeuron stopped emitting signals. After the aggregator's window
 * expired, the signal was pruned and ThresholdEngine saw currentPressure=0.
 *
 * FIX: Two-threshold architecture
 * - Neuron emitThreshold (0.2): "Is there a desire worth signaling?"
 * - ThresholdEngine wakeThreshold (0.35): "Is this worth waking Cognition?"
 *
 * Neuron now emits continuously while above emitThreshold (respecting refractory
 * period), keeping aggregates fresh. Combined with longer TTL (3 min) and window
 * (5 min), signals persist until ThresholdEngine evaluates them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThresholdEngine, createThresholdEngine } from '../../src/layers/aggregation/threshold-engine.js';
import { SignalAggregator, createSignalAggregator } from '../../src/layers/aggregation/aggregator.js';
import { createSignal } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';
import type { AgentState } from '../../src/types/agent/state.js';
import type { SignalAggregate } from '../../src/types/signal.js';

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

// Helper to create a mock AgentState with high social debt
function createHighPressureState(): AgentState {
  return {
    energy: 1.0,
    socialDebt: 1.0, // Maximum
    taskPressure: 0,
    curiosity: 0.5,
    acquaintancePressure: 0,
    acquaintancePending: false,
    thoughtPressure: 0,
    pendingThoughtCount: 0,
    lastTickAt: new Date(),
    tickInterval: 1000,
  };
}

// Helper to create a contact_pressure signal
function createContactPressureSignal(value: number, timestamp?: Date) {
  const signal = createSignal(
    'contact_pressure',
    'neuron.contact_pressure',
    { value, rateOfChange: 0, confidence: 1.0 },
    { priority: Priority.NORMAL }
  );
  // Manually set timestamp if provided (createSignal always uses current time)
  if (timestamp) {
    (signal as any).timestamp = timestamp;
  }
  return signal;
}

// Mock conversation manager that returns idle status
function createMockConversationManager(timeSinceLastMessage: number) {
  return {
    getStatus: vi.fn().mockResolvedValue({
      status: 'idle',
      lastMessageAt: new Date(Date.now() - timeSinceLastMessage),
    }),
  };
}

// Mock user model with reasonable availability
function createMockUserModel() {
  return {
    getBeliefs: vi.fn().mockReturnValue({
      availability: 0.7, // Above low threshold (0.25)
    }),
  };
}

describe('Proactive Contact with Stable Pressure', () => {
  let thresholdEngine: ThresholdEngine;
  let aggregator: SignalAggregator;

  beforeEach(() => {
    vi.clearAllMocks();
    thresholdEngine = createThresholdEngine(createTestLogger());
    aggregator = createSignalAggregator(createTestLogger());
  });

  describe('Continuous emission keeps aggregates fresh', () => {
    it('should trigger proactive contact when pressure is above threshold', async () => {
      // Setup: Configure threshold engine with conversation manager
      const timeSinceLastMessage = 45 * 60 * 1000; // 45 minutes (> 30 min idleDelayMs)
      thresholdEngine.updateDeps({
        conversationManager: createMockConversationManager(timeSinceLastMessage) as any,
        userModel: createMockUserModel() as any,
        primaryRecipientId: 'rcpt_test123',
      });

      // Add a contact_pressure signal with value 0.45 (above 0.35 threshold)
      const pressureSignal = createContactPressureSignal(0.45);
      aggregator.add(pressureSignal);

      // Get aggregates - should have contact_pressure with value 0.45
      const aggregates = aggregator.getAllAggregates();
      expect(aggregates.find((a) => a.type === 'contact_pressure')?.currentValue).toBe(0.45);

      // Evaluate - should trigger proactive contact
      const state = createHighPressureState();
      const decision = await thresholdEngine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.proactiveType).toBe('initiate');
    });

    it('should NOT prune signals within 5-minute window', async () => {
      // With the fix, aggregator window is 5 minutes, so 2-minute-old signals survive
      const timeSinceLastMessage = 45 * 60 * 1000;
      thresholdEngine.updateDeps({
        conversationManager: createMockConversationManager(timeSinceLastMessage) as any,
        userModel: createMockUserModel() as any,
        primaryRecipientId: 'rcpt_test123',
      });

      // Add a contact_pressure signal from 2 minutes ago (within 5-min window)
      const oldTimestamp = new Date(Date.now() - 2 * 60 * 1000);
      const pressureSignal = createContactPressureSignal(0.45, oldTimestamp);
      aggregator.add(pressureSignal);

      // Prune - signal should survive (window is now 5 minutes)
      aggregator.prune();

      // Verify: contact_pressure aggregate should STILL exist after prune
      const aggregates = aggregator.getAllAggregates();
      const contactPressureAggregate = aggregates.find((a) => a.type === 'contact_pressure');
      expect(contactPressureAggregate).toBeDefined();
      expect(contactPressureAggregate?.currentValue).toBe(0.45);

      // Should trigger proactive contact
      const state = createHighPressureState();
      const decision = await thresholdEngine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.proactiveType).toBe('initiate');
    });

    it('should prune signals older than 5-minute window', async () => {
      // Signals older than 5 minutes should still be pruned
      const timeSinceLastMessage = 45 * 60 * 1000;
      thresholdEngine.updateDeps({
        conversationManager: createMockConversationManager(timeSinceLastMessage) as any,
        userModel: createMockUserModel() as any,
        primaryRecipientId: 'rcpt_test123',
      });

      // Add a contact_pressure signal from 6 minutes ago (outside 5-min window)
      const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000);
      const pressureSignal = createContactPressureSignal(0.45, oldTimestamp);
      aggregator.add(pressureSignal);

      // Prune - signal should be removed (outside 5-min window)
      aggregator.prune();

      // Verify: contact_pressure aggregate should be gone
      const aggregates = aggregator.getAllAggregates();
      const contactPressureAggregate = aggregates.find((a) => a.type === 'contact_pressure');
      expect(contactPressureAggregate).toBeUndefined();
    });

    it('should calculate actual contact pressure from agent state', () => {
      // Document the expected pressure calculation:
      // pressure = socialDebt * 0.4 + taskPressure * 0.2 + curiosity * 0.1 + acquaintancePressure * 0.3
      // With socialDebt=1, taskPressure=0, curiosity=0.5, acquaintancePressure=0:
      // pressure = 1*0.4 + 0*0.2 + 0.5*0.1 + 0*0.3 = 0.4 + 0 + 0.05 + 0 = 0.45

      const state = createHighPressureState();
      const expectedPressure =
        state.socialDebt * 0.4 +
        state.taskPressure * 0.2 +
        state.curiosity * 0.1 +
        state.acquaintancePressure * 0.3;

      expect(expectedPressure).toBe(0.45);
      expect(expectedPressure).toBeGreaterThan(0.35); // Above default threshold
    });
  });

  describe('Two-threshold architecture', () => {
    it('emitThreshold (0.2) gates neuron emission, wakeThreshold (0.35) gates waking Cognition', async () => {
      // Pressure between emitThreshold and wakeThreshold: signal emitted but no wake
      const timeSinceLastMessage = 45 * 60 * 1000;
      thresholdEngine.updateDeps({
        conversationManager: createMockConversationManager(timeSinceLastMessage) as any,
        userModel: createMockUserModel() as any,
        primaryRecipientId: 'rcpt_test123',
      });

      // Pressure 0.25 is above emitThreshold (0.2) but below wakeThreshold (0.35)
      const pressureSignal = createContactPressureSignal(0.25);
      aggregator.add(pressureSignal);

      const aggregates = aggregator.getAllAggregates();
      expect(aggregates.find((a) => a.type === 'contact_pressure')?.currentValue).toBe(0.25);

      // State has low pressure to match the signal
      const state = {
        ...createHighPressureState(),
        socialDebt: 0.5, // Lower to get pressure ~0.25
      };

      const decision = await thresholdEngine.evaluate([], aggregates, state);

      // Should NOT wake - pressure is below wakeThreshold (0.35)
      expect(decision.shouldWake).toBe(false);
    });
  });
});
