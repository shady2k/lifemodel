/**
 * RecipientRegistry - Maps opaque recipientIds to channel routing information.
 *
 * This is a core component of the Clean Architecture:
 * - Plugins use opaque `recipientId` (they don't know about channels)
 * - Core resolves `recipientId` → (channel, destination) for message routing
 *
 * Design:
 * - recipientId is a stable, opaque identifier
 * - Format: "rcpt_{hash}" where hash is derived from channel+destination
 * - Bidirectional lookup: recipientId ↔ (channel, destination)
 *
 * Persistence:
 * - PersistentRecipientRegistry adds auto-save on changes
 * - Uses debounced writes to avoid excessive I/O
 * - Loads from storage on initialization
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../types/logger.js';

/**
 * Routing information for a recipient.
 */
export interface RecipientRoute {
  /** Channel name (e.g., "telegram", "discord") */
  channel: string;
  /** Channel-specific destination (e.g., chatId for Telegram) */
  destination: string;
}

/**
 * Full recipient record with metadata.
 */
export interface RecipientRecord extends RecipientRoute {
  /** Opaque recipient ID */
  recipientId: string;
  /** When this recipient was first registered */
  registeredAt: Date;
  /** When this recipient was last seen */
  lastSeenAt: Date;
}

/**
 * Serialized recipient record for persistence.
 */
export interface SerializedRecipientRecord {
  recipientId: string;
  channel: string;
  destination: string;
  registeredAt: string;
  lastSeenAt: string;
}

/**
 * RecipientRegistry interface for dependency injection.
 */
export interface IRecipientRegistry {
  /**
   * Get or create a recipientId for a channel+destination pair.
   * If the recipient already exists, returns existing ID.
   * If new, creates and stores the mapping.
   */
  getOrCreate(channel: string, destination: string): string;

  /**
   * Resolve a recipientId to its routing information.
   * Returns null if recipientId is not found.
   */
  resolve(recipientId: string): RecipientRoute | null;

  /**
   * Look up a recipientId by channel+destination.
   * Returns null if no mapping exists.
   */
  lookup(channel: string, destination: string): string | null;

  /**
   * Get a copy of the full record for a recipient.
   */
  getRecord(recipientId: string): RecipientRecord | null;

  /**
   * Update the lastSeenAt timestamp for a recipient.
   */
  touch(recipientId: string): void;

  /**
   * Get copies of all registered recipients.
   */
  getAll(): RecipientRecord[];

  /**
   * Get the number of registered recipients.
   */
  size(): number;
}

/**
 * In-memory implementation of RecipientRegistry.
 */
export class RecipientRegistry implements IRecipientRegistry {
  /** recipientId → RecipientRecord */
  private readonly byId = new Map<string, RecipientRecord>();

  /** "channel\0destination" → recipientId (using null separator to avoid ambiguity) */
  private readonly byRoute = new Map<string, string>();

  /**
   * Generate a deterministic recipientId from channel+destination.
   * Uses SHA256 hash truncated to 16 chars for reasonable uniqueness.
   */
  private generateRecipientId(channel: string, destination: string): string {
    const input = `${channel}\0${destination}`;
    const hash = createHash('sha256').update(input).digest('hex').slice(0, 16);
    return `rcpt_${hash}`;
  }

  /**
   * Create an unambiguous route key using null separator.
   */
  private makeRouteKey(channel: string, destination: string): string {
    return `${channel}\0${destination}`;
  }

  /**
   * Clone a record to prevent external mutation.
   */
  private cloneRecord(record: RecipientRecord): RecipientRecord {
    return {
      recipientId: record.recipientId,
      channel: record.channel,
      destination: record.destination,
      registeredAt: new Date(record.registeredAt.getTime()),
      lastSeenAt: new Date(record.lastSeenAt.getTime()),
    };
  }

  getOrCreate(channel: string, destination: string): string {
    const routeKey = this.makeRouteKey(channel, destination);

    // Check if already exists
    const existing = this.byRoute.get(routeKey);
    if (existing) {
      // Consistency check: ensure byId has the record
      const record = this.byId.get(existing);
      if (record) {
        record.lastSeenAt = new Date();
        return existing;
      }
      // Inconsistent state: byRoute points to missing byId entry
      // Repair by removing stale route and falling through to create new
      this.byRoute.delete(routeKey);
    }

    // Generate new recipient ID
    const recipientId = this.generateRecipientId(channel, destination);

    // Collision detection: check if this recipientId already maps to a different route
    const existingRecord = this.byId.get(recipientId);
    if (existingRecord) {
      // Collision detected - this should be extremely rare with 16 hex chars
      // Log and throw to prevent silent data corruption
      throw new Error(
        `RecipientId collision detected: ${recipientId} already maps to ` +
          `${existingRecord.channel}:${existingRecord.destination}, ` +
          `cannot map to ${channel}:${destination}`
      );
    }

    const now = new Date();
    const record: RecipientRecord = {
      recipientId,
      channel,
      destination,
      registeredAt: now,
      lastSeenAt: now,
    };

    this.byId.set(recipientId, record);
    this.byRoute.set(routeKey, recipientId);

    return recipientId;
  }

