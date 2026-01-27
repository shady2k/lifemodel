import type { Rule, RuleContext, Intent } from '../types/index.js';
import { createRule } from '../types/index.js';
import { Priority } from '../types/index.js';
import { contactPressureNeuron } from '../decision/neuron.js';

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
 * Contact decision rule using neuron-like weighted calculation.
 *
 * Combines multiple factors (social debt, task pressure, curiosity,
 * user availability estimate) into a single pressure value.
 * When pressure exceeds threshold, triggers contact consideration.
 */
const contactDecisionRule = createRule({
  id: 'contact-decision',
  description: 'Neuron-based contact decision using weighted factors',
  trigger: 'tick',
  weight: 0.85,

  condition: (ctx: RuleContext): boolean => {
    // Estimate user availability based on time of day
    const userAvailability = estimateUserAvailability(ctx.hour);

    // Calculate contact pressure using neuron
    const result = contactPressureNeuron({
      socialDebt: ctx.state.socialDebt,
      taskPressure: ctx.state.taskPressure,
      curiosity: ctx.state.curiosity,
      userAvailability,
    });

    // Adaptive threshold based on conditions
    let threshold = 0.6; // Base threshold
    if (isNightTime(ctx.hour)) {
      threshold = 0.85; // Much higher at night
    }
    if (ctx.state.energy < 0.3) {
      threshold += 0.1; // Higher when tired
    }

    const crossed = result.output >= threshold;

    // Log neuron evaluation for debugging
    ctx.logger?.debug(
      {
        pressure: result.output.toFixed(3),
        threshold: threshold.toFixed(2),
        crossed,
        inputs: {
          socialDebt: ctx.state.socialDebt.toFixed(2),
          taskPressure: ctx.state.taskPressure.toFixed(2),
          curiosity: ctx.state.curiosity.toFixed(2),
          userAvailability: userAvailability.toFixed(2),
        },
      },
      `🧠 Contact pressure: ${result.output.toFixed(3)} (threshold: ${threshold.toFixed(2)}) ${crossed ? '✓ CROSSED' : '✗ below'}`
    );

    return crossed;
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];
    const userAvailability = estimateUserAvailability(ctx.hour);

    // Calculate for logging
    const result = contactPressureNeuron({
      socialDebt: ctx.state.socialDebt,
      taskPressure: ctx.state.taskPressure,
      curiosity: ctx.state.curiosity,
      userAvailability,
    });

    // Schedule contact consideration event
    intents.push({
      type: 'SCHEDULE_EVENT',
      payload: {
        event: {
          source: 'internal',
          type: 'contact_pressure_threshold',
          priority: isNightTime(ctx.hour) ? Priority.NORMAL : Priority.HIGH,
          payload: {
            pressure: result.output,
            contributions: result.contributions,
            reason: 'neuron_threshold_crossed',
          },
        },
        delay: 0,
        scheduleId: 'contact-decision',
      },
    });

    // Log with full trace for explainability
    intents.push({
      type: 'LOG',
      payload: {
        level: 'info',
        message: 'Contact pressure threshold crossed',
        context: {
          pressure: result.output.toFixed(3),
          contributions: result.contributions.map((c) => ({
            [c.name]: `${c.value.toFixed(2)} * ${c.weight.toFixed(2)} = ${c.contribution.toFixed(3)}`,
          })),
          isNight: isNightTime(ctx.hour),
        },
      },
    });

    // Emit metrics
    intents.push({
      type: 'EMIT_METRIC',
      payload: {
        type: 'gauge',
        name: 'contact_pressure',
        value: result.output,
      },
    });

    return intents;
  },
});

/**
 * Estimate user availability based on time of day.
 * Simple heuristic - can be replaced with learned patterns later.
 */
