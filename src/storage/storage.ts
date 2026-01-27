/**
 * Abstract Storage interface.
 *
 * Provider-agnostic interface for persisting data.
 * Implementations can use JSON files, SQLite, Redis, etc.
 */
export interface Storage {
  /**
   * Load data by key.
   * @returns The data if found, null otherwise
   */
  load(key: string): Promise<unknown>;

  /**
   * Save data with a key.
   * @param key The storage key
   * @param data The data to persist
   */
  save(key: string, data: unknown): Promise<void>;

  /**
   * Delete data by key.
   * @returns true if deleted, false if key didn't exist
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check if a key exists.
   */
  exists(key: string): Promise<boolean>;

  /**
   * List all keys matching a pattern (optional).
   * Not all implementations may support this.
   */
  keys?(pattern?: string): Promise<string[]>;
}