  resolve(recipientId: string): RecipientRoute | null {
    const record = this.byId.get(recipientId);
    if (!record) {
      return null;
    }
    // Return a copy to prevent mutation
    return {
      channel: record.channel,
      destination: record.destination,
    };
  }

  lookup(channel: string, destination: string): string | null {
    const routeKey = this.makeRouteKey(channel, destination);
    return this.byRoute.get(routeKey) ?? null;
  }

  getRecord(recipientId: string): RecipientRecord | null {
    const record = this.byId.get(recipientId);
    if (!record) {
      return null;
    }
    return this.cloneRecord(record);
  }

  touch(recipientId: string): void {
    const record = this.byId.get(recipientId);
    if (record) {
      record.lastSeenAt = new Date();
    }
  }

  getAll(): RecipientRecord[] {
    return Array.from(this.byId.values()).map((r) => this.cloneRecord(r));
  }

  size(): number {
    return this.byId.size;
  }

  /**
   * Clear all recipients (for testing).
   */
  clear(): void {
    this.byId.clear();
    this.byRoute.clear();
  }

  /**
   * Export all data for persistence (JSON-safe).
   */
  export(): SerializedRecipientRecord[] {
    return Array.from(this.byId.values()).map((r) => ({
      recipientId: r.recipientId,
      channel: r.channel,
      destination: r.destination,
      registeredAt: r.registeredAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    }));
  }

  /**
   * Import data from persistence.
   * Validates and converts serialized records.
   * Throws on collision or duplicate route (indicates corrupted data).
   */
  import(records: SerializedRecipientRecord[]): void {
    // Validate all records before clearing existing data
    const seenIds = new Set<string>();
    const seenRoutes = new Set<string>();

    for (const serialized of records) {
      // Check for duplicate recipientId
      if (seenIds.has(serialized.recipientId)) {
        throw new Error(
          `Import failed: duplicate recipientId '${serialized.recipientId}' in persistence data`
        );
      }
      seenIds.add(serialized.recipientId);

      // Check for duplicate route
      const routeKey = this.makeRouteKey(serialized.channel, serialized.destination);
      if (seenRoutes.has(routeKey)) {
        throw new Error(
          `Import failed: duplicate route '${serialized.channel}:${serialized.destination}' in persistence data`
        );
      }
      seenRoutes.add(routeKey);

      // Validate recipientId format
      if (!serialized.recipientId.startsWith('rcpt_')) {
        throw new Error(
          `Import failed: invalid recipientId format '${serialized.recipientId}' (expected 'rcpt_' prefix)`
        );
      }
    }

    // Validation passed - now import
    this.clear();
    for (const serialized of records) {
      const record: RecipientRecord = {
        recipientId: serialized.recipientId,
        channel: serialized.channel,
        destination: serialized.destination,
        registeredAt: new Date(serialized.registeredAt),
        lastSeenAt: new Date(serialized.lastSeenAt),
      };
      this.byId.set(record.recipientId, record);
      const routeKey = this.makeRouteKey(record.channel, record.destination);
      this.byRoute.set(routeKey, record.recipientId);
    }
  }

  /**
   * Remove a recipient by ID.
   * Returns true if removed, false if not found.
   */
  remove(recipientId: string): boolean {
    const record = this.byId.get(recipientId);
    if (!record) {
      return false;
    }
    const routeKey = this.makeRouteKey(record.channel, record.destination);
    this.byRoute.delete(routeKey);
    this.byId.delete(recipientId);
    return true;
  }
}

/** Configuration for persistent registry. */
export interface PersistentRegistryConfig {
  /** Debounce delay for auto-save in ms (default: 1000) */
  saveDebounceMs?: number;
}

