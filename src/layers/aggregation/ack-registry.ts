/**
 * Signal Acknowledgment Registry
 *
 * Tracks how COGNITION has responded to signals, enabling:
 * - Deferrals: "Don't wake me for this until X time or Y condition"
 * - Suppressions: "Don't wake me for this type at all"
 * - Handled markers: "I've dealt with this, clear it"
 *
 * This is a unified mechanism that works for any signal type,
 * not just proactive contact. Like the brain's habituation mechanism -
 * repeated stimuli get filtered out until something changes.
 */

import type { SignalType, SignalSource } from '../../types/signal.js';
import type { Logger } from '../../types/logger.js';

/**
 * Type of acknowledgment.
 */
export type AckType =
  | 'handled' // Signal was processed, can be cleared
  | 'deferred' // Don't wake for this until conditions met
  | 'suppressed'; // Don't wake for this type (until manually cleared)

/**
 * Signal acknowledgment record.
 */
export interface SignalAck {
  /** Unique ID for this ack */
  id: string;

  /** What signal type this ack applies to */
  signalType: SignalType;

  /** Optional: specific source (e.g., neuron.contact_pressure) */
  source?: SignalSource | undefined;

  /** Type of acknowledgment */
  ackType: AckType;

  /** When this ack was created */
  createdAt: Date;

  /** For deferrals: when to reconsider */
  deferUntil?: Date | undefined;

  /** For deferrals: metric value when ack was created (for override detection) */
  valueAtAck?: number | undefined;

  /** For deferrals: if current value exceeds valueAtAck + overrideDelta, override */
  overrideDelta?: number | undefined;

  /** Why this ack was issued */
  reason: string;
}

/**
 * Result of checking if a signal should be blocked.
 */
export interface AckCheckResult {
  /** Whether the signal should be blocked */
  blocked: boolean;

  /** If not blocked and there was a deferral, whether this is an override */
  isOverride: boolean;

  /** The ack that caused blocking (if blocked) */
  blockingAck?: SignalAck;

  /** Reason for the decision */
  reason: string;
}

/**
 * Configuration for AckRegistry.
 */
export interface AckRegistryConfig {
  /** Default deferral override delta (0-1) */
  defaultOverrideDelta: number;

  /** Maximum deferral duration in ms (default: 24 hours) */
  maxDeferralMs: number;

  /** Prune expired acks every N checks */
  pruneInterval: number;
}

const DEFAULT_CONFIG: AckRegistryConfig = {
  defaultOverrideDelta: 0.25, // 25% increase to override
  maxDeferralMs: 24 * 60 * 60 * 1000, // 24 hours max
  pruneInterval: 100,
};

/**
 * Signal Acknowledgment Registry.
 *
 * Manages acks for signals, determining when COGNITION should
 * be woken vs when a signal should be filtered out.
 */
export class SignalAckRegistry {
  private readonly logger: Logger;
  private readonly config: AckRegistryConfig;
  private readonly acks = new Map<string, SignalAck>();
  private checkCount = 0;

