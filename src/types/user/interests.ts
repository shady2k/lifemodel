/**
 * User Interests - topic weights and urgency preferences.
 *
 * This is generic user model data representing what topics the user cares about.
 * Used by signal filters (e.g., NewsSignalFilter) to score and prioritize content.
 *
 * Not specific to any plugin - any plugin can query this via UserModel.
 */

/**
 * User's interest configuration.
 *
 * Stored in user model - beliefs about what the user cares about.
 * Used by signal filters to score and prioritize content.
 */
export interface Interests {
  /**
   * Topic weights (learned).
   * - weight > 0 means interested (higher = more interested)
   * - weight === 0 means suppressed/blocked
   * Keys are lowercase topic names.
   */
  weights: Record<string, number>;

  /**
   * Per-topic urgency multiplier.
   * Determines how aggressively to interrupt for this topic.
   * Range: 0-1 (0 = never interrupt, 1 = always interrupt if interesting)
   */
  urgency: Record<string, number>;

  /**
   * Source reputation scores.
   * Default 0.5 if not specified.
   * Range: 0-1 (0 = untrusted, 1 = highly trusted)
   */
  sourceReputation?: Record<string, number> | undefined;

  /**
   * Topic baselines for volume anomaly detection.
   * Used to detect unusual spikes in content volume.
   */
  topicBaselines: Record<
    string,
    {
      /** Average items per fetch for this topic */
      avgVolume: number;
      /** When baseline was last updated */
      lastUpdated: Date;
    }
  >;
}

/**
 * Create default empty interests.
 */
export function createDefaultInterests(): Interests {
  return {
    weights: {},
    urgency: {},
    topicBaselines: {},
  };
}
