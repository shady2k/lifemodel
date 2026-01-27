/**
 * Change detection using Weber-Fechner Law.
 *
 * Weber-Fechner Law: The just-noticeable difference (JND) between two stimuli
 * is proportional to the magnitude of the stimuli. In other words, we notice
 * relative changes, not absolute changes.
 *
 * Example: A 10% change is noticeable whether the value is 0.1 or 0.9.
 * But a 0.01 absolute change is noticeable at 0.1 (10%), not at 0.9 (1%).
 *
 * This detector determines when a value change is "meaningful" enough
 * to emit a signal. Low alertness = need bigger changes to notice.
 */

/**
 * Configuration for change detection.
 */
export interface ChangeDetectorConfig {
  /** Base relative threshold (default: 0.10 = 10%) */
  baseThreshold: number;

  /** Minimum absolute change to consider (default: 0.01) */
  minAbsoluteChange: number;

  /** Maximum threshold (caps the adjusted threshold) */
  maxThreshold: number;

  /** How much alertness affects sensitivity (0 = no effect, 1 = full effect) */
  alertnessInfluence: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_CHANGE_CONFIG: ChangeDetectorConfig = {
  baseThreshold: 0.10, // 10% relative change
  minAbsoluteChange: 0.01, // Ignore changes smaller than 0.01
  maxThreshold: 0.50, // Cap at 50% (don't become too insensitive)
  alertnessInfluence: 0.5, // Alertness has moderate effect
};

/**
 * Result of change detection.
 */
export interface ChangeResult {
  /** Whether the change is significant */
  isSignificant: boolean;

  /** Absolute change (current - previous) */
  absoluteChange: number;

  /** Relative change (absoluteChange / previous) */
  relativeChange: number;

  /** Threshold that was used */
  threshold: number;

  /** Why the decision was made */
  reason: string;
}

/**
 * Detect if a value change is significant using Weber-Fechner law.
 *
 * @param current Current value
 * @param previous Previous value
 * @param alertness Agent's alertness level (0-1). Higher = more sensitive.
 * @param config Configuration options
 * @returns Change detection result
 */
export function detectChange(
  current: number,
  previous: number,
  alertness: number = 0.5,
  config: ChangeDetectorConfig = DEFAULT_CHANGE_CONFIG
): ChangeResult {
  const absoluteChange = current - previous;
  const absoluteChangeMagnitude = Math.abs(absoluteChange);

  // Handle edge cases
  if (previous === 0) {
    // Can't calculate relative change from zero
    // Use absolute threshold instead
    if (absoluteChangeMagnitude >= config.minAbsoluteChange) {
      return {
        isSignificant: true,
        absoluteChange,
        relativeChange: absoluteChange, // treat as 100% if previous was 0
        threshold: config.minAbsoluteChange,
        reason: 'Change from zero',
      };
    }
    return {
      isSignificant: false,
      absoluteChange,
      relativeChange: 0,
      threshold: config.minAbsoluteChange,
      reason: 'Change from zero too small',
    };
  }

  // Calculate relative change
  const relativeChange = absoluteChange / previous;
  const relativeChangeMagnitude = Math.abs(relativeChange);

  // Adjust threshold based on alertness
  // High alertness (1.0) → lower threshold (more sensitive)
  // Low alertness (0.0) → higher threshold (less sensitive)
  // Formula: threshold = base * (1.5 - alertness * influence)
  // At alertness 1.0, influence 0.5: threshold = base * 1.0 (full sensitivity)
  // At alertness 0.0, influence 0.5: threshold = base * 1.5 (reduced sensitivity)
  const alertnessFactor = 1 + config.alertnessInfluence * (1 - alertness);
  const adjustedThreshold = Math.min(
    config.baseThreshold * alertnessFactor,
    config.maxThreshold
  );

  // Check if change is significant
  if (absoluteChangeMagnitude < config.minAbsoluteChange) {
    return {
      isSignificant: false,
      absoluteChange,
      relativeChange,
      threshold: adjustedThreshold,
      reason: `Absolute change ${absoluteChangeMagnitude.toFixed(4)} below minimum ${config.minAbsoluteChange}`,
    };
  }

  if (relativeChangeMagnitude >= adjustedThreshold) {
    return {
      isSignificant: true,
      absoluteChange,
      relativeChange,
      threshold: adjustedThreshold,
      reason: `Relative change ${(relativeChangeMagnitude * 100).toFixed(1)}% >= threshold ${(adjustedThreshold * 100).toFixed(1)}%`,
    };
  }

  return {
    isSignificant: false,
    absoluteChange,
    relativeChange,
    threshold: adjustedThreshold,
    reason: `Relative change ${(relativeChangeMagnitude * 100).toFixed(1)}% < threshold ${(adjustedThreshold * 100).toFixed(1)}%`,
  };
}

/**
 * Detect if a transition between discrete states is significant.
 *
 * For non-numeric values like alertness mode (alert → relaxed).
 *
 * @param current Current state
 * @param previous Previous state
 * @returns Whether the transition is significant
 */
export function detectTransition<T>(current: T, previous: T): boolean {
  return current !== previous;
}

/**
 * Calculate rate of change over time.
 *
 * @param current Current value
 * @param previous Previous value
 * @param deltaTimeMs Time elapsed in milliseconds
 * @returns Rate of change per second
 */
export function calculateRateOfChange(
  current: number,
  previous: number,
  deltaTimeMs: number
): number {
  if (deltaTimeMs <= 0) return 0;
  const deltaSeconds = deltaTimeMs / 1000;
  return (current - previous) / deltaSeconds;
}

/**
 * Detect if a rate of change is accelerating.
 *
 * Compares current rate to previous rate.
 * Useful for detecting "things are getting worse/better faster".
 *
 * @param currentRate Current rate of change
 * @param previousRate Previous rate of change
 * @param threshold Minimum difference to consider significant (default: 0.1)
 * @returns Whether acceleration is significant and in what direction
 */
export function detectAcceleration(
  currentRate: number,
  previousRate: number,
  threshold: number = 0.1
): { isSignificant: boolean; direction: 'accelerating' | 'decelerating' | 'stable' } {
  const rateDiff = currentRate - previousRate;

  if (Math.abs(rateDiff) < threshold) {
    return { isSignificant: false, direction: 'stable' };
  }

  return {
    isSignificant: true,
    direction: rateDiff > 0 ? 'accelerating' : 'decelerating',
  };
}
