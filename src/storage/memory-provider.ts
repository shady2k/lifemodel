/**
 * Memory Provider
 *
 * Abstracts memory storage for the COGNITION layer.
 * Currently uses JSON files, can be swapped for vector DB later.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../types/logger.js';
import type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchOptions,
} from '../layers/cognition/tools/registry.js';

/**
 * Configuration for JSON memory provider.
 */
export interface JsonMemoryProviderConfig {
  /** Path to memory storage file */
  storagePath: string;

  /** Maximum entries to keep (older entries pruned) */
  maxEntries: number;

  /** Auto-save after each write */
  autoSave: boolean;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: JsonMemoryProviderConfig = {
  storagePath: './data/memory.json',
  maxEntries: 10000,
  autoSave: true,
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
  type: 'message' | 'thought' | 'fact';
  content: string;
  timestamp: string;
  chatId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * JSON-based Memory Provider.
 *
 * Simple implementation using JSON file storage.
 * Search is basic string matching (will be replaced with vector search later).
 */
export class JsonMemoryProvider implements MemoryProvider {
  private readonly config: JsonMemoryProviderConfig;
  private readonly logger: Logger;
  private entries: MemoryEntry[] = [];
  private loaded = false;
  private dirty = false;

  constructor(logger: Logger, config: Partial<JsonMemoryProviderConfig> = {}) {
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
    const chatId = options?.chatId;

    // Normalize query for matching
    const queryLower = trimmedQuery.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

    // Score and filter entries
    const scored = this.entries
      .filter((entry) => {
        // Filter by type
        if (types && !types.includes(entry.type)) {
          return false;
        }
        // Filter by chatId
        if (chatId && entry.chatId !== chatId) {
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

        // Term matches
        for (const term of queryTerms) {
          if (contentLower.includes(term)) {
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

    this.dirty = true;

    // Prune if over limit
    if (this.entries.length > this.config.maxEntries) {
      this.prune();
    }

    if (this.config.autoSave) {
      await this.persist();
    }

    this.logger.debug({ entryId: entry.id, type: entry.type }, 'Memory entry saved');
  }

  /**
   * Get recent entries for a chat.
   */
  async getRecent(chatId: string, limit: number): Promise<MemoryEntry[]> {
    await this.ensureLoaded();

    return this.entries
      .filter((e) => e.chatId === chatId)
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
      this.dirty = true;

      if (this.config.autoSave) {
        await this.persist();
      }

      return true;
    }

    return false;
  }

  /**
   * Clear all entries.
   */
  async clear(): Promise<void> {
    this.entries = [];
    this.dirty = true;

    if (this.config.autoSave) {
      await this.persist();
    }

    this.logger.info('Memory cleared');
  }

  /**
   * Force save to disk.
   */
  async persist(): Promise<void> {
    if (!this.dirty) return;

    try {
      const dir = dirname(this.config.storagePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const store: MemoryStore = {
        version: 1,
        entries: this.entries.map((e) => ({
          id: e.id,
          type: e.type,
          content: e.content,
          timestamp: e.timestamp.toISOString(),
          chatId: e.chatId,
          tags: e.tags,
          confidence: e.confidence,
          metadata: e.metadata,
        })),
      };

      await writeFile(this.config.storagePath, JSON.stringify(store, null, 2), 'utf-8');
      this.dirty = false;

      this.logger.debug(
        { path: this.config.storagePath, entries: this.entries.length },
        'Memory persisted'
      );
    } catch (error) {
      this.logger.error({ error }, 'Failed to persist memory');
      throw error;
    }
  }

  /**
   * Ensure memory is loaded from disk.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      if (existsSync(this.config.storagePath)) {
        const content = await readFile(this.config.storagePath, 'utf-8');
        const store = JSON.parse(content) as MemoryStore;

        this.entries = store.entries.map((e) => ({
          id: e.id,
          type: e.type,
          content: e.content,
          timestamp: new Date(e.timestamp),
          chatId: e.chatId,
          tags: e.tags,
          confidence: e.confidence,
          metadata: e.metadata,
        }));

        this.logger.info({ entries: this.entries.length }, 'Memory loaded from disk');
      } else {
        this.entries = [];
        this.logger.info('No existing memory file, starting fresh');
      }

      this.loaded = true;
    } catch (error) {
      this.logger.error({ error }, 'Failed to load memory');
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
 */
export function createJsonMemoryProvider(
  logger: Logger,
  config?: Partial<JsonMemoryProviderConfig>
): JsonMemoryProvider {
  return new JsonMemoryProvider(logger, config);
}
