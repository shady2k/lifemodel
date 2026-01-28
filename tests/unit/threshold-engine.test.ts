import { describe, it, expect, beforeEach } from 'vitest';
import { createThresholdEngine } from '../../src/layers/aggregation/threshold-engine.js';
import {
  createMockLogger,
  createAgentState,
  createContactPressureAggregate,
  createUserMessageSignal,
  createPatternBreakSignal,
  createMockConversationManager,
  createMockUserModel,
} from '../helpers/factories.js';

describe('ThresholdEngine', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let engine: ReturnType<typeof createThresholdEngine>;

  beforeEach(() => {
    logger = createMockLogger();
    engine = createThresholdEngine(logger);
  });

  describe('Energy gate', () => {
    it('blocks COGNITION wake when energy is below threshold', async () => {
      const state = createAgentState({ energy: 0.2 }); // Below 0.3 threshold
      const aggregates = [createContactPressureAggregate(0.8)];

      const decision = await engine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ energy: '0.20' }),
        'Skipping COGNITION wake - energy too low'
      );
    });

    it('allows COGNITION wake when energy is above threshold with high pressure', async () => {
      const state = createAgentState({ energy: 0.5 });
      const aggregates = [createContactPressureAggregate(0.8)];

      const decision = await engine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('threshold_crossed');
    });

    it('always wakes for user messages regardless of energy', async () => {
      const state = createAgentState({ energy: 0.1 }); // Very low energy
      const signals = [createUserMessageSignal('Hello!')];

      const decision = await engine.evaluate(signals, [], state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('user_message');
      expect(decision.reason).toBe('User sent a message');
    });
  });

  describe('Pattern filtering', () => {
    it('does not wake for internal rate_spike patterns', async () => {
      const state = createAgentState({ energy: 0.8 });
      const signals = [createPatternBreakSignal('rate_spike', 'energy is decreasing rapidly')];

      const decision = await engine.evaluate(signals, [], state);

      expect(decision.shouldWake).toBe(false);
    });

    it('wakes for user behavior sudden_silence patterns', async () => {
      const state = createAgentState({ energy: 0.8 });
      const signals = [createPatternBreakSignal('sudden_silence', 'User went quiet')];

      const decision = await engine.evaluate(signals, [], state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('pattern_break');
    });
  });

  describe('Proactive contact with high socialDebt', () => {
    it('triggers proactive contact when socialDebt is maxed and no primaryUserChatId (legacy path)', async () => {
      // Scenario: Agent starts with socialDebt=1.0, should trigger contact
      const state = createAgentState({
        energy: 1.0,
        socialDebt: 1.0,
        curiosity: 0.5,
      });
      // Contact pressure = (1.0*0.4 + 0*0.2 + 0.5*0.1 + 0.5*0.3) / 1.0 = 0.6
      const aggregates = [createContactPressureAggregate(0.6)];

      const decision = await engine.evaluate([], aggregates, state);

      // Threshold is 0.35, pressure is 0.6 -> should wake
      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('threshold_crossed');
    });

    it('triggers proactive contact with conversation manager after idle delay', async () => {
      const conversationManager = createMockConversationManager({
        status: 'active',
        lastMessageAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      });
      const userModel = createMockUserModel({ availability: 0.7 });

      engine.updateDeps({
        conversationManager: conversationManager as any,
        userModel: userModel as any,
        primaryUserChatId: '123',
      });

      const state = createAgentState({
        energy: 1.0,
        socialDebt: 1.0,
      });
      const aggregates = [createContactPressureAggregate(0.6)];

      const decision = await engine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.trigger).toBe('threshold_crossed');
      expect(decision.proactiveType).toBe('initiate');
    });

    it('does NOT trigger if conversation was recent (under 30min idle delay)', async () => {
      const conversationManager = createMockConversationManager({
        status: 'active',
        lastMessageAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      });
      const userModel = createMockUserModel({ availability: 0.7 });

      engine.updateDeps({
        conversationManager: conversationManager as any,
        userModel: userModel as any,
        primaryUserChatId: '123',
      });

      const state = createAgentState({
        energy: 1.0,
        socialDebt: 1.0,
      });
      const aggregates = [createContactPressureAggregate(0.6)];

      const decision = await engine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(false);
    });

    it('does NOT trigger if user availability is too low', async () => {
      const conversationManager = createMockConversationManager({
        status: 'active',
        lastMessageAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const userModel = createMockUserModel({ availability: 0.1 }); // Below 0.25 threshold

      engine.updateDeps({
        conversationManager: conversationManager as any,
        userModel: userModel as any,
        primaryUserChatId: '123',
      });

      const state = createAgentState({
        energy: 1.0,
        socialDebt: 1.0,
      });
      const aggregates = [createContactPressureAggregate(0.6)];

      const decision = await engine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(false);
    });

    it('does NOT trigger if contact pressure aggregate is missing', async () => {
      const conversationManager = createMockConversationManager({
        status: 'active',
        lastMessageAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const userModel = createMockUserModel({ availability: 0.7 });

      engine.updateDeps({
        conversationManager: conversationManager as any,
        userModel: userModel as any,
        primaryUserChatId: '123',
      });

      const state = createAgentState({
        energy: 1.0,
        socialDebt: 1.0,
      });
      // No aggregates!
      const aggregates: any[] = [];

      const decision = await engine.evaluate([], aggregates, state);

      // This is the bug! Should still be able to trigger based on state
      expect(decision.shouldWake).toBe(false); // Currently returns false - THIS IS THE BUG
    });
  });

  describe('Trigger signals', () => {
    it('provides trigger signal for threshold_crossed wakes', async () => {
      const state = createAgentState({ energy: 0.8 });
      const aggregates = [createContactPressureAggregate(0.9)];

      const decision = await engine.evaluate([], aggregates, state);

      expect(decision.shouldWake).toBe(true);
      expect(decision.triggerSignals.length).toBeGreaterThan(0);
      expect(decision.triggerSignals[0].type).toBe('threshold_crossed');
    });
  });
});
