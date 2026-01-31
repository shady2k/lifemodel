/**
 * Text similarity utilities using Jaccard similarity algorithm.
 *
 * Used for thought deduplication to detect semantically similar thoughts
 * even when wording differs slightly.
 */

/** Default similarity threshold (0.85 = 85% similar words) */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/**
 * Tokenize text into normalized words.
 * - Lowercase
 * - Split on whitespace and punctuation
 * - Filter empty strings
 */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[\s\p{P}]+/u) // Split on whitespace and unicode punctuation
    .filter((word) => word.length > 0);

  return new Set(words);
}

/**
 * Calculate Jaccard similarity between two sets.
 *
 * Jaccard index = |A ∩ B| / |A ∪ B|
 *
 * Returns a value between 0 (completely different) and 1 (identical).
 */
export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) {
    return 1; // Both empty = identical
  }

  if (setA.size === 0 || setB.size === 0) {
    return 0; // One empty = no overlap
  }

  // Calculate intersection size
  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const word of smaller) {
    if (larger.has(word)) {
      intersectionSize++;
    }
  }

  // Union size = |A| + |B| - |A ∩ B|
  const unionSize = setA.size + setB.size - intersectionSize;

  return intersectionSize / unionSize;
}

/**
 * Calculate text similarity using Jaccard index on word tokens.
 */
export function textSimilarity(textA: string, textB: string): number {
  return jaccardSimilarity(tokenize(textA), tokenize(textB));
}

/**
 * Entry in the recent thoughts cache for deduplication.
 */
export interface RecentThoughtEntry {
  /** Tokenized word set for efficient similarity comparison */
  tokens: Set<string>;
  /** Original content (for debugging/logging) */
  content: string;
  /** When this thought was recorded */
  timestamp: number;
}

/**
 * Check if text is similar to any recent entry.
 * Returns the matching entry if found, or undefined if no match.
 */
export function findSimilarThought(
  tokens: Set<string>,
  recentThoughts: RecentThoughtEntry[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD
): RecentThoughtEntry | undefined {
  for (const entry of recentThoughts) {
    const similarity = jaccardSimilarity(tokens, entry.tokens);
    if (similarity >= threshold) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Create a recent thought entry from content.
 */
export function createRecentThoughtEntry(content: string, timestamp: number): RecentThoughtEntry {
  return {
    tokens: tokenize(content),
    content,
    timestamp,
  };
}