/** RecipientRegistry backed by the core Postgres routing table. */
export class PersistentRecipientRegistry implements IRecipientRegistry {
  private readonly registry = new RecipientRegistry();
  private readonly logger: Logger | undefined;
  private readonly saveDebounceMs: number;
  private saveTimeout: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly deletedRecipientIds = new Set<string>();
  private clearAllPending = false;
  private clearGeneration = 0;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly pool: Pool,
    logger?: Logger,
    config: PersistentRegistryConfig = {}
  ) {
    this.logger = logger?.child({ component: 'recipient-registry' });
    this.saveDebounceMs = config.saveDebounceMs ?? 1000;
  }

  async init(): Promise<void> {
    const { rows } = await this.pool.query<{
      recipient_id: string;
      channel: string;
      destination: string;
      registered_at: Date;
      last_seen_at: Date;
    }>(`SELECT recipient_id, channel, destination, registered_at, last_seen_at
       FROM core.recipient_registry ORDER BY recipient_id`);
    this.registry.import(
      rows.map((row) => ({
        recipientId: row.recipient_id,
        channel: row.channel,
        destination: row.destination,
        registeredAt: new Date(row.registered_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
      }))
    );
    this.logger?.info({ count: this.registry.size() }, 'Loaded recipients from Postgres');
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      void this.save().catch((error: unknown) =>
        this.logger?.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to save recipients'
        )
      );
    }, this.saveDebounceMs);
  }

  private async save(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.dirty) return;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const records = this.registry.export();
        const deletedIds = [...this.deletedRecipientIds];
        const clearGeneration = this.clearGeneration;
        const clearAll = this.clearAllPending;
        let client: PoolClient | null = null;
        let transactionStarted = false;
        let committed = false;
        let failure: unknown;
        try {
          client = await this.pool.connect();
          await client.query('BEGIN');
          transactionStarted = true;
          if (clearAll) await client.query('DELETE FROM core.recipient_registry');
          for (const recipientId of deletedIds) {
            await client.query('DELETE FROM core.recipient_registry WHERE recipient_id = $1', [
              recipientId,
            ]);
          }
          for (const record of records) {
            await client.query(
              `INSERT INTO core.recipient_registry
                 (recipient_id, channel, destination, registered_at, last_seen_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (recipient_id) DO UPDATE SET
                 last_seen_at = GREATEST(core.recipient_registry.last_seen_at, EXCLUDED.last_seen_at)`,
              [
                record.recipientId,
                record.channel,
                record.destination,
                record.registeredAt,
                record.lastSeenAt,
              ]
            );
          }
          await client.query('COMMIT');
          committed = true;
          for (const recipientId of deletedIds) this.deletedRecipientIds.delete(recipientId);
          if (clearAll && this.clearGeneration === clearGeneration) this.clearAllPending = false;
        } catch (error) {
          failure = error;
          if (transactionStarted && client) {
            try {
              await client.query('ROLLBACK');
            } catch {
              /* Preserve the original failure and retry the batch. */
            }
          }
          this.dirty = true;
        }
        if (client) {
          try {
            client.release();
          } catch (error) {
            if (committed) {
              this.dirty = true;
              for (const recipientId of deletedIds) this.deletedRecipientIds.add(recipientId);
              if (clearAll) this.clearAllPending = true;
            }
            failure ??= error;
          }
        }
        if (failure !== undefined) {
          if (failure instanceof Error) throw failure;
          throw new Error(String(failure));
        }
      }
    })();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  async flush(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.save();
  }

  getOrCreate(channel: string, destination: string): string {
    const existing = this.registry.lookup(channel, destination);
    const result = this.registry.getOrCreate(channel, destination);
    if (!existing) this.scheduleSave();
    return result;
  }
  resolve(recipientId: string): RecipientRoute | null {
    return this.registry.resolve(recipientId);
  }
  lookup(channel: string, destination: string): string | null {
    return this.registry.lookup(channel, destination);
  }
  getRecord(recipientId: string): RecipientRecord | null {
    return this.registry.getRecord(recipientId);
  }
  touch(recipientId: string): void {
    this.registry.touch(recipientId);
  }
  getAll(): RecipientRecord[] {
    return this.registry.getAll();
  }
  size(): number {
    return this.registry.size();
  }

  remove(recipientId: string): boolean {
    const removed = this.registry.remove(recipientId);
    if (removed) {
      this.deletedRecipientIds.add(recipientId);
      this.scheduleSave();
    }
    return removed;
  }

  async clear(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.registry.clear();
    this.deletedRecipientIds.clear();
    this.clearAllPending = true;
    this.clearGeneration++;
    this.dirty = true;
    await this.save();
  }

  export(): SerializedRecipientRecord[] {
    return this.registry.export();
  }
}

/** Create a new in-memory RecipientRegistry instance (no persistence). */
export function createRecipientRegistry(): RecipientRegistry {
  return new RecipientRegistry();
}

/** Create a new Postgres-backed registry. Call init() before using it. */
export function createPersistentRecipientRegistry(
  pool: Pool,
  logger?: Logger,
  config?: PersistentRegistryConfig
): PersistentRecipientRegistry {
  return new PersistentRecipientRegistry(pool, logger, config);
}
