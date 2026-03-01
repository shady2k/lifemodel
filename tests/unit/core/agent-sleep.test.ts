/**
 * Tests for clock-driven sleep mode in the Agent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgent, type Agent } from '../../../src/core/agent.js';
import { createMetrics } from '../../../src/core/metrics.js';
import { createMockLogger } from '../../helpers/factories.js';

describe('Agent sleep mode', () => {
  let agent: Agent;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createAgentWithSchedule(sleepHour: number, wakeHour: number) {
    return createAgent(
      { logger: logger as any, metrics: createMetrics() },
      { sleepSchedule: { sleepHour, wakeHour } }
    );
  }

  describe('clock-driven sleep transitions', () => {
    it('enters sleeping when hour is within sleep window', () => {
      // Set time to 23:30 — within default sleep window (23→8)
      vi.setSystemTime(new Date('2026-03-01T23:30:00'));
      agent = createAgentWithSchedule(23, 8);

      expect(agent.getAlertnessMode()).toBe('awake'); // starts awake
      agent.tick();
      expect(agent.getAlertnessMode()).toBe('sleeping');
    });

    it('stays awake when hour is outside sleep window', () => {
      // Set time to 10:00 — outside sleep window
      vi.setSystemTime(new Date('2026-03-01T10:00:00'));
      agent = createAgentWithSchedule(23, 8);

      agent.tick();
      expect(agent.getAlertnessMode()).toBe('awake');
    });

    it('wakes up when hour exits sleep window', () => {
      // Start sleeping at 23:30
      vi.setSystemTime(new Date('2026-03-01T23:30:00'));
      agent = createAgentWithSchedule(23, 8);
      agent.tick();
      expect(agent.getAlertnessMode()).toBe('sleeping');

      // Advance to 8:30 — past wake hour
      vi.setSystemTime(new Date('2026-03-02T08:30:00'));
      agent.tick();
      expect(agent.getAlertnessMode()).toBe('awake');
    });

    it('never sleeps when sleepHour === wakeHour', () => {
      vi.setSystemTime(new Date('2026-03-01T02:00:00'));
      agent = createAgentWithSchedule(5, 5); // 0-width window

      agent.tick();
      expect(agent.getAlertnessMode()).toBe('awake');

      vi.setSystemTime(new Date('2026-03-01T05:00:00'));
      agent.tick();
      expect(agent.getAlertnessMode()).toBe('awake');
    });
  });

  describe('disturbance wake', () => {
    it('wakes agent and sets grace period', () => {
      vi.setSystemTime(new Date('2026-03-01T01:00:00'));
      agent = createAgentWithSchedule(23, 8);
      agent.tick(); // enter sleeping
      expect(agent.getAlertnessMode()).toBe('sleeping');

      // Large disturbance to wake
      const woke = agent.addDisturbance(1.0);
      expect(woke).toBe(true);
      expect(agent.getAlertnessMode()).toBe('awake');
    });

    it('prevents immediate re-sleep after disturbance wake', () => {
      vi.setSystemTime(new Date('2026-03-01T01:00:00'));
      agent = createAgentWithSchedule(23, 8);
      agent.tick(); // enter sleeping

      agent.addDisturbance(1.0); // wake by disturbance
      expect(agent.getAlertnessMode()).toBe('awake');

      // Tick again — still in sleep window, but grace period prevents re-sleep
      agent.tick();
      expect(agent.getAlertnessMode()).toBe('awake');

      // Advance past 5-minute grace period
      vi.setSystemTime(new Date('2026-03-01T01:06:00'));
      agent.tick();
      expect(agent.getAlertnessMode()).toBe('sleeping');
    });

    it('does not add disturbance when awake', () => {
      vi.setSystemTime(new Date('2026-03-01T10:00:00'));
      agent = createAgentWithSchedule(23, 8);
      agent.tick();

      const woke = agent.addDisturbance(1.0);
      expect(woke).toBe(false);
    });
  });

  describe('force wake', () => {
    it('sets grace period on force wake', () => {
      vi.setSystemTime(new Date('2026-03-01T01:00:00'));
      agent = createAgentWithSchedule(23, 8);
      agent.tick(); // enter sleeping
      expect(agent.getAlertnessMode()).toBe('sleeping');

      agent.wake();
      expect(agent.getAlertnessMode()).toBe('awake');

      // Tick again — grace period prevents re-sleep
      agent.tick();
      expect(agent.getAlertnessMode()).toBe('awake');
    });

    it('does nothing when already awake', () => {
      vi.setSystemTime(new Date('2026-03-01T10:00:00'));
      agent = createAgentWithSchedule(23, 8);
      agent.tick();

      agent.wake(); // no-op
      expect(agent.getAlertnessMode()).toBe('awake');
    });
  });

  describe('curiosity decay', () => {
    it('uses elapsed time for decay calculation', () => {
      // Set curiosity above baseline (0.5)
      vi.setSystemTime(new Date('2026-03-01T10:00:00'));
      agent = createAgent(
        { logger: logger as any, metrics: createMetrics() },
        { initialState: { curiosity: 0.9 }, curiosityDecayRatePerHour: 1.0 }
      );

      agent.tick(); // sets lastTickAt

      // Advance 5 seconds — decay = 1.0 * (5000/3600000) ≈ 0.00139 → rounds to 0.001
      vi.setSystemTime(new Date('2026-03-01T10:00:05'));
      agent.tick();

      const state = agent.getState();
      expect(state.curiosity).toBeLessThan(0.9);
      expect(state.curiosity).toBeGreaterThan(0.895);
    });
  });
});
