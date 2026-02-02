import type { Storage } from './storage.js';
import type { Logger } from '../types/index.js';

/**
 * Configuration for DeferredStorage.
 */
export interface DeferredStorageConfig {
  /** Flush interval in ms (default: 30 seconds) */
  flushIntervalMs?: number;
  /** Log flush operations (default: true) */
  logFlush?: boolean;
}

const DEFAULT_CONFIG: Required<DeferredStorageConfig> = {
  flushIntervalMs: 30_000, // 30 seconds
  logFlush: true,
};

/**
 * DeferredStorage - wraps any Storage with write batching.
 *
 * Instead of writing to disk on every save(), changes are cached
 * in memory and flushed periodically. This:
 * - Eliminates race conditions from concurrent writes to same key
 * - Reduces disk I/O by batching multiple writes
 * - Improves performance for write-heavy workloads
 *
 * Usage:
 * ```
 * const jsonStorage = createJSONStorage('data/state');
 * const storage = new DeferredStorage(jsonStorage, logger);
 * storage.startAutoFlush();
 * // ... use storage.save(), storage.load() as normal ...
 * await storage.shutdown(); // flush and cleanup
 * ```
 */
export class DeferredStorage implements Storage {
  private readonly underlying: Storage;
  private readonly logger: Logger;
  private readonly config: Required<DeferredStorageConfig>;

  /** In-memory cache: key -> { data, dirty } */
  private cache = new Map<string, { data: unknown; dirty: boolean }>();

  /** Keys that have been deleted (pending flush) */
  private deletedKeys = new Set<string>();

  /** Auto-flush timer */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Flush in progress (prevents concurrent flushes) */
  private flushing = false;

  constructor(underlying: Storage, logger: Logger, config: Partial<DeferredStorageConfig> = {}) {
    this.underlying = underlying;
    this.logger = logger.child({ component: 'deferred-storage' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load data by key.
   * Returns cached value if available, otherwise loads from underlying storage.
   */
  async load(key: string): Promise<unknown> {
    // Check if deleted
    if (this.deletedKeys.has(key)) {
      return null;
    }

    // Check cache first
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached.data;
    }

    // Load from underlying and cache
    const data = await this.underlying.load(key);
    if (data !== null) {
      this.cache.set(key, { data, dirty: false });
    }
    return data;
  }

  /**
   * Save data with a key.
   * Updates cache and marks dirty - actual write happens on flush.
   */
  save(key: string, data: unknown): Promise<void> {
    // Remove from deleted set if present
    this.deletedKeys.delete(key);

    // Update cache and mark dirty
    this.cache.set(key, { data, dirty: true });

    return Promise.resolve();
  }

  /**
   * Delete data by key.
   * Marks for deletion - actual delete happens on flush.
   */
  async delete(key: string): Promise<boolean> {
    const existed = this.cache.has(key) || (await this.underlying.exists(key));

    // Remove from cache
    this.cache.delete(key);

    // Mark for deletion on flush
    this.deletedKeys.add(key);

    return existed;
  }

  /**
   * Check if a key exists.
   */
  async exists(key: string): Promise<boolean> {
    // Deleted keys don't exist
    if (this.deletedKeys.has(key)) {
      return false;
    }

    // Check cache
    if (this.cache.has(key)) {
      return true;
    }

    // Check underlying
    return this.underlying.exists(key);
  }

  /**
   * List all keys matching a pattern.
   */
  async keys(pattern?: string): Promise<string[]> {
    if (!this.underlying.keys) {
      throw new Error('Underlying storage does not support keys()');
    }

    // Get keys from underlying
    const underlyingKeys = await this.underlying.keys(pattern);

    // Add cached keys that match pattern
    const cachedKeys = Array.from(this.cache.keys());
    const allKeys = new Set([...underlyingKeys, ...cachedKeys]);

    // Remove deleted keys
    for (const key of this.deletedKeys) {
      allKeys.delete(key);
    }

    // Apply pattern filter if needed
    if (pattern) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return Array.from(allKeys).filter((k) => regex.test(k));
    }

    return Array.from(allKeys);
  }

  /**
   * Start auto-flush timer.
   */
  startAutoFlush(): void {
    if (this.flushTimer) {
      return; // Already running
    }

    this.flushTimer = setInterval(() => {
      void this.flush().catch((err: unknown) => {
        this.logger.error({ error: err }, 'Auto-flush failed');
      });
    }, this.config.flushIntervalMs);

    this.logger.debug({ intervalMs: this.config.flushIntervalMs }, 'Auto-flush started');
  }

  /**
   * Stop auto-flush timer.
   */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      this.logger.debug('Auto-flush stopped');
    }
  }

  /**
   * Flush all dirty entries to underlying storage.
   * Safe to call concurrently - will skip if flush already in progress.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.logger.trace('Flush already in progress, skipping');
      return;
    }

    this.flushing = true;

    try {
      // Collect dirty entries
      const dirtyEntries: { key: string; data: unknown }[] = [];
      for (const [key, entry] of this.cache) {
        if (entry.dirty) {
          dirtyEntries.push({ key, data: entry.data });
        }
      }

      // Collect deleted keys
      const keysToDelete = Array.from(this.deletedKeys);

      if (dirtyEntries.length === 0 && keysToDelete.length === 0) {
        return; // Nothing to flush
      }

      // Write dirty entries (sequentially to avoid overwhelming disk)
      for (const { key, data } of dirtyEntries) {
        await this.underlying.save(key, data);
        // Mark as clean after successful write
        const entry = this.cache.get(key);
        if (entry) {
          entry.dirty = false;
        }
      }

      // Delete marked keys
      for (const key of keysToDelete) {
        await this.underlying.delete(key);
        this.deletedKeys.delete(key);
      }

      if (this.config.logFlush && (dirtyEntries.length > 0 || keysToDelete.length > 0)) {
        this.logger.debug(
          {
            written: dirtyEntries.length,
            writtenKeys: dirtyEntries.map((e) => e.key),
            deleted: keysToDelete.length,
            deletedKeys: keysToDelete,
          },
          'Storage flushed'
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Get number of dirty entries pending flush.
   */
  getDirtyCount(): number {
    let count = 0;
    for (const entry of this.cache.values()) {
      if (entry.dirty) count++;
    }
    return count + this.deletedKeys.size;
  }

  /**
   * Shutdown - flush and cleanup.
   */
  async shutdown(): Promise<void> {
    this.stopAutoFlush();
    await this.flush();
    this.cache.clear();
    this.deletedKeys.clear();
    this.logger.debug('Deferred storage shutdown complete');
  }
}

/**
 * Factory function for creating deferred storage.
 */
export function createDeferredStorage(
  underlying: Storage,
  logger: Logger,
  config?: Partial<DeferredStorageConfig>
): DeferredStorage {
  return new DeferredStorage(underlying, logger, config);
}
