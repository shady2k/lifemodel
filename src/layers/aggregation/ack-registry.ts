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
 * Persisted AckRegistry state (JSON-safe).
 */
export interface PersistedAckRegistryState {
  version: number;
  acks: PersistedSignalAck[];
  handledSignalIds: [string, number][]; // [signalId, timestamp] entries
  /** Last proactive contact timestamp (ISO string) - survives restarts */
  lastProactiveContact: string | null;
  savedAt: string;
}

/**
 * SignalAck with Dates as ISO strings.
 */
export interface PersistedSignalAck extends Omit<SignalAck, 'createdAt' | 'deferUntil'> {
  createdAt: string;
  deferUntil: string | null;
}

/** Current version of the persistence format */
export const CURRENT_ACK_REGISTRY_VERSION = 1;

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
  protected readonly logger: Logger;
  private readonly config: AckRegistryConfig;
  protected readonly acks = new Map<string, SignalAck>();
  /** Track handled signal IDs with timestamp for TTL pruning */
  private readonly handledSignalIds = new Map<string, number>();
  /** Max handled signal IDs to track (LRU-style cleanup) */
  private readonly maxHandledIds = 1000;
  /** TTL for handled IDs in ms (1 hour) */
  private readonly handledIdsTtlMs = 60 * 60 * 1000;
  private checkCount = 0;
  /** Last proactive contact timestamp - persisted to survive restarts */
  private lastProactiveContact: Date | null = null;

  constructor(logger: Logger, config: Partial<AckRegistryConfig> = {}) {
    this.logger = logger.child({ component: 'ack-registry' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the last proactive contact timestamp.
   */
  getLastProactiveContact(): Date | null {
    return this.lastProactiveContact;
  }

  /**
   * Set the last proactive contact timestamp (triggers persistence).
   */
  setLastProactiveContact(timestamp: Date | null): void {
    this.lastProactiveContact = timestamp;
    this.onMutate();
  }

  /**
   * Called whenever state changes. Override in subclasses for persistence.
   * Protected hook allows wrapper classes to track ALL state mutations.
   */
  protected onMutate(): void {
    // Subclasses override to trigger persistence
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
    this.onMutate();

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
        this.onMutate();
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
      this.onMutate();
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
        this.onMutate();
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
      this.onMutate();
    }

    return existed;
  }

  /**
   * Clear all acks (e.g., on user message).
   * Also clears lastProactiveContact since user initiated contact.
   */
  clearAll(): void {
    const ackCount = this.acks.size;
    const handledCount = this.handledSignalIds.size;
    const hadProactiveContact = this.lastProactiveContact !== null;
    this.acks.clear();
    this.handledSignalIds.clear();
    this.lastProactiveContact = null;
    this.onMutate();
    this.logger.debug(
      { ackCount, handledCount, clearedProactiveContact: hadProactiveContact },
      'All signal acks cleared'
    );
  }

  /**
   * Get an ack if it exists.
   */
  getAck(signalType: SignalType, source?: SignalSource): SignalAck | undefined {
    const id = this.generateAckId(signalType, source);
    return this.acks.get(id);
  }

  /**
   * Check if a specific signal ID has been handled.
   * Used for thought signals which need per-signal tracking.
   */
  isHandled(signalId: string): boolean {
    const timestamp = this.handledSignalIds.get(signalId);
    if (!timestamp) return false;

    // Check if TTL expired
    if (Date.now() - timestamp > this.handledIdsTtlMs) {
      this.handledSignalIds.delete(signalId);
      return false;
    }
    return true;
  }

  /**
   * Mark a specific signal ID as handled.
   */
  markHandled(signalId: string): void {
    // Prune if exceeding max size (simple LRU: remove oldest entries)
    if (this.handledSignalIds.size >= this.maxHandledIds) {
      this.pruneHandledIds();
    }

    this.handledSignalIds.set(signalId, Date.now());
    this.onMutate();
    this.logger.debug({ signalId }, 'Signal marked as handled');
  }

  /**
   * Prune old handled signal IDs (TTL-based + size limit).
   */
  private pruneHandledIds(): void {
    const now = Date.now();
    let pruned = 0;

    // First pass: remove expired entries
    for (const [id, timestamp] of this.handledSignalIds) {
      if (now - timestamp > this.handledIdsTtlMs) {
        this.handledSignalIds.delete(id);
        pruned++;
      }
    }

    // If still over limit, remove oldest entries
    if (this.handledSignalIds.size >= this.maxHandledIds) {
      const entries = Array.from(this.handledSignalIds.entries()).sort((a, b) => a[1] - b[1]); // Sort by timestamp ascending

      const toRemove = this.handledSignalIds.size - this.maxHandledIds + 100; // Remove 100 extra
      for (let i = 0; i < toRemove && i < entries.length; i++) {
        const entry = entries[i];
        if (entry) {
          this.handledSignalIds.delete(entry[0]);
          pruned++;
        }
      }
    }

    if (pruned > 0) {
      this.logger.debug({ pruned }, 'Handled signal IDs pruned');
    }
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
      this.onMutate();
    }

    return pruned;
  }

  /**
   * Export current state for persistence.
   * Converts Dates to ISO strings for JSON serialization.
   */
  export(): PersistedAckRegistryState {
    const acks: PersistedSignalAck[] = Array.from(this.acks.values()).map((ack) => ({
      ...ack,
      createdAt: ack.createdAt.toISOString(),
      deferUntil: ack.deferUntil?.toISOString() ?? null,
    }));

    // Export handledSignalIds as [signalId, timestamp] tuples
    // Only include non-expired entries (within TTL)
    const now = Date.now();
    const handledIds: [string, number][] = Array.from(this.handledSignalIds.entries())
      .filter(([, timestamp]) => now - timestamp < this.handledIdsTtlMs)
      .map(([signalId, timestamp]) => [signalId, timestamp]);

    return {
      version: CURRENT_ACK_REGISTRY_VERSION,
      acks,
      handledSignalIds: handledIds,
      lastProactiveContact: this.lastProactiveContact?.toISOString() ?? null,
      savedAt: new Date().toISOString(),
    };
  }

  /**
   * Import state from persistence with validation.
   * Converts ISO strings back to Dates, skips invalid/expired entries.
   *
   * Validates all entries before modifying state to prevent corruption
   * if import fails partway through.
   */
  import(state: PersistedAckRegistryState): void {
    // Validate version
    if (state.version !== CURRENT_ACK_REGISTRY_VERSION) {
      throw new Error(
        `Invalid AckRegistry state version: expected ${String(CURRENT_ACK_REGISTRY_VERSION)}, got ${String(state.version)}`
      );
    }

    // Validate structure (hardening against corrupted storage)
    if (!Array.isArray(state.acks)) {
      throw new Error('Invalid AckRegistry state: acks is not an array');
    }
    if (!Array.isArray(state.handledSignalIds)) {
      throw new Error('Invalid AckRegistry state: handledSignalIds is not an array');
    }

    const now = new Date();
    const validAcks = new Map<string, SignalAck>();
    const validHandledIds = new Map<string, number>();
    const validAckTypes: AckType[] = ['handled', 'deferred', 'suppressed'];

    // First pass: validate all entries without modifying state
    for (const ack of state.acks) {
      // Validate id is a string
      if (typeof ack.id !== 'string') {
        this.logger.warn({ id: ack.id }, 'Skipping invalid ack: id is not a string');
        continue;
      }

      // Validate signalType is a string
      if (typeof ack.signalType !== 'string') {
        this.logger.warn(
          { id: ack.id, signalType: ack.signalType },
          'Skipping invalid ack: signalType is not a string'
        );
        continue;
      }

      // Validate ackType is a known value
      if (!validAckTypes.includes(ack.ackType)) {
        this.logger.warn(
          { id: ack.id, ackType: ack.ackType },
          'Skipping invalid ack: unknown ackType'
        );
        continue;
      }

      // Validate createdAt is a valid date
      const createdAt = new Date(ack.createdAt);
      if (isNaN(createdAt.getTime())) {
        this.logger.warn(
          { id: ack.id, createdAt: ack.createdAt },
          'Skipping invalid ack: createdAt is not a valid date'
        );
        continue;
      }

      // Validate deferUntil (if present) is a valid date
      if (ack.deferUntil) {
        const deferUntil = new Date(ack.deferUntil);
        if (isNaN(deferUntil.getTime())) {
          this.logger.warn(
            { id: ack.id, deferUntil: ack.deferUntil },
            'Skipping invalid ack: deferUntil is not a valid date'
          );
          continue;
        }
      }

      // Skip expired deferrals
      if (ack.ackType === 'deferred' && ack.deferUntil) {
        const deferUntil = new Date(ack.deferUntil);
        if (deferUntil <= now) {
          this.logger.debug(
            { id: ack.id, deferUntil: ack.deferUntil },
            'Skipping expired deferral on import'
          );
          continue;
        }
      }

      // Reconstruct ack with Dates
      validAcks.set(ack.id, {
        ...ack,
        createdAt,
        deferUntil: ack.deferUntil ? new Date(ack.deferUntil) : undefined,
      });
    }

    // Validate handledSignalIds (skip expired entries)
    for (const [signalId, timestamp] of state.handledSignalIds) {
      // Validate signalId is a string
      if (typeof signalId !== 'string') {
        this.logger.warn(
          { signalId },
          'Skipping invalid handled signal ID: signalId is not a string'
        );
        continue;
      }

      // Validate timestamp is a number
      if (typeof timestamp !== 'number' || isNaN(timestamp)) {
        this.logger.warn(
          { signalId, timestamp },
          'Skipping invalid handled signal ID: timestamp is not a valid number'
        );
        continue;
      }

      const age = now.getTime() - timestamp;
      if (age < this.handledIdsTtlMs) {
        validHandledIds.set(signalId, timestamp);
      } else {
        this.logger.trace(
          { signalId, age: Math.round(age / 1000) },
          'Skipping expired handled signal ID on import'
        );
      }
    }

    // Second pass: only clear and set if all validation passed
    this.acks.clear();
    this.handledSignalIds.clear();

    for (const [id, ack] of validAcks) {
      this.acks.set(id, ack);
    }

    for (const [id, timestamp] of validHandledIds) {
      this.handledSignalIds.set(id, timestamp);
    }

    // Restore lastProactiveContact (backward compatible - may be missing in old files)
    if (state.lastProactiveContact) {
      const lastContact = new Date(state.lastProactiveContact);
      if (!isNaN(lastContact.getTime())) {
        this.lastProactiveContact = lastContact;
      } else {
        this.logger.warn(
          { lastProactiveContact: state.lastProactiveContact },
          'Invalid lastProactiveContact date, ignoring'
        );
        this.lastProactiveContact = null;
      }
    } else {
      this.lastProactiveContact = null;
    }

    this.logger.debug(
      {
        importedAckCount: this.acks.size,
        originalAckCount: state.acks.length,
        importedHandledCount: this.handledSignalIds.size,
        originalHandledCount: state.handledSignalIds.length,
        lastProactiveContact: this.lastProactiveContact?.toISOString() ?? null,
      },
      'AckRegistry state imported'
    );
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