function estimateUserAvailability(hour: number): number {
  // Night (22-6): Very low availability
  if (hour >= 22 || hour < 6) {
    return 0.1;
  }
  // Early morning (6-9): Low availability
  if (hour >= 6 && hour < 9) {
    return 0.4;
  }
  // Work hours (9-12, 14-18): Medium availability
  if ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) {
    return 0.6;
  }
  // Lunch (12-14): Higher availability
  if (hour >= 12 && hour < 14) {
    return 0.8;
  }
  // Evening (18-22): High availability
  return 0.9;
}

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
 * Acquaintance pressure rule.
 *
 * When agent doesn't know user's name, curiosity builds up naturally.
 * The agent wants to get acquainted - introduce itself and learn about the user.
 * This is a natural social drive, not forced onboarding.
 */
const acquaintancePressureRule = createRule({
  id: 'acquaintance-pressure',
  description: 'Build pressure to get acquainted when user name is unknown',
  trigger: 'tick',
  weight: 0.7,

  condition: (ctx: RuleContext): boolean => {
    // Only fire if we have user beliefs and don't know their name
    if (!ctx.userBeliefs || ctx.userBeliefs.nameKnown) {
      return false;
    }

    // Don't build pressure at night
    if (isNightTime(ctx.hour)) {
      return false;
    }

    // Only when there's been some interaction (not on cold start)
    return ctx.timeSinceLastInteraction < 30 * 60 * 1000; // Within 30 min of interaction
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];

    // Gradually increase acquaintance pressure
    const currentPressure = ctx.state.acquaintancePressure;
    const increase = 0.05; // Small incremental increase
    const newPressure = Math.min(1, currentPressure + increase);

    intents.push({
      type: 'UPDATE_STATE',
      payload: {
        key: 'acquaintancePressure',
        value: newPressure,
      },
    });

    ctx.logger?.debug(
      {
        previousPressure: currentPressure.toFixed(2),
        newPressure: newPressure.toFixed(2),
        userName: ctx.userBeliefs?.name,
      },
      '🤝 Acquaintance pressure building'
    );

    return intents;
  },
});

/**
 * Acquaintance threshold rule.
 *
 * When acquaintance pressure crosses threshold, trigger introduction.
 * Agent naturally wants to introduce itself and ask for user's name.
 */
const acquaintanceThresholdRule = createRule({
  id: 'acquaintance-threshold',
  description: 'Trigger introduction when acquaintance pressure crosses threshold',
  trigger: 'tick',
  weight: 0.8,

  condition: (ctx: RuleContext): boolean => {
    // Only fire if we have user beliefs and don't know their name
    if (!ctx.userBeliefs || ctx.userBeliefs.nameKnown) {
      return false;
    }

    // Don't fire if acquaintance is already pending
    if (ctx.state.acquaintancePending) {
      return false;
    }

    // Check if pressure exceeds threshold
    const threshold = 0.3; // Lower threshold - agent is naturally curious
    return ctx.state.acquaintancePressure >= threshold;
  },

  action: (ctx: RuleContext): Intent[] => {
    const intents: Intent[] = [];

    // Mark acquaintance as pending (cleared after message sent)
    intents.push({
      type: 'UPDATE_STATE',
      payload: {
        key: 'acquaintancePending',
        value: true,
      },
    });

    // Schedule acquaintance event
    intents.push({
      type: 'SCHEDULE_EVENT',
      payload: {
        event: {
          source: 'internal',
          type: 'acquaintance_threshold',
          priority: Priority.NORMAL,
          payload: {
            pressure: ctx.state.acquaintancePressure,
            reason: 'want_to_get_acquainted',
          },
        },
        delay: 0,
        scheduleId: 'acquaintance',
      },
    });

    intents.push({
      type: 'LOG',
      payload: {
        level: 'info',
        message: 'Acquaintance threshold crossed - agent wants to introduce itself',
        context: {
          pressure: ctx.state.acquaintancePressure.toFixed(2),
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
    contactDecisionRule,
    inactivityAwarenessRule,
    energyRecoveryRule,
    messageReceivedRule,
    acquaintancePressureRule,
    acquaintanceThresholdRule,
  ];
}
