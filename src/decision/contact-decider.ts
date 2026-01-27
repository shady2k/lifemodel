import type { AgentState, UserBeliefs } from '../types/index.js';
import type { ConfigurableNeuron, NeuronResult } from './neuron.js';

/**
 * Configuration for contact decision thresholds.
 */
export interface ContactDeciderConfig {
  /** Base threshold to initiate contact (default: 0.6) */
  baseThreshold: number;

  /** Threshold multiplier when user availability is low (default: 1.5) */
  lowAvailabilityMultiplier: number;

  /** User availability considered "low" (default: 0.3) */
  lowAvailabilityThreshold: number;

  /** Threshold multiplier when agent energy is low (default: 1.3) */
  lowEnergyMultiplier: number;

  /** Agent energy level considered "low" (default: 0.3) */
  lowEnergyThreshold: number;

  /** Minimum time between contact attempts in ms (default: 5 minutes) */
  cooldownMs: number;

  /** User confidence below which we use societal norms (default: 0.4) */
  beliefConfidenceThreshold: number;
}

const DEFAULT_CONFIG: ContactDeciderConfig = {
  baseThreshold: 0.6,
  lowAvailabilityMultiplier: 1.5,
  lowAvailabilityThreshold: 0.3,
  lowEnergyMultiplier: 1.3,
  lowEnergyThreshold: 0.3,
  cooldownMs: 5 * 60 * 1000, // 5 minutes
  beliefConfidenceThreshold: 0.4,
};

/**
 * Societal norms for user availability by hour.
 * Used as fallback when user patterns aren't learned yet.
 */
function getSocietalAvailability(hour: number): number {
  // Night hours (22:00 - 07:00) - very low availability
  if (hour >= 22 || hour < 7) return 0.2;
  // Early morning (07:00 - 09:00) - moderate
  if (hour >= 7 && hour < 9) return 0.5;
  // Work hours (09:00 - 17:00) - good availability
  if (hour >= 9 && hour < 17) return 0.8;
  // Evening (17:00 - 22:00) - moderate
  return 0.6;
}

/**
 * Result of contact decision evaluation.
 */
export interface ContactDecision {
  /** Should the agent initiate contact? */
  shouldContact: boolean;

  /** The calculated pressure (0-1) */
  pressure: number;

  /** The effective threshold used */
  threshold: number;

  /** Full neuron trace for explainability */
  trace: NeuronResult;

  /** Reason for the decision */
  reason: string;

  /** Factors that influenced the decision */
  factors: {
    userAvailability: number;
    availabilitySource: 'learned' | 'societal';
    isLowAvailability: boolean;
    isLowEnergy: boolean;
    isCooldown: boolean;
  };
}

/**
 * ContactDecider - determines when the agent should initiate contact.
 *
 * Uses a configurable neuron (with learnable weights) to combine multiple
 * factors into a single pressure value, then compares against an adaptive
 * threshold that considers user availability and agent state.
 *
 * Key design decisions:
 * - Uses UserModel beliefs when confidence is high enough
 * - Falls back to societal norms when user patterns unknown
 * - Enforces cooldown to prevent spamming
 * - Provides full trace for explainability
 */
export class ContactDecider {
  private readonly config: ContactDeciderConfig;
  private readonly neuron: ConfigurableNeuron;
  private lastContactAttempt: Date | null = null;

  constructor(neuron: ConfigurableNeuron, config: Partial<ContactDeciderConfig> = {}) {
    this.neuron = neuron;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate whether to initiate contact.
   *
   * @param state Current agent state
   * @param userBeliefs Agent's beliefs about the user (optional)
   * @param hour Current hour (0-23), used for societal fallback
   */
  evaluate(state: AgentState, userBeliefs: UserBeliefs | undefined, hour: number): ContactDecision {
    const now = new Date();

    // Check cooldown
    const isCooldown =
      this.lastContactAttempt !== null &&
      now.getTime() - this.lastContactAttempt.getTime() < this.config.cooldownMs;

    // Determine user availability (learned vs societal fallback)
    let userAvailability: number;
    let availabilitySource: 'learned' | 'societal';

    if (userBeliefs && userBeliefs.confidence > this.config.beliefConfidenceThreshold) {
      // Use learned patterns
      userAvailability = userBeliefs.availability;
      availabilitySource = 'learned';
    } else {
      // Fall back to societal norms
      userAvailability = getSocietalAvailability(hour);
      availabilitySource = 'societal';
    }

    // Check state factors
    const isLowAvailability = userAvailability < this.config.lowAvailabilityThreshold;
    const isLowEnergy = state.energy < this.config.lowEnergyThreshold;

    // Calculate pressure using configurable neuron
    const trace = this.neuron.evaluate({
      socialDebt: state.socialDebt,
      taskPressure: state.taskPressure,
      curiosity: state.curiosity,
      userAvailability,
    });

    // Calculate adaptive threshold
    let threshold = this.config.baseThreshold;
    if (isLowAvailability) {
      threshold *= this.config.lowAvailabilityMultiplier;
    }
    if (isLowEnergy) {
      threshold *= this.config.lowEnergyMultiplier;
    }
    // Cap threshold at 0.95 to allow very high pressure to break through
    threshold = Math.min(0.95, threshold);

    // Make decision
    let shouldContact = trace.output >= threshold && !isCooldown;
    let reason: string;

    if (isCooldown && this.lastContactAttempt) {
      shouldContact = false;
      const remainingMs =
        this.config.cooldownMs - (now.getTime() - this.lastContactAttempt.getTime());
      const remainingSec = Math.ceil(remainingMs / 1000);
      reason = `In cooldown period (${String(remainingSec)}s remaining)`;
    } else if (trace.output < threshold) {
      reason = `Pressure (${trace.output.toFixed(2)}) below threshold (${threshold.toFixed(2)})`;
    } else {
      reason = `Pressure (${trace.output.toFixed(2)}) exceeded threshold (${threshold.toFixed(2)})`;
    }

    return {
      shouldContact,
      pressure: trace.output,
      threshold,
      trace,
      reason,
      factors: {
        userAvailability,
        availabilitySource,
        isLowAvailability,
        isLowEnergy,
        isCooldown,
      },
    };
  }

  /**
   * Record that a contact attempt was made.
   * Resets the cooldown timer.
   */
  recordContactAttempt(): void {
    this.lastContactAttempt = new Date();
  }

  /**
   * Reset the cooldown (e.g., when user initiates contact).
   */
  resetCooldown(): void {
    this.lastContactAttempt = null;
  }

  /**
   * Get time until cooldown expires (ms), or 0 if not in cooldown.
   */
  getCooldownRemaining(): number {
    if (this.lastContactAttempt === null) {
      return 0;
    }
    const elapsed = Date.now() - this.lastContactAttempt.getTime();
    const remaining = this.config.cooldownMs - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Get current configuration (for debugging).
   */
  getConfig(): Readonly<ContactDeciderConfig> {
    return { ...this.config };
  }

  /**
   * Get the neuron (for inspection/learning).
   */
  getNeuron(): ConfigurableNeuron {
    return this.neuron;
  }
}

/**
 * Factory function.
 */
export function createContactDecider(
  neuron: ConfigurableNeuron,
  config?: Partial<ContactDeciderConfig>
): ContactDecider {
  return new ContactDecider(neuron, config);
}
