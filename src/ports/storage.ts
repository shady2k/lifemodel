/**
 * Storage Port - Hexagonal Architecture
 *
 * Defines interfaces for persistent storage.
 * Storage adapters implement this port to provide different backends
 * (JSON files, PostgreSQL, Redis, etc.).
 *
 * Key design principles:
 * - Namespaced storage for plugin isolation
 * - Simple key-value API with query support
 * - Async operations for I/O compatibility
 */

/**
 * Query options for storage search.
 */
export interface StorageQueryOptions {
  /** Filter by key prefix */
  prefix?: string;
  /** Filter by key pattern (glob-style) */
  pattern?: string;
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  orderBy?: 'key' | 'updated';
  /** Sort direction */
  order?: 'asc' | 'desc';
}

/**
 * IStorage - Primary storage port.
 *
 * Basic key-value storage interface.
 * All keys are namespaced to prevent collisions.
 */
export interface IStorage {
  /**
   * Get a value by key.
   * Returns null if key doesn't exist.
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a value for a key.
   * Overwrites existing value if key exists.
   */
  set(key: string, value: unknown): Promise<void>;

  /**
   * Delete a key.
   * Returns true if key existed and was deleted.
   */
  delete(key: string): Promise<boolean>;

  /**
   * List keys matching optional pattern.
   * Pattern uses glob syntax (e.g., "user:*").
   */
  keys(pattern?: string): Promise<string[]>;

  /**
   * Check if a key exists.
   */
  exists?(key: string): Promise<boolean>;

  /**
   * Get multiple keys at once (batch get).
   */
  getMany?<T>(keys: string[]): Promise<Map<string, T>>;

  /**
   * Set multiple keys at once (batch set).
   */
  setMany?(entries: { key: string; value: unknown }[]): Promise<void>;
}

/**
 * INamespacedStorage - Storage scoped to a namespace.
 *
 * Used by plugins to ensure data isolation.
 * All keys are automatically prefixed with the namespace.
 */
export interface INamespacedStorage extends IStorage {
  /** The namespace this storage is scoped to */
  readonly namespace: string;

  /**
   * Query with filters.
   * More powerful than keys() for complex queries.
   */
  query<T>(options: StorageQueryOptions): Promise<T[]>;

  /**
   * Clear all data in this namespace.
   * Use with caution - this is irreversible.
   */
  clear(): Promise<void>;

  /**
   * Get usage statistics for this namespace.
   */
  stats?(): Promise<{ keyCount: number; sizeBytes?: number }>;
}

/**
 * ITransactionalStorage - Storage with transaction support.
 *
 * For operations that need atomicity guarantees.
 */
export interface ITransactionalStorage extends IStorage {
  /**
   * Execute operations in a transaction.
   * All operations succeed or all fail.
   */
  transaction<T>(operations: () => Promise<T>): Promise<T>;

  /**
   * Optimistic locking: get with version.
   */
  getWithVersion(key: string): Promise<{ value: unknown; version: number }>;

  /**
   * Conditional set: only updates if version matches.
   */
  setIfVersion(key: string, value: unknown, expectedVersion: number): Promise<boolean>;
}

/**
 * Factory function type for creating namespaced storage.
 */
export type StorageFactory = (namespace: string) => INamespacedStorage;
