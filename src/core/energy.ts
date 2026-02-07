import { round3, type Logger } from '../types/index.js';

/**
 * Energy model configuration.
 */
export interface EnergyConfig {
  /** Base drain per tick (default: 0.001) */
  tickDrain: number;

  /** Drain per event processed (default: 0.005) */
  eventDrain: number;

  /** Drain per LLM call (default: 0.02) */
  llmDrain: number;

  /** Drain per message composed (default: 0.01) */
  messageDrain: number;

  /** Drain for Motor Cortex oneshot execution (default: 0.05) */
  motorOneshotDrain: number;

  /** Drain for Motor Cortex agentic run (default: 0.15) */
  motorAgenticDrain: number;

  /** Base recharge per tick during low-activity (default: 0.002) */
  baseRecharge: number;

  /** Night hours recharge multiplier (default: 2.0) */
  nightRechargeMultiplier: number;

  /** Minimum energy level (default: 0.05) */
  minEnergy: number;

  /** Maximum energy level (default: 1.0) */
  maxEnergy: number;

  /** Night start hour (0-23, default: 22) */
  nightStartHour: number;

  /** Night end hour (0-23, default: 6) */
  nightEndHour: number;
}

/**
 * Default energy configuration.
 */
export const DEFAULT_ENERGY_CONFIG: EnergyConfig = {
  tickDrain: 0.001,
  eventDrain: 0.005,
  llmDrain: 0.02,
  messageDrain: 0.01,
  motorOneshotDrain: 0.05,
  motorAgenticDrain: 0.15,
  baseRecharge: 0.002,
  nightRechargeMultiplier: 2.0,
  minEnergy: 0.05,
  maxEnergy: 1.0,
  nightStartHour: 22,
  nightEndHour: 6,
};

/**
 * Energy drain types for tracking/metrics.
 */
export type DrainType = 'tick' | 'event' | 'llm' | 'message' | 'motor_oneshot' | 'motor_agentic';

/**
 * Energy recharge sources.
 */
export type RechargeType = 'time' | 'night' | 'positive_feedback';

/**
 * Energy model - manages agent energy levels.
 *
 * Like biological energy:
 * - Drains with activity
 * - Recharges with rest
 * - Affects behavior (thresholds, tick rate)
 *
 * Low energy = harder to wake, longer ticks, higher thresholds to act.
 */
export class EnergyModel {
  private energy: number;
  private readonly config: EnergyConfig;
  private readonly logger: Logger;

  constructor(initialEnergy: number, logger: Logger, config: Partial<EnergyConfig> = {}) {
    this.config = { ...DEFAULT_ENERGY_CONFIG, ...config };
    this.energy = this.clamp(initialEnergy);
    this.logger = logger.child({ component: 'energy' });
  }

  /**
   * Get current energy level (0-1).
   */
  getEnergy(): number {
    return this.energy;
  }

  /**
   * Drain energy for an activity.
   */
  drain(type: DrainType): number {
    const amount = this.getDrainAmount(type);
    const before = this.energy;
    this.energy = this.clamp(this.energy - amount);

    if (before !== this.energy) {
      this.logger.trace({ type, amount, before, after: this.energy }, 'Energy drained');
    }

    return this.energy;
  }

  /**
   * Recharge energy.
   */
  recharge(type: RechargeType, multiplier = 1.0): number {
    const amount = this.getRechargeAmount(type) * multiplier;
    const before = this.energy;
    this.energy = this.clamp(this.energy + amount);

    if (before !== this.energy) {
      this.logger.trace(
        { type, amount, multiplier, before, after: this.energy },
        'Energy recharged'
      );
    }

    return this.energy;
  }

  /**
   * Apply time-based recharge. Call this on each tick.
   * Accounts for time of day (night = more recharge).
   */
  tickRecharge(): number {
    const isNight = this.isNightTime();
    return this.recharge(
      isNight ? 'night' : 'time',
      isNight ? this.config.nightRechargeMultiplier : 1.0
    );
  }

  /**
   * Calculate wake threshold based on energy.
   *
   * Low energy = higher threshold = harder to wake.
   * Formula: baseThreshold * (1 + (1 - energy))
   */
  calculateWakeThreshold(baseThreshold: number): number {
    const energyFactor = 1 + (1 - this.energy);
    return Math.min(baseThreshold * energyFactor, 0.99);
  }

  /**
   * Calculate tick interval multiplier based on energy.
   *
   * Low energy = longer intervals (more rest).
   * Returns multiplier > 1 when energy is low.
   */
  calculateTickMultiplier(): number {
    // At full energy (1.0): multiplier = 1.0
    // At half energy (0.5): multiplier = 1.5
    // At low energy (0.1): multiplier = 2.0
    return 1 + (1 - this.energy);
  }

  /**
   * Set energy directly (for loading state).
   */
  setEnergy(value: number): void {
    this.energy = this.clamp(value);
  }

  /**
   * Check if it's night time.
   */
  private isNightTime(): boolean {
    const hour = new Date().getHours();
    const { nightStartHour, nightEndHour } = this.config;

    // Handle wrap-around (e.g., 22:00 to 06:00)
    if (nightStartHour > nightEndHour) {
      return hour >= nightStartHour || hour < nightEndHour;
    }
    return hour >= nightStartHour && hour < nightEndHour;
  }

  private getDrainAmount(type: DrainType): number {
    switch (type) {
      case 'tick':
        return this.config.tickDrain;
      case 'event':
        return this.config.eventDrain;
      case 'llm':
        return this.config.llmDrain;
      case 'message':
        return this.config.messageDrain;
      case 'motor_oneshot':
        return this.config.motorOneshotDrain;
      case 'motor_agentic':
        return this.config.motorAgenticDrain;
    }
  }

  private getRechargeAmount(type: RechargeType): number {
    switch (type) {
      case 'time':
        return this.config.baseRecharge;
      case 'night':
        return this.config.baseRecharge;
      case 'positive_feedback':
        return this.config.baseRecharge * 5; // Positive feedback gives good boost
    }
  }

  private clamp(value: number): number {
    return round3(Math.max(this.config.minEnergy, Math.min(this.config.maxEnergy, value)));
  }
}

/**
 * Factory function for creating energy model.
 */
export function createEnergyModel(
  initialEnergy: number,
  logger: Logger,
  config?: Partial<EnergyConfig>
): EnergyModel {
  return new EnergyModel(initialEnergy, logger, config);
}
