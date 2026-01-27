import type { Rule, RuleContext, Intent } from '../types/index.js';
import { createRule } from '../types/index.js';
import { Priority } from '../types/index.js';

// Note: Contact decisions are now handled by ContactDecider in the event loop.
// This provides learnable neuron weights, cooldown, and UserModel integration.
// Night suppression is handled by UserModel availability beliefs.

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

    // Don't build pressure when user availability is low (e.g., night)
    if (ctx.userBeliefs.availability < 0.3) {
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
    inactivityAwarenessRule,
    energyRecoveryRule,
    messageReceivedRule,
    acquaintancePressureRule,
    acquaintanceThresholdRule,
  ];
}
