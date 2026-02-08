/**
 * Memory Provider
 *
 * Abstracts memory storage for the COGNITION layer.
 * Uses the unified Storage interface for persistence (DeferredStorage).
 */

import type { Storage } from './storage.js';
import type { Logger } from '../types/logger.js';
import type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchOptions,
  RecentByTypeOptions,
  SearchResult,
  BehaviorRuleOptions,
  BehaviorRule,
} from '../layers/cognition/tools/registry.js';

/**
 * Configuration for JSON memory provider.
 */
export interface JsonMemoryProviderConfig {
  /** Storage interface for persistence (DeferredStorage recommended) */
  storage: Storage;

  /** Storage key for memory data */
  storageKey: string;

  /** Maximum entries to keep (older entries pruned) */
  maxEntries: number;
}

/**
 * Default configuration (storage must be provided).
 */
const DEFAULT_CONFIG: Omit<JsonMemoryProviderConfig, 'storage'> = {
  storageKey: 'memory',
  maxEntries: 10000,
};

/**
 * Stored memory format.
 */
interface MemoryStore {
  version: number;
  entries: StoredEntry[];
}

interface StoredEntry {
  id: string;
  type: 'message' | 'thought' | 'fact' | 'intention';
  content: string;
  timestamp: string;
  recipientId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Tick ID for batch grouping */
  tickId?: string | undefined;
  /** Parent signal ID for causal chain */
  parentSignalId?: string | undefined;
  /** Trigger condition for intentions */
  trigger?: { condition: string; keywords?: string[] | undefined } | undefined;
  /** Status for intentions */
  status?: 'pending' | 'completed' | undefined;
  /** ISO string expiry time for intentions with per-entry TTL */
  expiresAt?: string | undefined;
}

/**
 * JSON-based Memory Provider.
 *
 * Simple implementation using Storage interface for persistence.
 * Search is basic string matching (will be replaced with vector search later).
 */
export class JsonMemoryProvider implements MemoryProvider {
  private readonly config: JsonMemoryProviderConfig;
  private readonly logger: Logger;
  private entries: MemoryEntry[] = [];
  private loaded = false;

