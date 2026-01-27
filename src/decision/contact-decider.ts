import type { AgentState } from '../types/index.js';
import { contactPressureNeuron, type NeuronResult } from './neuron.js';

/**
 * Configuration for contact decision thresholds.
 */
export interface ContactDeciderConfig {
  /** Base threshold to initiate contact (default: 0.6) */
  baseThreshold: number;

  /** Threshold multiplier during night hours (default: 1.5) */
  nightMultiplier: number;

  /** Threshold multiplier when energy is low (default: 1.3) */
  lowEnergyMultiplier: number;

  /** Energy level considered "low" (default: 0.3) */
  lowEnergyThreshold: number;

  /** Night start hour (default: 22) */
  nightStart: number;

  /** Night end hour (default: 8) */
  nightEnd: number;

  /** Minimum time between contact attempts in ms (default: 5 minutes) */
  cooldownMs: number;
}

const DEFAULT_CONFIG: ContactDeciderConfig = {
  baseThreshold: 0.6,
  nightMultiplier: 1.5,
  lowEnergyMultiplier: 1.3,
  lowEnergyThreshold: 0.3,
  nightStart: 22,
  nightEnd: 8,
  cooldownMs: 5 * 60 * 1000, // 5 minutes
};

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
    isNightTime: boolean;
    isLowEnergy: boolean;
    isCooldown: boolean;
  };
}

/**
 * ContactDecider - determines when the agent should initiate contact.
 *
 * Uses neuron-like weighted calculation to combine multiple factors
 * into a single pressure value, then compares against an adaptive
 * threshold that considers time of day and agent state.
 */
export class ContactDecider {
  private readonly config: ContactDeciderConfig;
  private lastContactAttempt: Date | null = null;

  constructor(config: Partial<ContactDeciderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate whether to initiate contact.
   *
   * @param state Current agent state
   * @param userAvailability Belief about user availability (0-1)
   * @param hour Current hour (0-23)
   */
  evaluate(state: AgentState, userAvailability: number, hour: number): ContactDecision {
    const now = new Date();

    // Check cooldown
    const isCooldown =
      this.lastContactAttempt !== null &&
      now.getTime() - this.lastContactAttempt.getTime() < this.config.cooldownMs;

    // Check time factors
    const isNightTime = this.isNightTime(hour);
    const isLowEnergy = state.energy < this.config.lowEnergyThreshold;

    // Calculate pressure using neuron
    const trace = contactPressureNeuron({
      socialDebt: state.socialDebt,
      taskPressure: state.taskPressure,
      curiosity: state.curiosity,
      userAvailability,
    });

    // Calculate adaptive threshold
    let threshold = this.config.baseThreshold;
    if (isNightTime) {
      threshold *= this.config.nightMultiplier;
    }
    if (isLowEnergy) {
      threshold *= this.config.lowEnergyMultiplier;
    }
    // Cap threshold at 0.95 to always allow very high pressure to break through
    threshold = Math.min(0.95, threshold);

    // Make decision
    let shouldContact = trace.output >= threshold && !isCooldown;
    let reason: string;

    if (isCooldown) {
      shouldContact = false;
      reason = 'In cooldown period after recent contact attempt';
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
        isNightTime,
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
   * Reset the cooldown (e.g., after user initiates contact).
   */
  resetCooldown(): void {
    this.lastContactAttempt = null;
  }

  /**
   * Check if current hour is during night.
   */
  private isNightTime(hour: number): boolean {
    return hour >= this.config.nightStart || hour < this.config.nightEnd;
  }

  /**
   * Get current configuration (for debugging).
   */
  getConfig(): Readonly<ContactDeciderConfig> {
    return { ...this.config };
  }
}

/**
 * Factory function.
 */
export function createContactDecider(config?: Partial<ContactDeciderConfig>): ContactDecider {
  return new ContactDecider(config);
}
