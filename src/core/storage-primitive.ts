/**
 * Storage Primitive Implementation
 *
 * Provides namespaced storage access for plugins.
 * Each plugin gets an isolated namespace (plugin:{pluginId}:).
 */

import type { Storage } from '../storage/storage.js';
import type { Logger } from '../types/logger.js';
import type { StoragePrimitive, StorageQueryOptions } from '../types/plugin.js';

/**
 * Configuration for storage primitive.
 */
export interface StoragePrimitiveConfig {
  /** Warning threshold for storage size in MB */
  warningSizeMB: number;

  /** Hard limit for storage size in MB (null = unlimited) */
  maxSizeMB: number | null;
}

const DEFAULT_CONFIG: StoragePrimitiveConfig = {
  warningSizeMB: 50,
  maxSizeMB: null,
};

/**
 * Storage primitive implementation with namespace isolation.
 */
export class StoragePrimitiveImpl implements StoragePrimitive {
  private readonly storage: Storage;
  private readonly pluginId: string;
  private readonly namespace: string;
  private readonly logger: Logger;
  private readonly config: StoragePrimitiveConfig;

  /** Track approximate storage size for warnings */
  private approximateSizeBytes = 0;
  private sizeWarningLogged = false;

  constructor(
    storage: Storage,
    pluginId: string,
    logger: Logger,
    config: Partial<StoragePrimitiveConfig> = {}
  ) {
    this.storage = storage;
    this.pluginId = pluginId;
    this.namespace = `plugin:${pluginId}:`;
    this.logger = logger.child({ component: 'storage-primitive', pluginId });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get a value by key.
   */
  async get<T>(key: string): Promise<T | null> {
    const namespacedKey = this.namespaceKey(key);
    const value = await this.storage.load(namespacedKey);
    return value as T | null;
  }

  /**
   * Set a value.
   */
  async set(key: string, value: unknown): Promise<void> {
    const namespacedKey = this.namespaceKey(key);
    const newValueSize = this.estimateSize(value);

    // Get old value size if key exists (for accurate delta)
    let oldValueSize = 0;
    const existingValue = await this.storage.load(namespacedKey);
    if (existingValue !== null) {
      oldValueSize = this.estimateSize(existingValue);
    }

    const sizeDelta = newValueSize - oldValueSize;

    // Check size limits (only if increasing)
    if (sizeDelta > 0 && this.config.maxSizeMB !== null) {
      const maxBytes = this.config.maxSizeMB * 1024 * 1024;
      if (this.approximateSizeBytes + sizeDelta > maxBytes) {
        throw new Error(
          `Storage limit exceeded for plugin ${this.pluginId}: ${String(this.config.maxSizeMB)}MB`
        );
      }
    }

    // Check warning threshold
    const warningBytes = this.config.warningSizeMB * 1024 * 1024;
    if (!this.sizeWarningLogged && this.approximateSizeBytes + sizeDelta > warningBytes) {
      this.logger.warn(
        {
          pluginId: this.pluginId,
          sizeMB: (this.approximateSizeBytes + sizeDelta) / (1024 * 1024),
        },
        'Plugin storage approaching warning threshold'
      );
      this.sizeWarningLogged = true;
    }

    await this.storage.save(namespacedKey, value);
    this.approximateSizeBytes += sizeDelta;

    // Reset warning if size dropped below threshold
    if (this.approximateSizeBytes < warningBytes) {
      this.sizeWarningLogged = false;
    }
  }

  /**
   * Delete a key.
   */
  async delete(key: string): Promise<boolean> {
    const namespacedKey = this.namespaceKey(key);

    // Get value size before deleting
    const existingValue = await this.storage.load(namespacedKey);
    if (existingValue === null) {
      return false;
    }

    const valueSize = this.estimateSize(existingValue);
    await this.storage.delete(namespacedKey);
    this.approximateSizeBytes = Math.max(0, this.approximateSizeBytes - valueSize);

    // Reset warning if size dropped below threshold
    const warningBytes = this.config.warningSizeMB * 1024 * 1024;
    if (this.approximateSizeBytes < warningBytes) {
      this.sizeWarningLogged = false;
    }

    return true;
  }

  /**
   * List keys matching optional pattern.
   */
  async keys(pattern?: string): Promise<string[]> {
    if (!this.storage.keys) {
      return [];
    }

    // Always prefix with namespace
    const namespacedPattern = pattern ? `${this.namespace}${pattern}` : `${this.namespace}*`;
    const allKeys = await this.storage.keys(namespacedPattern);

    // Strip namespace prefix from results
    return allKeys.map((key) => this.stripNamespace(key));
  }

  /**
   * Query with filters.
   */
  async query<T>(options: StorageQueryOptions): Promise<T[]> {
    const {
      prefix,
      filter,
      limit = 100,
      offset = 0,
      orderBy,
      order,
      includeValues = true,
    } = options;

    // Enforce limits
    const effectiveLimit = Math.min(limit, 1000);

    // Get all keys with prefix
    const keys = await this.keys(`${prefix}*`);

    // Sort keys if requested
    let sortedKeys = keys;
    if (orderBy === 'key') {
      sortedKeys = keys.sort((a, b) =>
        order === 'desc' ? b.localeCompare(a) : a.localeCompare(b)
      );
    }

    // Apply pagination
    const paginatedKeys = sortedKeys.slice(offset, offset + effectiveLimit);

    if (!includeValues) {
      return paginatedKeys as unknown as T[];
    }

    // Load values
    const results: T[] = [];
    for (const key of paginatedKeys) {
      const value = await this.get<T>(key);
      if (value !== null) {
        // Apply filter if provided
        if (filter && !filter(value)) {
          continue;
        }
        results.push(value);
      }
    }

    // If orderBy is createdAt, sort loaded values
    if (orderBy === 'createdAt') {
      results.sort((a, b) => {
        const aDate = (a as Record<string, unknown>)['createdAt'] as string | Date | undefined;
        const bDate = (b as Record<string, unknown>)['createdAt'] as string | Date | undefined;
        if (!aDate || !bDate) return 0;
        const aTime = new Date(aDate).getTime();
        const bTime = new Date(bDate).getTime();
        return order === 'desc' ? bTime - aTime : aTime - bTime;
      });
    }

    return results;
  }

  /**
   * Get all storage data for migration.
   */
  async getAllData(): Promise<Record<string, unknown>> {
    const keys = await this.keys();
    const data: Record<string, unknown> = {};
    for (const key of keys) {
      data[key] = await this.get(key);
    }
    return data;
  }

  /**
   * Restore storage data from migration bundle.
   */
  async restoreData(data: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.set(key, value);
    }
  }

  /**
   * Clear all plugin data.
   */
  async clear(): Promise<void> {
    const keys = await this.keys();
    for (const key of keys) {
      await this.delete(key);
    }
    this.approximateSizeBytes = 0;
    this.sizeWarningLogged = false;
  }

  /**
   * Add namespace prefix to key.
   */
  private namespaceKey(key: string): string {
    return `${this.namespace}${key}`;
  }

  /**
   * Strip namespace prefix from key.
   */
  private stripNamespace(key: string): string {
    if (key.startsWith(this.namespace)) {
      return key.slice(this.namespace.length);
    }
    return key;
  }

  /**
   * Estimate size of a value in bytes.
   */
  private estimateSize(value: unknown): number {
    try {
      return JSON.stringify(value).length * 2; // UTF-16 chars
    } catch {
      return 1024; // Default estimate for non-serializable
    }
  }
}

/**
 * Create a storage primitive for a plugin.
 */
export function createStoragePrimitive(
  storage: Storage,
  pluginId: string,
  logger: Logger,
  config?: Partial<StoragePrimitiveConfig>
): StoragePrimitiveImpl {
  return new StoragePrimitiveImpl(storage, pluginId, logger, config);
}