  constructor(logger: Logger, config: JsonMemoryProviderConfig) {
    this.logger = logger.child({ component: 'memory-provider' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Search memory entries.
   * Currently uses simple string matching. Will be replaced with vector search.
   */
  async search(query: string, options?: MemorySearchOptions): Promise<SearchResult> {
    await this.ensureLoaded();

    // Reject empty or too short queries
    const trimmedQuery = query.trim();
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;

    if (trimmedQuery.length < 2) {
      this.logger.debug({ query }, 'Search query too short, returning empty');
      return {
        entries: [],
        metadata: {
          totalMatched: 0,
          highConfidence: 0,
          mediumConfidence: 0,
          lowConfidence: 0,
          hasMoreResults: false,
          page: 1,
          totalPages: 1,
          offset,
          limit,
        },
      };
    }

    const types = options?.types;
    const recipientId = options?.recipientId;
    const status = options?.status;
    const minConfidence = options?.minConfidence ?? 0;

    // Normalize query for matching
    const queryLower = trimmedQuery.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length >= 2);

    // Score and filter entries
    const scored = this.entries
      .filter((entry) => {
        // Filter by type
        if (types && !types.includes(entry.type)) {
          return false;
        }
        // Filter by recipientId (entries without recipientId are global, always visible)
        if (recipientId && entry.recipientId && entry.recipientId !== recipientId) {
          return false;
        }
        // Filter by status (for intentions only - facts/thoughts don't have status)
        if (status && entry.status !== undefined && entry.status !== status) {
          return false;
        }
        // Filter by minimum confidence
        if (minConfidence > 0 && (entry.confidence ?? 0.5) < minConfidence) {
          return false;
        }
        return true;
      })
      .map((entry) => {
        // Calculate relevance score
        const contentLower = entry.content.toLowerCase();
        let score = 0;

        // Exact phrase match (highest weight)
        if (contentLower.includes(queryLower)) {
          score += 10;
        }

        // Term matches (with word boundary for short terms to avoid false positives)
        for (const term of queryTerms) {
          if (term.length < 4) {
            // Short terms require word boundaries (e.g., "ai" shouldn't match "Yo-Kai")
            // Unicode-aware: \p{L} = letter, \p{N} = number
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
            if (pattern.test(contentLower)) {
              score += 2;
            }
          } else if (contentLower.includes(term)) {
            score += 2;
          }
        }

        // Tag matches
        if (entry.tags) {
          for (const tag of entry.tags) {
            if (queryTerms.includes(tag.toLowerCase())) {
              score += 3;
            }
          }
        }

        // Recency boost (newer entries score slightly higher)
        const ageHours = (Date.now() - entry.timestamp.getTime()) / (1000 * 60 * 60);
        const recencyBoost = Math.max(0, 1 - ageHours / 168); // Decay over 1 week
        score += recencyBoost;

        // Confidence boost - additive to avoid over-penalizing low-confidence entries
        // Real articles (0.4) get +1.2 boost vs filtered facts (0.2) get +0.6 boost
        const confidence = entry.confidence ?? 0.5;
        score += confidence * 3;

        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    // Calculate metadata before slicing
    const totalMatched = scored.length;
    // Thresholds matched to our data: articles are 0.4, filtered are 0.2
    const highConfidence = scored.filter((s) => (s.entry.confidence ?? 0.5) >= 0.5).length;
    const mediumConfidence = scored.filter((s) => {
      const c = s.entry.confidence ?? 0.5;
      return c >= 0.3 && c < 0.5;
    }).length;
    const lowConfidence = scored.filter((s) => (s.entry.confidence ?? 0.5) < 0.3).length;

    // Apply pagination: slice with offset and limit
    const limited = scored.slice(offset, offset + limit).map((item) => item.entry);

    // Calculate pagination metadata
    const totalPages = Math.max(1, Math.ceil(totalMatched / limit));
    const page = Math.floor(offset / limit) + 1;
    const hasMoreResults = offset + limited.length < totalMatched;

    this.logger.debug(
      { query, results: limited.length, totalMatched, limit, offset, page, totalPages },
      'Memory search completed'
    );

    return {
      entries: limited,
      metadata: {
        totalMatched,
        highConfidence,
        mediumConfidence,
        lowConfidence,
        hasMoreResults,
        page,
        totalPages,
        offset,
        limit,
      },
    };
  }

  /**
   * Save an entry to memory.
   */
  async save(entry: MemoryEntry): Promise<void> {
    await this.ensureLoaded();

    // Upsert for facts: same subject + attribute → update existing entry
    const meta = entry.metadata;
    if (entry.type === 'fact' && meta?.['subject'] && meta['attribute']) {
      const subject = meta['subject'] as string;
      const attribute = meta['attribute'] as string;
      const existingFactIndex = this.entries.findIndex(
        (e) =>
          e.type === 'fact' &&
          e.metadata?.['subject'] === subject &&
          e.metadata['attribute'] === attribute
      );
      if (existingFactIndex >= 0) {
        // Preserve original ID, update everything else
        const existing = this.entries[existingFactIndex];
        if (existing) {
          entry.id = existing.id;
        }
        this.entries[existingFactIndex] = entry;
        await this.persist();
        this.logger.debug(
          { entryId: entry.id, subject, attribute },
          'Memory fact upserted (existing updated)'
        );
        return;
      }
    }

    // Check for duplicate ID
    const existingIndex = this.entries.findIndex((e) => e.id === entry.id);
    if (existingIndex >= 0) {
      this.entries[existingIndex] = entry;
    } else {
      this.entries.push(entry);
    }

    // Prune if over limit
    if (this.entries.length > this.config.maxEntries) {
      this.prune();
    }

    // Persist via Storage (DeferredStorage will batch writes)
    await this.persist();

    this.logger.debug({ entryId: entry.id, type: entry.type }, 'Memory entry saved');
  }

  /**
   * Get recent entries for a chat.
   */
  async getRecent(recipientId: string, limit: number): Promise<MemoryEntry[]> {
    await this.ensureLoaded();

    return this.entries
      .filter((e) => e.recipientId === recipientId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get recent entries of a specific type within a time window.
   * Used for context priming (recent thoughts) and neuron calculations.
   */
  async getRecentByType(
    type: 'thought' | 'fact' | 'intention',
    options?: RecentByTypeOptions
  ): Promise<MemoryEntry[]> {
    await this.ensureLoaded();

    const windowMs = options?.windowMs ?? 30 * 60 * 1000; // 30 min default
    const limit = options?.limit ?? 10;
    const excludeIds = new Set(options?.excludeIds ?? []);
    const cutoff = new Date(Date.now() - windowMs);

    return this.entries
      .filter((e) => {
        // Filter by type
        if (e.type !== type) return false;
        // Filter by time window
        if (e.timestamp < cutoff) return false;
        // Filter by recipientId if specified (otherwise include global entries)
        if (options?.recipientId && e.recipientId && e.recipientId !== options.recipientId) {
          return false;
        }
        // Exclude specific IDs
        if (excludeIds.has(e.id)) return false;
        return true;
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get active behavioral rules with read-time decay.
   *
   * Tiered half-life:
   *   - user_feedback: 60-day half-life
   *   - pattern: 21-day half-life
   *
   * Filters out rules with effectiveWeight < 0.1.
   * Cleans up fully-decayed rules (effectiveWeight < 0.05) as side effect.
   */
  async getBehaviorRules(options?: BehaviorRuleOptions): Promise<BehaviorRule[]> {
    await this.ensureLoaded();

    const limit = options?.limit ?? 5;
    const recipientId = options?.recipientId;
    const now = Date.now();

    // Half-life in milliseconds
    const HALF_LIFE_USER_FEEDBACK_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
    const HALF_LIFE_PATTERN_MS = 21 * 24 * 60 * 60 * 1000; // 21 days

    // Filter behavior:rule facts
    const ruleEntries = this.entries.filter((e) => {
      if (e.type !== 'fact') return false;
      if (!e.tags?.includes('behavior:rule') || !e.tags.includes('state:active')) return false;
      // Scope by recipient if requested
      if (recipientId && e.recipientId && e.recipientId !== recipientId) return false;
      return true;
    });

    // Calculate effective weights with decay
    const rulesWithWeight: { entry: MemoryEntry; effectiveWeight: number }[] = [];
    const toDelete: string[] = [];

    for (const entry of ruleEntries) {
      const baseWeight = (entry.metadata?.['weight'] as number | undefined) ?? 1.0;
      const source = (entry.metadata?.['source'] as string | undefined) ?? 'user_feedback';
      const lastReinforcedAt = entry.metadata?.['lastReinforcedAt'] as string | undefined;
      const parsedTime = lastReinforcedAt ? new Date(lastReinforcedAt).getTime() : NaN;
      const referenceTime = Number.isFinite(parsedTime) ? parsedTime : entry.timestamp.getTime();
      // Clamp elapsed to >= 0 to guard against future timestamps (clock skew)
      const elapsed = Math.max(0, now - referenceTime);

      const halfLife = source === 'pattern' ? HALF_LIFE_PATTERN_MS : HALF_LIFE_USER_FEEDBACK_MS;
      const effectiveWeight = baseWeight * Math.pow(0.5, elapsed / halfLife);

      if (effectiveWeight < 0.05) {
        // Fully decayed — schedule for cleanup
        toDelete.push(entry.id);
      } else if (effectiveWeight >= 0.1) {
        rulesWithWeight.push({ entry, effectiveWeight });
      }
      // 0.05 <= effectiveWeight < 0.1: skip (functionally dead but not cleaned up yet)
    }

    // Clean up fully-decayed rules as side effect
    if (toDelete.length > 0) {
      for (const id of toDelete) {
        const index = this.entries.findIndex((e) => e.id === id);
        if (index >= 0) {
          this.entries.splice(index, 1);
        }
      }
      await this.persist();
      this.logger.info({ count: toDelete.length }, 'Cleaned up fully-decayed behavior rules');
    }

    // Sort by effective weight descending, return top N
    return rulesWithWeight.sort((a, b) => b.effectiveWeight - a.effectiveWeight).slice(0, limit);
  }

  /**
   * Get all entries (for debugging).
   */
  async getAll(): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    return [...this.entries];
  }

  /**
   * Delete an entry by ID.
   */
  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const index = this.entries.findIndex((e) => e.id === id);
    if (index >= 0) {
      this.entries.splice(index, 1);
      await this.persist();
      return true;
    }

    return false;
  }

  /**
   * Clear all entries.
   */
  async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
    this.logger.info('Memory cleared');
  }

  /**
   * Persist memory to storage.
   * DeferredStorage will batch writes automatically.
   */
  async persist(): Promise<void> {
    const store: MemoryStore = {
      version: 1,
      entries: this.entries.map((e) => ({
        id: e.id,
        type: e.type,
        content: e.content,
        timestamp: e.timestamp.toISOString(),
        recipientId: e.recipientId,
        tags: e.tags,
        confidence: e.confidence,
        metadata: e.metadata,
        tickId: e.tickId,
        parentSignalId: e.parentSignalId,
        trigger: e.trigger,
        status: e.status,
        expiresAt: e.expiresAt?.toISOString(),
      })),
    };

    await this.config.storage.save(this.config.storageKey, store);

    this.logger.debug({ entries: this.entries.length }, 'Memory persisted');
  }

  /**
   * Ensure memory is loaded from storage.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await this.config.storage.load(this.config.storageKey);

      if (data) {
        const store = data as MemoryStore;
        this.entries = store.entries.map((e) => ({
          id: e.id,
          type: e.type,
          content: e.content,
          timestamp: new Date(e.timestamp),
          recipientId: e.recipientId,
          tags: e.tags,
          confidence: e.confidence,
          metadata: e.metadata,
          tickId: e.tickId,
          parentSignalId: e.parentSignalId,
          trigger: e.trigger as MemoryEntry['trigger'],
          status: e.status,
          expiresAt: e.expiresAt ? new Date(e.expiresAt) : undefined,
        }));
        this.logger.info({ entries: this.entries.length }, 'Memory loaded from storage');
      } else {
        this.entries = [];
        this.logger.info('No existing memory, starting fresh');
      }

      this.loaded = true;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to load memory'
      );
      this.entries = [];
      this.loaded = true;
    }
  }

  /**
   * Prune old entries to stay under limit.
   *
   * Retention rule: Unresolved soul:reflection thoughts are protected from pruning.
   * - Protects entries with type='thought', tags include 'soul:reflection' AND 'state:unresolved'
   * - Max protected = min(10, floor(maxEntries/2)), at least 1
   * - If protected exceeds limit, oldest expires with `state:expired`
   * - maxEntries is always honored (protected entries count toward limit)
   */
  private prune(): void {
    if (this.entries.length <= this.config.maxEntries) return;

    // Max protected entries: min(10, half of maxEntries), but at least 1
    const MAX_PROTECTED_SOUL_THOUGHTS = Math.max(
      1,
      Math.min(10, Math.floor(this.config.maxEntries / 2))
    );

    // Separate protected (unresolved soul:reflection thoughts) from pruneable entries
    const protectedEntries: MemoryEntry[] = [];
    const pruneableEntries: MemoryEntry[] = [];

    for (const entry of this.entries) {
      if (this.isProtectedSoulThought(entry)) {
        protectedEntries.push(entry);
      } else {
        pruneableEntries.push(entry);
      }
    }

    // Sort protected by timestamp (oldest first) for expiration
    protectedEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Expire oldest protected entries if exceeding limit
    while (protectedEntries.length > MAX_PROTECTED_SOUL_THOUGHTS) {
      const entry = protectedEntries.shift();
      if (entry?.tags) {
        // Replace state:unresolved with state:expired
        entry.tags = entry.tags.filter((t) => t !== 'state:unresolved');
        entry.tags.push('state:expired');
        this.logger.debug({ entryId: entry.id }, 'Soul thought expired due to limit');
      }
      // Expired entries become pruneable
      if (entry) pruneableEntries.push(entry);
    }

    // Calculate how many pruneable entries to remove to honor maxEntries
    const targetTotal = this.config.maxEntries;
    const currentTotal = protectedEntries.length + pruneableEntries.length;

    if (currentTotal <= targetTotal) {
      // Reconstruct entries array
      this.entries = [...protectedEntries, ...pruneableEntries];
      return;
    }

    const toRemove = currentTotal - targetTotal;

    // Sort pruneable by timestamp (oldest first) and remove oldest
    pruneableEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const removed = pruneableEntries.splice(0, Math.min(toRemove, pruneableEntries.length));

    // Reconstruct entries array - maxEntries is now honored
    this.entries = [...protectedEntries, ...pruneableEntries];

    this.logger.debug(
      { removed: removed.length, protected: protectedEntries.length },
      'Pruned old memory entries'
    );
  }

  /**
   * Check if an entry is a protected unresolved soul:reflection thought.
   *
   * Only protects:
   * - type: 'thought'
   * - tags include 'soul:reflection'
   * - tags include 'state:unresolved'
   */
  private isProtectedSoulThought(entry: MemoryEntry): boolean {
    if (entry.type !== 'thought') return false;
    if (!entry.tags || entry.tags.length === 0) return false;

    const hasUnresolved = entry.tags.includes('state:unresolved');
    const hasSoulReflection = entry.tags.includes('soul:reflection');

    return hasUnresolved && hasSoulReflection;
  }

  /**
   * Get statistics about memory.
   */
  async getStats(): Promise<{
    totalEntries: number;
    byType: Record<string, number>;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  }> {
    await this.ensureLoaded();

    const byType: Record<string, number> = {};
    let oldest: Date | null = null;
    let newest: Date | null = null;

    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;

      if (!oldest || entry.timestamp < oldest) {
        oldest = entry.timestamp;
      }
      if (!newest || entry.timestamp > newest) {
        newest = entry.timestamp;
      }
    }

    return {
      totalEntries: this.entries.length,
      byType,
      oldestEntry: oldest,
      newestEntry: newest,
    };
  }
}

/**
 * Create a JSON memory provider.
 *
 * @param logger Logger instance
 * @param config Configuration (storage is required)
 */
export function createJsonMemoryProvider(
  logger: Logger,
  config: JsonMemoryProviderConfig
): JsonMemoryProvider {
  return new JsonMemoryProvider(logger, config);
}
