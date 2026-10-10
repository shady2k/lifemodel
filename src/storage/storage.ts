/**
 * Abstract Storage interface.
 *
 * Provider-agnostic interface for persisting data.
 * Implementations can use JSON files, SQLite, Redis, etc.
 */
/** Optional controls of one save. */
export interface StorageSaveOptions {
  /**
   * Aborts the save BEFORE its publication point (the atomic rename): the
   * caller's contract is checked right there, so a save whose stop gave up on
   * it never publishes (src/settings/server.ts). Later than that, a rename is
   * atomic and already issued - it cannot be taken back.
   */
  signal?: AbortSignal;
}

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
   * @param options Optional write controls. A `signal` that aborts before
   *   the publication point (the atomic rename) cancels the save with an
   *   `AbortError` and leaves the stored file exactly as it was; a signal that
   *   aborts after the rename cannot un-publish what the rename committed.
   */
  save(key: string, data: unknown, options?: StorageSaveOptions): Promise<void>;

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
