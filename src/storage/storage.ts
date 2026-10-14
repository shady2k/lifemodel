/** Durable key-value storage backed by the core Postgres store. */
export interface Storage {
  /** Load a value by key; returns null when it is not present. */
  load(key: string): Promise<unknown>;

  /** Save a JSON value by key. */
  save(key: string, data: unknown): Promise<void>;

  /** Delete a value by key; returns true only when a value was deleted. */
  delete(key: string): Promise<boolean>;

  /** Check whether a key exists. */
  exists(key: string): Promise<boolean>;

  /** List keys matching a pattern when supported. */
  keys?(pattern?: string): Promise<string[]>;
}
