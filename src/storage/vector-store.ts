/**
 * VectorStore — Retrieval/index CRUD for memory entries.
 *
 * Responsible for: storage, search, scoring, persistence.
 * NOT responsible for: domain filtering (behavior rules, type windows, etc.) —
 * those stay on MemoryProvider as orchestration.
 *
 * The Postgres pgvector implementation provides durable vector search.
 */

import type { MemoryEntry } from '../layers/cognition/tools/registry.js';

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Options for vector search.
 */
export interface VectorSearchOptions {
  query: string;
  limit?: number | undefined;
  offset?: number | undefined;
  types?: ('message' | 'thought' | 'fact' | 'intention')[] | undefined;
  recipientId?: string | undefined;
  status?: 'pending' | 'completed' | undefined;
  minConfidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * A scored search result.
 */
export interface VectorSearchResult {
  entry: MemoryEntry;
  score: number;
}

/**
 * VectorStore interface — retrieval/index CRUD.
 *
 * Domain-specific operations (getRecentByType, findByKind, getBehaviorRules)
 * stay on MemoryProvider. The Postgres implementation owns vector persistence and search.
 */
export interface VectorStore {
  search(options: VectorSearchOptions): Promise<VectorSearchResult[]>;
  count(options?: { types?: ('message' | 'thought' | 'fact' | 'intention')[] }): Promise<number>;
  save(entry: MemoryEntry): Promise<void>;
  delete(id: string): Promise<boolean>;
  getById(id: string): Promise<MemoryEntry | undefined>;
  getAll(): Promise<MemoryEntry[]>;
  clear(): Promise<void>;
  persist(): Promise<void>;
}
