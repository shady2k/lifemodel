/**
 * Integration tests for social debt management.
 *
 * Tests the full flow from CoreLoop → Agent to verify that:
 * 1. Sending messages reduces social debt
 * 2. Receiving user messages triggers positive feedback
 *
 * Uses in-memory mocks for external dependencies (channels, fs, APIs).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Agent } from '../../src/core/agent.js';
import {
  createTestAgent,
  createMockChannel,
  createMockRecipientRegistry,
} from '../helpers/factories.js';

describe('Social Debt Integration', () => {
  let agent: Agent;
  let mockChannel: ReturnType<typeof createMockChannel>;
  let mockRecipientRegistry: ReturnType<typeof createMockRecipientRegistry>;

  beforeEach(() => {
    // Create real agent with high initial social debt using factory
    const testSetup = createTestAgent({
      initialState: { socialDebt: 1.0, energy: 0.8 },
    });
    agent = testSetup.agent;

    // Create mocks using factories
    mockChannel = createMockChannel();
    mockRecipientRegistry = createMockRecipientRegistry();
  });

  describe('SEND_MESSAGE intent processing', () => {
    it('reduces social debt when message is sent successfully', async () => {
      const initialDebt = agent.getState().socialDebt;
      expect(initialDebt).toBe(1.0);

      // Simulate CoreLoop processing SEND_MESSAGE intent
      const route = mockRecipientRegistry.resolve('rcpt_user123');
      expect(route).toBeTruthy();

      const success = await mockChannel.sendMessage(route!.destination, 'Hello!');
      expect(success).toBe(true);

      // This is what CoreLoop does after successful send
      if (success) {
        agent.onMessageSent();
      }

      // Verify social debt was reduced
      expect(agent.getState().socialDebt).toBe(0.6); // 1.0 - 0.4
    });

    it('does NOT reduce social debt when message fails', async () => {
      // Create failing channel
      mockChannel = createMockChannel({ sendSuccess: false });

      const initialDebt = agent.getState().socialDebt;

      const route = mockRecipientRegistry.resolve('rcpt_user123');
      const success = await mockChannel.sendMessage(route!.destination, 'Hello');

      if (success) {
        agent.onMessageSent();
      }

      expect(agent.getState().socialDebt).toBe(initialDebt);
    });

    it('does NOT reduce social debt when recipient not found', async () => {
      // Create registry that fails to resolve
      mockRecipientRegistry = createMockRecipientRegistry({ resolveSuccess: false });

      const initialDebt = agent.getState().socialDebt;

      const route = mockRecipientRegistry.resolve('rcpt_unknown');

      // CoreLoop wouldn't send if route is null
      if (route) {
        const success = await mockChannel.sendMessage(route.destination, 'Hello');
        if (success) {
          agent.onMessageSent();
        }
      }

      expect(agent.getState().socialDebt).toBe(initialDebt);
    });

    it('reduces debt and drains energy on send', async () => {
      const initialEnergy = agent.getState().energy;
      const initialDebt = agent.getState().socialDebt;

      const success = await mockChannel.sendMessage('123', 'Hello');
      if (success) {
        agent.onMessageSent();
      }

      const state = agent.getState();
      expect(state.energy).toBeLessThan(initialEnergy);
      expect(state.socialDebt).toBeLessThan(initialDebt);
    });
  });

  describe('user_message signal processing', () => {
    it('reduces social debt and recharges energy when user responds', () => {
      // First, send a message
      agent.onMessageSent();

      const debtAfterSend = agent.getState().socialDebt;
      const energyAfterSend = agent.getState().energy;

      // Simulate CoreLoop.processUserMessageSignal
      agent.onPositiveFeedback();

      const finalState = agent.getState();
      expect(finalState.socialDebt).toBeLessThan(debtAfterSend);
      expect(finalState.socialDebt).toBe(0.5); // 0.6 - 0.1
      expect(finalState.energy).toBeGreaterThan(energyAfterSend);
    });
  });

  describe('full interaction cycle', () => {
    it('models complete human-like social debt lifecycle', async () => {
      // Initial state
      expect(agent.getState().socialDebt).toBe(1.0);
      expect(agent.getState().energy).toBe(0.8);

      // Step 1: Time passes (already at max)
      agent.tick();
      agent.tick();
      expect(agent.getState().socialDebt).toBe(1.0);

      // Step 2: Agent sends proactive message
      const success = await mockChannel.sendMessage('123', 'Hi!');
      expect(success).toBe(true);
      agent.onMessageSent();

      const afterSend = agent.getState();
      expect(afterSend.socialDebt).toBeCloseTo(0.6, 2);
      expect(afterSend.energy).toBeLessThan(0.8);

      // Step 3: User responds
      agent.onPositiveFeedback();

      const afterResponse = agent.getState();
      expect(afterResponse.socialDebt).toBeCloseTo(0.5, 2);
      expect(afterResponse.energy).toBeGreaterThan(afterSend.energy);

      // Step 4: Time passes, debt accumulates
      for (let i = 0; i < 20; i++) {
        agent.tick();
      }

      expect(agent.getState().socialDebt).toBeCloseTo(0.6, 2);

      // Step 5: Agent reaches out again
      agent.onMessageSent();
      expect(agent.getState().socialDebt).toBeCloseTo(0.2, 2);
    });

    it('prevents spam by requiring debt to rebuild', () => {
      agent.onMessageSent(); // 1.0 → 0.6
      agent.onMessageSent(); // 0.6 → 0.2
      agent.onMessageSent(); // 0.2 → 0 (clamped)

      expect(agent.getState().socialDebt).toBe(0);
      // With debt at 0, contact_pressure would be very low = no spam
    });
  });

  describe('edge cases', () => {
    it('handles multiple rapid messages without going negative', () => {
      for (let i = 0; i < 10; i++) {
        agent.onMessageSent();
      }
      expect(agent.getState().socialDebt).toBe(0);
    });

    it('handles interleaved sends and receives', () => {
      agent.onMessageSent();      // 1.0 → 0.6
      agent.onPositiveFeedback(); // 0.6 → 0.5
      agent.tick();               // 0.5 → 0.505
      agent.onMessageSent();      // 0.505 → 0.105
      agent.onPositiveFeedback(); // 0.105 → 0.005
      agent.tick();               // 0.005 → 0.01

      const finalDebt = agent.getState().socialDebt;
      expect(finalDebt).toBeGreaterThan(0);
      expect(finalDebt).toBeLessThan(0.1);
    });
  });
});
