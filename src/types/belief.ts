/**
 * Belief<T> - A value with confidence tracking.
 *
 * Used for inferred/uncertain values where confidence builds over time
 * with more evidence and decays without new signals.
 */

/**
 * Source of the belief.
 */
export type BeliefSource = 'explicit' | 'inferred' | 'default';

/**
 * A belief wraps a value with confidence metadata.
 */
export interface Belief<T> {
  /** The believed value */
  value: T;

  /** Confidence in this belief (0-1) */
  confidence: number;

  /** When this belief was last updated */
  updatedAt: Date;

  /** How many observations support this belief */
  evidenceCount: number;

  /** How the belief was established */
  source: BeliefSource;
}

/**
 * Create a new belief.
 */
export function createBelief<T>(
  value: T,
  confidence = 0.5,
  source: BeliefSource = 'default'
): Belief<T> {
  return {
    value,
    confidence: clamp(confidence),
    updatedAt: new Date(),
    evidenceCount: source === 'default' ? 0 : 1,
    source,
  };
}

/**
 * Update a belief with new evidence.
 *
 * Blends old and new values based on confidence.
 * Increases evidence count and updates timestamp.
 */
export function updateBelief<T>(
  current: Belief<T>,
  newValue: T,
  newConfidence: number,
  source: BeliefSource = 'inferred'
): Belief<T> {
  // If new evidence is more confident, lean toward new value
  // Otherwise, keep current value but boost confidence slightly
  const useNewValue = newConfidence >= current.confidence;

  // Confidence increases with more evidence (diminishing returns)
  const evidenceBoost = Math.min(0.1, 0.05 / Math.sqrt(current.evidenceCount + 1));
  const blendedConfidence = Math.max(current.confidence, newConfidence) + evidenceBoost;

  return {
    value: useNewValue ? newValue : current.value,
    confidence: clamp(blendedConfidence),
    updatedAt: new Date(),
    evidenceCount: current.evidenceCount + 1,
    source: useNewValue ? source : current.source,
  };
}

/**
 * Update a numeric belief by blending values.
 */
export function updateNumericBelief(
  current: Belief<number>,
  newValue: number,
  newConfidence: number,
  source: BeliefSource = 'inferred'
): Belief<number> {
  // Weighted average based on confidence
  const totalConfidence = current.confidence + newConfidence;
  const blendedValue =
    (current.value * current.confidence + newValue * newConfidence) / totalConfidence;

  const evidenceBoost = Math.min(0.1, 0.05 / Math.sqrt(current.evidenceCount + 1));
  const blendedConfidence = Math.max(current.confidence, newConfidence) + evidenceBoost;

  return {
    value: clamp(blendedValue),
    confidence: clamp(blendedConfidence),
    updatedAt: new Date(),
    evidenceCount: current.evidenceCount + 1,
    source,
  };
}

/**
 * Decay belief confidence over time.
 *
 * @param belief - The belief to decay
 * @param elapsedMs - Time elapsed since last update
 * @param halfLifeMs - Time for confidence to halve (default: 1 hour)
 * @param minConfidence - Minimum confidence floor (default: 0.1)
 */
export function decayBelief<T>(
  belief: Belief<T>,
  elapsedMs: number,
  halfLifeMs = 3600000,
  minConfidence = 0.1
): Belief<T> {
  if (elapsedMs <= 0) return belief;

  // Exponential decay
  const decayFactor = Math.pow(0.5, elapsedMs / halfLifeMs);
  const decayedConfidence = Math.max(minConfidence, belief.confidence * decayFactor);

  return {
    ...belief,
    confidence: decayedConfidence,
  };
}

/**
 * Check if a belief is stale (low confidence or old).
 */
export function isBeliefStale(
  belief: Belief<unknown>,
  maxAgeMs = 86400000, // 24 hours
  minConfidence = 0.3
): boolean {
  const age = Date.now() - belief.updatedAt.getTime();
  return age > maxAgeMs || belief.confidence < minConfidence;
}

/**
 * Get the effective value, or default if belief is too uncertain.
 */
export function getBeliefValue<T>(belief: Belief<T>, defaultValue: T, minConfidence = 0.2): T {
  return belief.confidence >= minConfidence ? belief.value : defaultValue;
}

/**
 * Clamp a value between 0 and 1.
 */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
