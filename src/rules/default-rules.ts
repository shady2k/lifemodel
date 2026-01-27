import type { Rule, RuleContext, Intent } from '../types/index.js';
import { createRule } from '../types/index.js';
import { Priority } from '../types/index.js';

/**
 * Night hours (when to suppress non-urgent contact).
 */
const NIGHT_START = 22; // 10 PM
const NIGHT_END = 8; // 8 AM

/**
 * Check if current hour is during night.
 */
function isNightTime(hour: number): boolean {
  return hour >= NIGHT_START || hour < NIGHT_END;
}

/**
 * Night suppression rule.
 *
 * During night hours, suppress non-critical activity:
 * - Increase wake threshold (harder to wake)
 * - Reduce contact urgency
 */
const nightSuppressionRule = createRule({
  id: 'night-suppression',
  description: 'Suppress non-urgent activity during night hours',
  trigger: 'tick',
  weight: 0.9,

  condition: (ctx: RuleContext): boolean => {
    return isNightTime(ctx.hour);
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];

    // Log that we're in night mode
    intents.push({
      type: 'LOG',
      payload: {
        level: 'debug',
        message: 'Night suppression active',
        context: { hour: ctx.hour },
      },
    });

    // Emit metric for tracking
    intents.push({
      type: 'EMIT_METRIC',
      payload: {
        type: 'gauge',
        name: 'rule_night_suppression_active',
        value: 1,
      },
    });

    return intents;
  },
});

/**
 * Social pressure threshold rule.
 *
 * When social debt accumulates beyond threshold,
 * signal that agent should consider reaching out.
 */
const socialPressureRule = createRule({
  id: 'social-pressure-threshold',
  description: 'Trigger contact consideration when social debt is high',
  trigger: 'tick',
  weight: 0.8,

  condition: (ctx: RuleContext): boolean => {
    // Fire when social debt exceeds threshold
    const threshold = isNightTime(ctx.hour) ? 0.9 : 0.7;
    return ctx.state.socialDebt >= threshold;
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];

    // Schedule an internal event to trigger contact consideration
    intents.push({
      type: 'SCHEDULE_EVENT',
      payload: {
        event: {
          source: 'internal',
          type: 'contact_pressure_threshold',
          priority: isNightTime(ctx.hour) ? Priority.NORMAL : Priority.HIGH,
          payload: {
            socialDebt: ctx.state.socialDebt,
            reason: 'social_debt_accumulated',
          },
        },
        delay: 0, // Immediate
        scheduleId: 'contact-pressure-check',
      },
    });

    intents.push({
      type: 'LOG',
      payload: {
        level: 'info',
        message: 'Social pressure threshold crossed',
        context: {
          socialDebt: ctx.state.socialDebt,
          isNight: isNightTime(ctx.hour),
        },
      },
    });

    return intents;
  },
});

/**
 * Inactivity awareness rule.
 *
 * After prolonged inactivity (no interaction), increase curiosity
 * and log awareness.
 */
const inactivityAwarenessRule = createRule({
  id: 'inactivity-awareness',
  description: 'Become aware of prolonged inactivity',
  trigger: 'tick',
  weight: 0.6,

  condition: (ctx: RuleContext): boolean => {
    // Fire after 30 minutes of inactivity
    const thirtyMinutes = 30 * 60 * 1000;
    return ctx.timeSinceLastInteraction >= thirtyMinutes;
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];
    const minutesSince = Math.floor(ctx.timeSinceLastInteraction / 60000);

    // Slightly increase curiosity
    intents.push({
      type: 'UPDATE_STATE',
      payload: {
        key: 'curiosity',
        value: 0.01,
        delta: true,
      },
    });

    intents.push({
      type: 'EMIT_METRIC',
      payload: {
        type: 'gauge',
        name: 'agent_inactivity_minutes',
        value: minutesSince,
      },
    });

    return intents;
  },
});

/**
 * Energy recovery rule.
 *
 * When energy is critically low, prioritize rest.
 */
const energyRecoveryRule = createRule({
  id: 'energy-recovery',
  description: 'Prioritize rest when energy is critically low',
  trigger: 'tick',
  weight: 0.95,

  condition: (ctx: RuleContext): boolean => {
    return ctx.state.energy < 0.2;
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];

    intents.push({
      type: 'LOG',
      payload: {
        level: 'info',
        message: 'Energy critically low, prioritizing recovery',
        context: { energy: ctx.state.energy },
      },
    });

    intents.push({
      type: 'EMIT_METRIC',
      payload: {
        type: 'counter',
        name: 'rule_energy_recovery_triggered',
        value: 1,
      },
    });

    return intents;
  },
});

/**
 * Message received rule.
 *
 * When a message is received, reset social debt.
 */
const messageReceivedRule = createRule({
  id: 'message-received-reset',
  description: 'Reset social debt when message is received',
  trigger: 'message_received',
  weight: 1.0,

  condition: (_ctx: RuleContext): boolean => {
    return true; // Always fire for message_received events
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];

    // Reset social debt significantly
    const newDebt = Math.max(0, ctx.state.socialDebt - 0.5);
    intents.push({
      type: 'UPDATE_STATE',
      payload: {
        key: 'socialDebt',
        value: newDebt,
      },
    });

    intents.push({
      type: 'LOG',
      payload: {
        level: 'debug',
        message: 'Social debt reduced after message received',
        context: {
          previousDebt: ctx.state.socialDebt,
          newDebt,
        },
      },
    });

    return intents;
  },
});

/**
 * Get all default rules.
 */
export function createDefaultRules(): Rule[] {
  return [
    nightSuppressionRule,
    socialPressureRule,
    inactivityAwarenessRule,
    energyRecoveryRule,
    messageReceivedRule,
  ];
}
