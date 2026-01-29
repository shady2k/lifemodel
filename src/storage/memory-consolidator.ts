/**
 * Memory Consolidator
 *
 * Like human memory consolidation during sleep:
 * - Merges duplicate/similar facts
 * - Decays confidence over time
 * - Forgets facts below threshold
 *
 * Triggered during sleep mode transitions (emergence, not polling).
 */

import type { Logger } from '../types/logger.js';
import type { MemoryEntry, MemoryProvider } from '../layers/cognition/tools/registry.js';
import type { ThoughtData } from '../types/signal.js';

/**
 * Configuration for memory consolidation.
 */
export interface MemoryConsolidatorConfig {
  /** Confidence decay half-life in milliseconds (default: 7 days) */
  decayHalfLifeMs: number;

  /** Minimum confidence to keep a fact (default: 0.1) */
  forgetThreshold: number;

  /** Minimum confidence for a fact to be "strong" (default: 0.5) */
  strongThreshold: number;

  /** Maximum age in ms before aggressive decay (default: 30 days) */
  maxAgeMs: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: MemoryConsolidatorConfig = {
  decayHalfLifeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  forgetThreshold: 0.1,
  strongThreshold: 0.5,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

/**
 * Result of consolidation.
 */
export interface ConsolidationResult {
  /** Total entries before consolidation */
  totalBefore: number;

  /** Total entries after consolidation */
  totalAfter: number;

  /** Number of duplicates merged */
  merged: number;

  /** Number of entries forgotten (removed) */
  forgotten: number;

  /** Number of entries with decayed confidence */
  decayed: number;

  /** Duration of consolidation in ms */
  durationMs: number;

  /** Thoughts generated from actionable memories (e.g., reminders) */
  thoughts: ThoughtData[];
}

// FactKey interface removed - using string key for simplicity

/**
 * Memory Consolidator implementation.
 */
export class MemoryConsolidator {
  private readonly logger: Logger;
  private readonly config: MemoryConsolidatorConfig;

  constructor(logger: Logger, config: Partial<MemoryConsolidatorConfig> = {}) {
    this.logger = logger.child({ component: 'memory-consolidator' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run memory consolidation.
   *
   * This is the "sleep consolidation" process:
   * 1. Load all memories
   * 2. Group facts by (chatId, subject, predicate)
   * 3. Merge duplicates within each group
   * 4. Apply confidence decay based on age
   * 5. Remove entries below forget threshold
   * 6. Save consolidated memories
   */
  async consolidate(memoryProvider: MemoryProvider): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const now = new Date();

    this.logger.info('Starting memory consolidation (sleep cycle)');

    // Get all entries (cast to access getAll method)
    const provider = memoryProvider as MemoryProvider & {
      getAll(): Promise<MemoryEntry[]>;
      clear(): Promise<void>;
      save(entry: MemoryEntry): Promise<void>;
    };

    const allEntries = await provider.getAll();
    const totalBefore = allEntries.length;

    if (totalBefore === 0) {
      this.logger.info('No memories to consolidate');
      return {
        totalBefore: 0,
        totalAfter: 0,
        merged: 0,
        forgotten: 0,
        decayed: 0,
        durationMs: Date.now() - startTime,
        thoughts: [],
      };
    }

    // Separate facts from other memory types
    const facts = allEntries.filter((e) => e.type === 'fact');
    const nonFacts = allEntries.filter((e) => e.type !== 'fact');

    this.logger.debug({ facts: facts.length, nonFacts: nonFacts.length }, 'Categorized memories');

    // Group facts by key
    const groups = this.groupFacts(facts);

    // Merge duplicates within each group
    let merged = 0;
    const mergedFacts: MemoryEntry[] = [];

    for (const [key, group] of Array.from(groups.entries())) {
      if (group.length > 1) {
        const mergedEntry = this.mergeFacts(group);
        mergedFacts.push(mergedEntry);
        merged += group.length - 1;

        this.logger.debug(
          {
            key,
            originalCount: group.length,
            mergedContent: mergedEntry.content.slice(0, 50),
          },
          'Merged duplicate facts'
        );
      } else if (group.length === 1 && group[0]) {
        mergedFacts.push(group[0]);
      }
    }

    // Apply decay and filter
    let decayed = 0;
    let forgotten = 0;
    const survivingFacts: MemoryEntry[] = [];

    for (const entry of mergedFacts) {
      const ageMs = now.getTime() - entry.timestamp.getTime();
      const decayedEntry = this.applyDecay(entry, ageMs);
      const entryConfidence = entry.confidence ?? 0.5;
      const decayedConfidence = decayedEntry.confidence ?? 0.5;

      if (decayedConfidence !== entryConfidence) {
        decayed++;
      }

      if (decayedConfidence >= this.config.forgetThreshold) {
        survivingFacts.push(decayedEntry);
      } else {
        forgotten++;
        this.logger.debug(
          {
            content: entry.content.slice(0, 50),
            confidence: decayedConfidence,
          },
          'Forgetting low-confidence memory'
        );
      }
    }

    // Also apply decay to non-facts (thoughts, messages) but with gentler threshold
    const survivingNonFacts: MemoryEntry[] = [];
    for (const entry of nonFacts) {
      const ageMs = now.getTime() - entry.timestamp.getTime();

      // Non-facts decay faster and are forgotten sooner
      if (ageMs > this.config.maxAgeMs) {
        forgotten++;
        continue;
      }

      survivingNonFacts.push(entry);
    }

    // Combine all surviving entries
    const consolidated = [...survivingFacts, ...survivingNonFacts];
    const totalAfter = consolidated.length;

    // Scan for actionable memories (reminders, etc.) and generate thoughts
    const thoughts = this.scanForActionableMemories(survivingFacts);

    // Only update storage if changes were made
    if (merged > 0 || forgotten > 0 || decayed > 0) {
      // Clear and re-save (atomic update)
      await provider.clear();

      for (const entry of consolidated) {
        await provider.save(entry);
      }

      this.logger.info(
        {
          before: totalBefore,
          after: totalAfter,
          merged,
          forgotten,
          decayed,
          thoughtsGenerated: thoughts.length,
        },
        'Memory consolidation complete'
      );
    } else {
      this.logger.info(
        { thoughtsGenerated: thoughts.length },
        'No changes needed during consolidation'
      );
    }

    return {
      totalBefore,
      totalAfter,
      merged,
      forgotten,
      decayed,
      durationMs: Date.now() - startTime,
      thoughts,
    };
  }

  /**
   * Scan facts for actionable memories that should generate thoughts.
   * Looks for reminders, time-based actions, etc.
   */
  private scanForActionableMemories(facts: MemoryEntry[]): ThoughtData[] {
    const thoughts: ThoughtData[] = [];

    for (const fact of facts) {
      // Check for reminder-like content (Russian and English)
      const isReminder =
        (fact.tags?.includes('reminder') ?? false) || /remind|напомн/i.test(fact.content);

      if (isReminder) {
        const content = `Check if time to remind user: ${fact.content}`;
        const dedupeKey = content.toLowerCase().slice(0, 50).replace(/\s+/g, ' ');

        thoughts.push({
          kind: 'thought',
          content,
          triggerSource: 'memory',
          depth: 0, // Root thought
          rootThoughtId: `mem_thought_${fact.id}`,
          dedupeKey,
        });

        this.logger.debug(
          { factId: fact.id, content: fact.content.slice(0, 30) },
          'Generated thought from reminder fact'
        );
      }
    }

    return thoughts;
  }

  /**
   * Group facts by (chatId, subject, predicate).
   */
  private groupFacts(facts: MemoryEntry[]): Map<string, MemoryEntry[]> {
    const groups = new Map<string, MemoryEntry[]>();

    for (const fact of facts) {
      const key = this.getFactKey(fact);
      const existing = groups.get(key) ?? [];
      existing.push(fact);
      groups.set(key, existing);
    }

    return groups;
  }

  /**
   * Get grouping key for a fact.
   */
  private getFactKey(fact: MemoryEntry): string {
    const metadata = fact.metadata as { subject?: string; predicate?: string } | undefined;
    const subject = metadata?.subject ?? '';
    const predicate = metadata?.predicate ?? '';
    const chatId = fact.recipientId ?? 'global';

    // Normalize to lowercase for comparison
    return `${chatId}:${subject.toLowerCase()}:${predicate.toLowerCase()}`;
  }

  /**
   * Merge multiple facts into one.
   *
   * Strategy:
   * - Keep the most specific (longest) object value
   * - Keep highest confidence
   * - Combine all tags
   * - Keep most recent timestamp
   * - Combine evidence
   */
  private mergeFacts(facts: MemoryEntry[]): MemoryEntry {
    // Sort by specificity (content length) and confidence
    const sorted = [...facts].sort((a, b) => {
      // Prefer higher confidence
      const confDiff = (b.confidence ?? 0.5) - (a.confidence ?? 0.5);
      if (Math.abs(confDiff) > 0.1) return confDiff;

      // Then prefer longer content (more specific)
      return b.content.length - a.content.length;
    });

    // We know facts.length > 1 when this is called, so sorted[0] exists
    const best = sorted[0];
    if (!best) {
      // This should never happen, but TypeScript needs the check
      const fallback = facts[0];
      if (!fallback) {
        throw new Error('Unexpected: no facts to merge');
      }
      return fallback;
    }

    const allTags = new Set<string>();
    let latestTimestamp = best.timestamp;
    let highestConfidence = best.confidence ?? 0.5;
    const evidenceParts: string[] = [];

    for (const fact of facts) {
      // Collect all tags
      if (fact.tags) {
        for (const tag of fact.tags) {
          allTags.add(tag);
        }
      }

      // Track latest timestamp
      if (fact.timestamp > latestTimestamp) {
        latestTimestamp = fact.timestamp;
      }

      // Track highest confidence
      if ((fact.confidence ?? 0.5) > highestConfidence) {
        highestConfidence = fact.confidence ?? 0.5;
      }

      // Collect evidence (from content parentheses)
      const evidenceMatch = /\(([^)]+)\)/.exec(fact.content);
      if (evidenceMatch?.[1]) {
        evidenceParts.push(evidenceMatch[1]);
      }
    }

    // Build merged entry
    const merged: MemoryEntry = {
      id: best.id, // Keep original ID
      type: 'fact',
      content: best.content,
      timestamp: latestTimestamp,
      recipientId: best.recipientId,
      tags: Array.from(allTags),
      confidence: highestConfidence,
      metadata: {
        ...best.metadata,
        mergedFrom: facts.length,
        mergedAt: new Date().toISOString(),
      },
    };

    return merged;
  }

  /**
   * Apply confidence decay based on age.
   *
   * Uses exponential decay like the Belief system.
   */
  private applyDecay(entry: MemoryEntry, ageMs: number): MemoryEntry {
    if (ageMs <= 0) return entry;

    const currentConfidence = entry.confidence ?? 0.5;

    // Exponential decay
    const decayFactor = Math.pow(0.5, ageMs / this.config.decayHalfLifeMs);
    let newConfidence = currentConfidence * decayFactor;

    // Strong memories (high evidence count or explicit source) decay slower
    const metadata = entry.metadata as { source?: string; mergedFrom?: number } | undefined;
    if (metadata?.source === 'explicit' || (metadata?.mergedFrom ?? 0) > 2) {
      // Boost confidence floor for well-established facts
      newConfidence = Math.max(newConfidence, this.config.strongThreshold * decayFactor);
    }

    // Floor at forget threshold (will be filtered later if below)
    newConfidence = Math.max(this.config.forgetThreshold * 0.5, newConfidence);

    if (newConfidence === currentConfidence) {
      return entry;
    }

    return {
      ...entry,
      confidence: newConfidence,
    };
  }
}

/**
 * Create a memory consolidator.
 */
export function createMemoryConsolidator(
  logger: Logger,
  config?: Partial<MemoryConsolidatorConfig>
): MemoryConsolidator {
  return new MemoryConsolidator(logger, config);
}
