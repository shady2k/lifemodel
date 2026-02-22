/**
 * LanceVectorStore — LanceDB-backed implementation of the VectorStore interface.
 *
 * Uses local embeddings (via Embedder) and LanceDB for vector similarity search.
 * Two-phase search: vector retrieval from LanceDB → re-ranking in JS with
 * recency/confidence/salience boosts (preserving the scoring behavior of JsonVectorStore).
 *
 * Storage: LanceDB manages its own files at the configured dbPath.
 * This is intentionally a second persistence path — NOT routed through DeferredStorage.
 */

import type { Logger } from '../types/logger.js';
import type { VectorStore, VectorSearchOptions, VectorSearchResult } from './vector-store.js';
import type { MemoryEntry } from '../layers/cognition/tools/registry.js';
import type { Embedder } from './embedder.js';
import type { Connection, Table } from '@lancedb/lancedb';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface LanceVectorStoreConfig {
  dbPath: string;
  embedder: Embedder;
  tableName?: string | undefined;
  maxEntries?: number | undefined;
}

interface ResolvedConfig {
  dbPath: string;
  embedder: Embedder;
  tableName: string;
  maxEntries: number;
}

// ─── SQL safety ───────────────────────────────────────────────────────────────

/** Escape a value for use inside a SQL single-quoted string literal. */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

// ─── Row type ─────────────────────────────────────────────────────────────────

interface LanceRow {
  id: string;
  type: string;
  content: string;
  timestamp: string;
  recipientId: string | null;
  tags: string | null;
  confidence: number;
  salience: number | null;
  metadata: string | null;
  tickId: string | null;
  parentSignalId: string | null;
  trigger: string | null;
  status: string | null;
  expiresAt: string | null;
  vector: Float32Array;
  _distance?: number | undefined;
}

// ─── Serialization helpers ────────────────────────────────────────────────────

function toRow(entry: MemoryEntry, vector: Float32Array): Record<string, unknown> {
  const ext = entry as MemoryEntry & { salience?: number };
  return {
    id: entry.id,
    type: entry.type,
    content: entry.content,
    timestamp: entry.timestamp.toISOString(),
    recipientId: entry.recipientId ?? null,
    tags: entry.tags ? JSON.stringify(entry.tags) : null,
    confidence: entry.confidence ?? 0.5,
    salience: ext.salience ?? null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    tickId: entry.tickId ?? null,
    parentSignalId: entry.parentSignalId ?? null,
    trigger: entry.trigger ? JSON.stringify(entry.trigger) : null,
    status: entry.status ?? null,
    expiresAt: entry.expiresAt ? entry.expiresAt.toISOString() : null,
    vector: Array.from(vector),
  };
}

