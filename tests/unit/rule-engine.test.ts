import { describe, it, expect, beforeEach } from 'vitest';
import { createContainer } from '../../src/core/container.js';
import { createRule, Priority } from '../../src/types/index.js';

describe('RuleEngine', () => {
  let container: ReturnType<typeof createContainer>;

  beforeEach(() => {
    container = createContainer({
      logLevel: 'silent',
    });
  });

  describe('Rule registration', () => {
    it('registers and retrieves rules', () => {
      const { ruleEngine } = container;

      const testRule = createRule({
        id: 'test-rule',
        description: 'Test rule',
        trigger: 'tick',
        condition: () => true,
        action: () => [],
      });

      ruleEngine.addRule(testRule);
      const rules = ruleEngine.getRules();

      expect(rules.some((r) => r.id === 'test-rule')).toBe(true);
    });

    it('removes rules by ID', () => {
      const { ruleEngine } = container;

      const testRule = createRule({
        id: 'removable-rule',
        description: 'Will be removed',
        trigger: 'tick',
        condition: () => true,
        action: () => [],
      });

      ruleEngine.addRule(testRule);
      expect(ruleEngine.getRules().some((r) => r.id === 'removable-rule')).toBe(true);

      ruleEngine.removeRule('removable-rule');
      expect(ruleEngine.getRules().some((r) => r.id === 'removable-rule')).toBe(false);
    });
  });

  describe('Rule evaluation', () => {
    it('evaluates tick rules and returns intents', () => {
      const { ruleEngine, agent } = container;

      const testRule = createRule({
        id: 'intent-producer',
        description: 'Produces intents',
        trigger: 'tick',
        condition: () => true,
        action: () => [
          {
            type: 'LOG',
            payload: {
              level: 'info',
              message: 'Rule fired',
            },
          },
        ],
      });

      ruleEngine.addRule(testRule);
      const intents = ruleEngine.evaluateTick(agent.getState());

      expect(intents.length).toBeGreaterThan(0);
      expect(intents.some((i) => i.type === 'LOG')).toBe(true);
    });

    it('respects rule conditions', () => {
      const { ruleEngine, agent } = container;

      const neverFireRule = createRule({
        id: 'never-fire',
        description: 'Never fires',
        trigger: 'tick',
        condition: () => false,
        action: () => [
          {
            type: 'LOG',
            payload: { level: 'info', message: 'Should not see this' },
          },
        ],
      });

      // Remove all default rules first
      for (const rule of ruleEngine.getRules()) {
        ruleEngine.removeRule(rule.id);
      }

      ruleEngine.addRule(neverFireRule);
      const intents = ruleEngine.evaluateTick(agent.getState());

      expect(intents.length).toBe(0);
    });

    it('evaluates event-specific rules', () => {
      const { ruleEngine, agent } = container;

      const messageRule = createRule({
        id: 'on-message',
        description: 'Fires on message',
        trigger: 'message_received',
        condition: () => true,
        action: () => [
          {
            type: 'LOG',
            payload: { level: 'info', message: 'Message received!' },
          },
        ],
      });

      ruleEngine.addRule(messageRule);

      const event = {
        id: 'test-event',
        source: 'communication' as const,
        type: 'message_received',
        priority: Priority.HIGH,
        timestamp: new Date(),
        payload: { text: 'Hello' },
      };

      const intents = ruleEngine.evaluateEvent(agent.getState(), event);

      expect(intents.some((i) => i.type === 'LOG')).toBe(true);
    });
  });

  describe('Default rules', () => {
    it('loads default rules on container creation', () => {
      const { ruleEngine } = container;
      const rules = ruleEngine.getRules();

      expect(rules.length).toBeGreaterThan(0);
      expect(rules.some((r) => r.id === 'night-suppression')).toBe(true);
      expect(rules.some((r) => r.id === 'contact-decision')).toBe(true);
    });

    it('night suppression rule fires during night hours', () => {
      const { ruleEngine, agent } = container;

      // Get night suppression rule
      const nightRule = ruleEngine.getRules().find((r) => r.id === 'night-suppression');
      expect(nightRule).toBeDefined();

      // Test with night hour (23:00)
      const nightContext = {
        state: agent.getState(),
        now: new Date(),
        hour: 23,
        timeSinceLastInteraction: 0,
      };

      expect(nightRule?.condition(nightContext)).toBe(true);

      // Test with day hour (12:00)
      const dayContext = {
        ...nightContext,
        hour: 12,
      };

      expect(nightRule?.condition(dayContext)).toBe(false);
    });

    it('contact decision rule uses neuron-based weighted calculation', () => {
      const { ruleEngine } = container;

      const contactRule = ruleEngine.getRules().find((r) => r.id === 'contact-decision');
      expect(contactRule).toBeDefined();

      // Low pressure factors - should not fire
      const lowPressureContext = {
        state: {
          ...container.agent.getState(),
          socialDebt: 0.2,
          taskPressure: 0.1,
          curiosity: 0.3,
        },
        now: new Date(),
        hour: 12, // Day time, good availability
        timeSinceLastInteraction: 0,
      };

      expect(contactRule?.condition(lowPressureContext)).toBe(false);

      // High pressure factors - should fire
      const highPressureContext = {
        ...lowPressureContext,
        state: {
          ...lowPressureContext.state,
          socialDebt: 0.9,
          taskPressure: 0.8,
          curiosity: 0.7,
        },
      };

      expect(contactRule?.condition(highPressureContext)).toBe(true);
    });
  });
});