  constructor(logger: Logger, config: Partial<AckRegistryConfig> = {}) {
    this.logger = logger.child({ component: 'ack-registry' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register an acknowledgment for a signal type.
   */
  registerAck(ack: Omit<SignalAck, 'id' | 'createdAt'>): SignalAck {
    const id = this.generateAckId(ack.signalType, ack.source);

    // Validate deferral duration
    if (ack.ackType === 'deferred' && ack.deferUntil) {
      const deferMs = ack.deferUntil.getTime() - Date.now();
      if (deferMs > this.config.maxDeferralMs) {
        this.logger.warn(
          { requestedMs: deferMs, maxMs: this.config.maxDeferralMs },
          'Deferral duration exceeds maximum, capping'
        );
        ack.deferUntil = new Date(Date.now() + this.config.maxDeferralMs);
      }
    }

    // Set default override delta if not provided
    if (ack.ackType === 'deferred' && ack.overrideDelta === undefined) {
      ack.overrideDelta = this.config.defaultOverrideDelta;
    }

    const fullAck: SignalAck = {
      ...ack,
      id,
      createdAt: new Date(),
    };

    this.acks.set(id, fullAck);

    this.logger.debug(
      {
        id,
        signalType: ack.signalType,
        ackType: ack.ackType,
        deferUntil: ack.deferUntil,
        reason: ack.reason,
      },
      'Signal ack registered'
    );

    return fullAck;
  }

  /**
   * Check if a signal should be blocked by an existing ack.
   *
   * @param signalType The signal type to check
   * @param source Optional specific source
   * @param currentValue Current metric value (for override detection)
   */
  checkBlocked(
    signalType: SignalType,
    source?: SignalSource,
    currentValue?: number
  ): AckCheckResult {
    this.checkCount++;

    // Periodic pruning
    if (this.checkCount % this.config.pruneInterval === 0) {
      this.pruneExpired();
    }

    const id = this.generateAckId(signalType, source);
    const ack = this.acks.get(id);

    if (!ack) {
      return {
        blocked: false,
        isOverride: false,
        reason: 'No ack registered for this signal type',
      };
    }

    // Handle different ack types
    switch (ack.ackType) {
      case 'handled':
        // Handled acks are transient - clear and allow
        this.acks.delete(id);
        return {
          blocked: false,
          isOverride: false,
          reason: 'Previous signal was handled, allowing new one',
        };

      case 'suppressed':
        // Suppressed = always blocked
        return {
          blocked: true,
          isOverride: false,
          blockingAck: ack,
          reason: `Signal type suppressed: ${ack.reason}`,
        };

      case 'deferred':
        return this.checkDeferral(ack, currentValue);

      default:
        return {
          blocked: false,
          isOverride: false,
          reason: 'Unknown ack type',
        };
    }
  }

  /**
   * Check if a deferral should block or be overridden.
   */
  private checkDeferral(ack: SignalAck, currentValue?: number): AckCheckResult {
    const now = new Date();

    // Check if deferral has expired
    if (ack.deferUntil && now >= ack.deferUntil) {
      this.logger.debug(
        { signalType: ack.signalType, deferUntil: ack.deferUntil },
        'Deferral expired'
      );
      this.acks.delete(ack.id);
      return {
        blocked: false,
        isOverride: false,
        reason: 'Deferral expired',
      };
    }

    // Check for override condition (significant value increase)
    if (
      currentValue !== undefined &&
      ack.valueAtAck !== undefined &&
      ack.overrideDelta !== undefined
    ) {
      const delta = currentValue - ack.valueAtAck;
      if (delta >= ack.overrideDelta) {
        this.logger.info(
          {
            signalType: ack.signalType,
            valueAtAck: ack.valueAtAck.toFixed(2),
            currentValue: currentValue.toFixed(2),
            delta: delta.toFixed(2),
            threshold: ack.overrideDelta,
          },
          'Deferral override due to significant value increase'
        );
        this.acks.delete(ack.id);
        return {
          blocked: false,
          isOverride: true,
          reason: `Deferral overridden: value increased by ${(delta * 100).toFixed(0)}%`,
        };
      }
    }

    // Deferral still active
    return {
      blocked: true,
      isOverride: false,
      blockingAck: ack,
      reason: `Deferred until ${ack.deferUntil?.toISOString() ?? 'unknown'}: ${ack.reason}`,
    };
  }

  /**
   * Clear an ack for a signal type.
   * Called when user initiates contact or other clearing conditions.
   */
  clearAck(signalType: SignalType, source?: SignalSource): boolean {
    const id = this.generateAckId(signalType, source);
    const existed = this.acks.has(id);
    this.acks.delete(id);

    if (existed) {
      this.logger.debug({ signalType, source }, 'Signal ack cleared');
    }

    return existed;
  }

  /**
   * Clear all acks (e.g., on user message).
   */
  clearAll(): void {
    const count = this.acks.size;
    this.acks.clear();
    this.logger.debug({ clearedCount: count }, 'All signal acks cleared');
  }

  /**
   * Get an ack if it exists.
   */
  getAck(signalType: SignalType, source?: SignalSource): SignalAck | undefined {
    const id = this.generateAckId(signalType, source);
    return this.acks.get(id);
  }

  /**
   * Get all active acks (for debugging).
   */
  getAllAcks(): SignalAck[] {
    return Array.from(this.acks.values());
  }

  /**
   * Prune expired deferrals.
   */
  pruneExpired(): number {
    const now = new Date();
    let pruned = 0;

    for (const [id, ack] of this.acks) {
      if (ack.ackType === 'deferred' && ack.deferUntil && now >= ack.deferUntil) {
        this.acks.delete(id);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.logger.debug({ pruned }, 'Expired acks pruned');
    }

    return pruned;
  }

  /**
   * Generate a unique ID for an ack based on signal type and source.
   */
  private generateAckId(signalType: SignalType, source?: SignalSource): string {
    return source ? `${signalType}:${source}` : signalType;
  }
}

/**
 * Create an ack registry.
 */
export function createAckRegistry(
  logger: Logger,
  config?: Partial<AckRegistryConfig>
): SignalAckRegistry {
  return new SignalAckRegistry(logger, config);
}