function fromRow(row: LanceRow): MemoryEntry {
  const entry: MemoryEntry & { salience?: number } = {
    id: row.id,
    type: row.type as MemoryEntry['type'],
    content: row.content,
    timestamp: new Date(row.timestamp),
    recipientId: row.recipientId ?? undefined,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    confidence: row.confidence,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    tickId: row.tickId ?? undefined,
    parentSignalId: row.parentSignalId ?? undefined,
    trigger: row.trigger ? (JSON.parse(row.trigger) as MemoryEntry['trigger']) : undefined,
    status: (row.status ?? undefined) as MemoryEntry['status'],
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
  };
  if (row.salience != null) entry.salience = row.salience;
  return entry;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class LanceVectorStore implements VectorStore {
  private readonly logger: Logger;
  private readonly config: ResolvedConfig;
  private db: Connection | null = null;
  private table: Table | null = null;

  constructor(logger: Logger, config: LanceVectorStoreConfig) {
    this.logger = logger.child({ component: 'lance-vector-store' });
    this.config = {
      dbPath: config.dbPath,
      embedder: config.embedder,
      tableName: config.tableName ?? 'memories',
      maxEntries: config.maxEntries ?? 10000,
    };
  }

  // ─── Lazy init ──────────────────────────────────────────────────────────────

  private async ensureTable(): Promise<Table> {
    if (this.table) return this.table;

    const lancedb = await import('@lancedb/lancedb');
    this.db = await lancedb.connect(this.config.dbPath);

    const tableName = this.config.tableName;
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(tableName)) {
      this.table = await this.db.openTable(tableName);
      const count = await this.table.countRows();
      this.logger.info({ table: tableName, rows: count }, 'LanceDB table opened');
    } else {
      const arrow = await import('apache-arrow');
      const dims = this.config.embedder.dimensions();
      const schema = new arrow.Schema([
        new arrow.Field('id', new arrow.Utf8()),
        new arrow.Field('type', new arrow.Utf8()),
        new arrow.Field('content', new arrow.Utf8()),
        new arrow.Field('timestamp', new arrow.Utf8()),
        new arrow.Field('recipientId', new arrow.Utf8(), true),
        new arrow.Field('tags', new arrow.Utf8(), true),
        new arrow.Field('confidence', new arrow.Float64()),
        new arrow.Field('salience', new arrow.Float64(), true),
        new arrow.Field('metadata', new arrow.Utf8(), true),
        new arrow.Field('tickId', new arrow.Utf8(), true),
        new arrow.Field('parentSignalId', new arrow.Utf8(), true),
        new arrow.Field('trigger', new arrow.Utf8(), true),
        new arrow.Field('status', new arrow.Utf8(), true),
        new arrow.Field('expiresAt', new arrow.Utf8(), true),
        new arrow.Field(
          'vector',
          new arrow.FixedSizeList(dims, new arrow.Field('item', new arrow.Float32()))
        ),
      ]);

      this.table = await this.db.createEmptyTable(tableName, schema);
      this.logger.info({ table: tableName }, 'LanceDB table created');
    }

    return this.table;
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  async search(options: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const table = await this.ensureTable();

    const query = options.query.trim();
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const types = options.types;
    const recipientId = options.recipientId;
    const status = options.status;
    const minConfidence = options.minConfidence ?? 0;
    const metadataFilter = options.metadata;
    // Empty types array = match nothing (same as JsonVectorStore: .includes() always false)
    if (types?.length === 0) {
      return [];
    }

    const hasFilters =
      types != null ||
      recipientId != null ||
      status != null ||
      minConfidence > 0 ||
      metadataFilter != null;

    // Reject empty queries unless filters are provided (browse mode)
    if (query.length < 2 && !hasFilters) {
      return [];
    }

    const isTextSearch = query.length >= 2;

    // Build SQL WHERE predicates for LanceDB
    const predicates: string[] = [];
    if (types && types.length > 0) {
      const typeList = types.map((t) => `'${escapeSqlString(t)}'`).join(', ');
      predicates.push(`type IN (${typeList})`);
    }
    if (recipientId) {
      predicates.push(`(recipientId IS NULL OR recipientId = '${escapeSqlString(recipientId)}')`);
    }
    if (status) {
      predicates.push(`(status IS NULL OR status = '${escapeSqlString(status)}')`);
    }
    if (minConfidence > 0) {
      predicates.push(`confidence >= ${String(minConfidence)}`);
    }
    const whereClause = predicates.length > 0 ? predicates.join(' AND ') : undefined;

    let candidates: LanceRow[];

    if (isTextSearch) {
      // Phase 1: Vector retrieval
      const queryVec = await this.config.embedder.embed(query);
      const candidateLimit = (limit + offset) * 3;

      let searchQuery = table.vectorSearch(queryVec).distanceType('cosine').limit(candidateLimit);
      if (whereClause) {
        searchQuery = searchQuery.where(whereClause);
      }
      candidates = (await searchQuery.toArray()) as unknown as LanceRow[];

      // Adaptive overfetch: if post-filter reduces too much, retry with more
      if (
        metadataFilter &&
        candidates.length < limit + offset &&
        candidates.length >= candidateLimit
      ) {
        const retryLimit = candidateLimit * 10;
        let retryQuery = table.vectorSearch(queryVec).distanceType('cosine').limit(retryLimit);
        if (whereClause) {
          retryQuery = retryQuery.where(whereClause);
        }
        candidates = (await retryQuery.toArray()) as unknown as LanceRow[];
      }
    } else {
      // Browse mode: no vector search, just filtered scan
      let browseQuery = table.query();
      if (whereClause) {
        browseQuery = browseQuery.where(whereClause);
      }
      candidates = (await browseQuery.toArray()) as unknown as LanceRow[];
    }

    // Post-filter: metadata (can't be done in SQL since it's a JSON string)
    if (metadataFilter) {
      candidates = candidates.filter((row) => {
        if (!row.metadata) return false;
        const meta = JSON.parse(row.metadata) as Record<string, unknown>;
        for (const [key, value] of Object.entries(metadataFilter)) {
          if (meta[key] !== value) return false;
        }
        return true;
      });
    }

    // Phase 2: Re-rank in JS
    const scored: VectorSearchResult[] = [];
    for (const row of candidates) {
      const entry = fromRow(row);
      const ext = entry as MemoryEntry & { salience?: number };

      let score = 0;

      if (isTextSearch) {
        // Convert cosine distance to similarity: similarity = 1 - distance/2
        // LanceDB cosine distance is in [0, 2], similarity in [0, 1]
        const distance = row._distance ?? 2;
        const similarity = Math.max(0, Math.min(1, 1 - distance / 2));
        score = similarity * 10;
      }

      // Recency boost (newer entries score higher, decays over 1 week)
      const ageHours = (Date.now() - entry.timestamp.getTime()) / (1000 * 60 * 60);
      const recencyBoost = Math.max(0, 1 - ageHours / 168);
      score += recencyBoost;

      // Confidence boost
      score += (entry.confidence ?? 0.5) * 3;

      // Salience boost
      if (ext.salience != null) {
        score += ext.salience * 2;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    // Sort by combined score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply pagination
    return scored.slice(offset, offset + limit);
  }

  // ─── Count ──────────────────────────────────────────────────────────────────

  async count(options?: {
    types?: ('message' | 'thought' | 'fact' | 'intention')[];
  }): Promise<number> {
    const table = await this.ensureTable();

    if (!options?.types) {
      return table.countRows();
    }
    if (options.types.length === 0) {
      return 0;
    }

    const typeList = options.types.map((t) => `'${escapeSqlString(t)}'`).join(', ');
    return table.countRows(`type IN (${typeList})`);
  }

  // ─── Save ───────────────────────────────────────────────────────────────────

  async save(entry: MemoryEntry): Promise<void> {
    const table = await this.ensureTable();

    // Upsert for facts: same subject + attribute → update existing entry
    const meta = entry.metadata;
    if (entry.type === 'fact' && meta?.['subject'] && meta['attribute']) {
      // Find existing fact with same subject+attribute
      // Metadata is JSON-serialized, so we must scan and parse
      const existing = (await table
        .query()
        .where(`type = 'fact' AND metadata IS NOT NULL`)
        .toArray()) as unknown as LanceRow[];

      const matchingRow = existing.find((row) => {
        if (!row.metadata) return false;
        const rowMeta = JSON.parse(row.metadata) as Record<string, unknown>;
        return rowMeta['subject'] === meta['subject'] && rowMeta['attribute'] === meta['attribute'];
      });

      if (matchingRow) {
        // Preserve existing ID (ref: vector-store.ts:291)
        entry.id = matchingRow.id;
        await table.delete(`id = '${escapeSqlString(matchingRow.id)}'`);
        const vector = await this.config.embedder.embed(entry.content);
        await table.add([toRow(entry, vector)]);
        this.logger.debug(
          { entryId: entry.id, subject: meta['subject'], attribute: meta['attribute'] },
          'Memory fact upserted (existing updated)'
        );
        await this.pruneIfNeeded();
        return;
      }
    }

    // Check for duplicate ID
    const existingById = (await table
      .query()
      .where(`id = '${escapeSqlString(entry.id)}'`)
      .limit(1)
      .toArray()) as unknown as LanceRow[];

    if (existingById.length > 0) {
      await table.delete(`id = '${escapeSqlString(entry.id)}'`);
    }

    const vector = await this.config.embedder.embed(entry.content);
    await table.add([toRow(entry, vector)]);
    this.logger.debug({ entryId: entry.id, type: entry.type }, 'Memory entry saved');

    await this.pruneIfNeeded();
  }

  // ─── Delete ─────────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const table = await this.ensureTable();

    const existing = (await table
      .query()
      .where(`id = '${escapeSqlString(id)}'`)
      .limit(1)
      .toArray()) as unknown as LanceRow[];

    if (existing.length === 0) return false;

    await table.delete(`id = '${escapeSqlString(id)}'`);
    return true;
  }

  // ─── Get by ID ──────────────────────────────────────────────────────────────

  async getById(id: string): Promise<MemoryEntry | undefined> {
    const table = await this.ensureTable();

    const rows = (await table
      .query()
      .where(`id = '${escapeSqlString(id)}'`)
      .limit(1)
      .toArray()) as unknown as LanceRow[];

    const row = rows[0];
    if (!row) return undefined;
    return fromRow(row);
  }

  // ─── Get all ────────────────────────────────────────────────────────────────

  async getAll(): Promise<MemoryEntry[]> {
    const table = await this.ensureTable();

    const rows = (await table.query().toArray()) as unknown as LanceRow[];
    const entries = rows.map(fromRow);

    // Sort by timestamp desc (newest first) — matches JsonVectorStore behavior
    entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return entries;
  }

  // ─── Clear ──────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    // Ensure DB is initialized (handles clear() before first use)
    await this.ensureTable();
    try {
      if (this.db) await this.db.dropTable(this.config.tableName);
    } catch {
      // Table may not exist
    }
    this.table = null;
    // Recreate empty table
    await this.ensureTable();
    this.logger.info('LanceVectorStore cleared');
  }

  // ─── Persist (no-op) ───────────────────────────────────────────────────────

  async persist(): Promise<void> {
    // LanceDB is immediately durable — no-op
  }

  // ─── Bulk import (migration use) ───────────────────────────────────────────

  async bulkImport(entries: MemoryEntry[], vectors: Float32Array[]): Promise<void> {
    const table = await this.ensureTable();

    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const vector = vectors[i];
      if (entry && vector) {
        rows.push(toRow(entry, vector));
      }
    }
    await table.add(rows);
    this.logger.debug({ count: rows.length }, 'Bulk imported entries');
  }

  // ─── Pruning ────────────────────────────────────────────────────────────────

  private async pruneIfNeeded(): Promise<void> {
    const table = await this.ensureTable();
    const totalCount = await table.countRows();

    if (totalCount <= this.config.maxEntries) return;

    const MAX_PROTECTED_SOUL_THOUGHTS = Math.max(
      1,
      Math.min(10, Math.floor(this.config.maxEntries / 2))
    );

    // Fetch all rows for pruning decisions
    const allRows = (await table.query().toArray()) as unknown as LanceRow[];
    const allEntries = allRows.map(fromRow);

    const protectedEntries: MemoryEntry[] = [];
    const pruneableEntries: MemoryEntry[] = [];

    for (const entry of allEntries) {
      if (this.isProtectedSoulThought(entry)) {
        protectedEntries.push(entry);
      } else {
        pruneableEntries.push(entry);
      }
    }

    // Sort protected by timestamp ascending (oldest first)
    protectedEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Expire excess protected entries (tag mutation: unresolved → expired)
    while (protectedEntries.length > MAX_PROTECTED_SOUL_THOUGHTS) {
      const entry = protectedEntries.shift();
      if (entry?.tags) {
        entry.tags = entry.tags.filter((t) => t !== 'state:unresolved');
        entry.tags.push('state:expired');
        // Update the row in LanceDB
        await table.delete(`id = '${escapeSqlString(entry.id)}'`);
        const vector = await this.config.embedder.embed(entry.content);
        await table.add([toRow(entry, vector)]);
        this.logger.debug({ entryId: entry.id }, 'Soul thought expired due to limit');
      }
      if (entry) pruneableEntries.push(entry);
    }

    const currentTotal = protectedEntries.length + pruneableEntries.length;
    if (currentTotal <= this.config.maxEntries) return;

    const toRemove = currentTotal - this.config.maxEntries;
    pruneableEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const removed = pruneableEntries.slice(0, Math.min(toRemove, pruneableEntries.length));

    // Delete removed entries from LanceDB
    for (const entry of removed) {
      await table.delete(`id = '${escapeSqlString(entry.id)}'`);
    }

    this.logger.debug(
      { removed: removed.length, protected: protectedEntries.length },
      'Pruned old memory entries'
    );
  }

  private isProtectedSoulThought(entry: MemoryEntry): boolean {
    if (entry.type !== 'thought') return false;
    if (!entry.tags || entry.tags.length === 0) return false;
    return entry.tags.includes('state:unresolved') && entry.tags.includes('soul:reflection');
  }
}
