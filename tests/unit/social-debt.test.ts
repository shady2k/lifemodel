import { describe, it, expect } from 'vitest';
import { createTestAgent } from '../helpers/factories.js';

describe('Social Debt Management', () => {
  describe('onMessageSent - agent reaches out', () => {
    it('reduces socialDebt when agent sends a message', () => {
      const { agent } = createTestAgent({
        initialState: { socialDebt: 1.0 },
      });

      agent.onMessageSent();

      const state = agent.getState();
      expect(state.socialDebt).toBeCloseTo(0.6, 2);
    });

    it('clamps socialDebt to minimum 0', () => {
      const { agent } = createTestAgent({
        initialState: { socialDebt: 0.2 },
      });

      agent.onMessageSent();

      const state = agent.getState();
      expect(state.socialDebt).toBe(0);
    });

    it('can be called multiple times with cumulative effect', () => {
      const { agent } = createTestAgent({
        initialState: { socialDebt: 1.0 },
      });

      agent.onMessageSent(); // 1.0 -> 0.6
      agent.onMessageSent(); // 0.6 -> 0.2

      const state = agent.getState();
      expect(state.socialDebt).toBeCloseTo(0.2, 2);
    });
  });

  describe('onPositiveFeedback - user responds', () => {
    it('reduces socialDebt when user responds', () => {
      const { agent } = createTestAgent({
        initialState: { socialDebt: 0.5, energy: 0.5 },
      });

      agent.onPositiveFeedback();

      const state = agent.getState();
      expect(state.socialDebt).toBeCloseTo(0.4, 2);
      expect(state.energy).toBeGreaterThan(0.5);
    });
  });

  describe('combined flow - human-like interaction cycle', () => {
    it('models realistic social debt cycle', () => {
      const { agent } = createTestAgent({
        initialState: { socialDebt: 1.0, energy: 0.8 },
      });

      // 1. Agent reaches out (big relief, drains some energy)
      agent.onMessageSent();
      expect(agent.getState().socialDebt).toBeCloseTo(0.6, 2);
      const energyAfterSend = agent.getState().energy;
      expect(energyAfterSend).toBeLessThan(0.8);

      // 2. User responds (bonus debt reduction + energy recharge)
      agent.onPositiveFeedback();
      expect(agent.getState().socialDebt).toBeCloseTo(0.5, 2);
      expect(agent.getState().energy).toBeGreaterThan(energyAfterSend);

      // 3. Time passes - debt accumulates again
      agent.tick(); // +0.005
      agent.tick(); // +0.005
      expect(agent.getState().socialDebt).toBeCloseTo(0.51, 2);
    });
  });
});
