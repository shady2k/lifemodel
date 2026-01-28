import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgent } from '../../src/core/agent.js';
import { createMetrics } from '../../src/core/metrics.js';

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

describe('Energy Management', () => {
  describe('Energy sync fix', () => {
    it('correctly syncs energy when applying delta intents', () => {
      const metrics = createMetrics();
      const agent = createAgent(
        { logger: mockLogger as any, metrics },
        { initialState: { energy: 0.8 } }
      );

      // Apply a delta intent (like AUTONOMIC does)
      agent.applyIntent({
        type: 'UPDATE_STATE',
        payload: { key: 'energy', value: -0.001, delta: true },
      });

      const state = agent.getState();

      // Energy should be 0.8 - 0.001 = 0.799, NOT 0.05 (clamped -0.001)
      expect(state.energy).toBeCloseTo(0.799, 3);
    });

    it('correctly syncs energy when applying absolute intents', () => {
      const metrics = createMetrics();
      const agent = createAgent(
        { logger: mockLogger as any, metrics },
        { initialState: { energy: 0.8 } }
      );

      // Apply an absolute intent
      agent.applyIntent({
        type: 'UPDATE_STATE',
        payload: { key: 'energy', value: 0.5, delta: false },
      });

      const state = agent.getState();
      expect(state.energy).toBe(0.5);
    });

    it('clamps energy to valid range on delta', () => {
      const metrics = createMetrics();
      const agent = createAgent(
        { logger: mockLogger as any, metrics },
        { initialState: { energy: 0.1 } }
      );

      // Apply large negative delta
      agent.applyIntent({
        type: 'UPDATE_STATE',
        payload: { key: 'energy', value: -0.5, delta: true },
      });

      const state = agent.getState();
      // Should be clamped to 0, not negative
      expect(state.energy).toBeGreaterThanOrEqual(0);
    });

    it('maintains energy consistency after multiple deltas', () => {
      const metrics = createMetrics();
      const agent = createAgent(
        { logger: mockLogger as any, metrics },
        { initialState: { energy: 0.8 } }
      );

      // Apply multiple small deltas (like during normal operation)
      for (let i = 0; i < 10; i++) {
        agent.applyIntent({
          type: 'UPDATE_STATE',
          payload: { key: 'energy', value: -0.001, delta: true },
        });
      }

      const state = agent.getState();
      // Should be approximately 0.8 - (10 * 0.001) = 0.79
      expect(state.energy).toBeCloseTo(0.79, 2);
    });
  });
});
