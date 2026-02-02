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
  async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    await this.ensureLoaded();

    // Reject empty or too short queries
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      this.logger.debug({ query }, 'Search query too short, returning empty');
      return [];
    }

    const limit = options?.limit ?? 10;
    const types = options?.types;
    const recipientId = options?.recipientId;
    const status = options?.status;

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

        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);

    this.logger.debug({ query, results: scored.length, limit }, 'Memory search completed');

    return scored;
  }

  /**
   * Save an entry to memory.
   */
  async save(entry: MemoryEntry): Promise<void> {
    await this.ensureLoaded();

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
   */
  private prune(): void {
    if (this.entries.length <= this.config.maxEntries) return;

    // Sort by timestamp (oldest first) and remove oldest
    this.entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const toRemove = this.entries.length - this.config.maxEntries;
    const removed = this.entries.splice(0, toRemove);

    this.logger.debug({ removed: removed.length }, 'Pruned old memory entries');
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
