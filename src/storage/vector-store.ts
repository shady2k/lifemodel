/**
 * VectorStore — Retrieval/index CRUD for memory entries.
 *
 * Responsible for: storage, search, scoring, persistence.
 * NOT responsible for: domain filtering (behavior rules, type windows, etc.) —
 * those stay on MemoryProvider as orchestration.
 *
 * JsonVectorStore: JSON-backed implementation with TF-IDF-like scoring
 * and an ephemeral inverted index for IDF weighting.
 * Swappable to LanceDB later — only search/save/delete/getById matter.
 */

import type { Storage } from './storage.js';
import type { Logger } from '../types/logger.js';
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
 * stay on MemoryProvider. A LanceDB impl only needs these methods.
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

// ─── Stored format ────────────────────────────────────────────────────────────

interface MemoryStore {
  version: number;
  entries: StoredEntry[];
}

interface StoredEntry {
  id: string;
  type: 'message' | 'thought' | 'fact' | 'intention';
  content: string;
  timestamp: string;
  recipientId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: number | undefined;
  salience?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  tickId?: string | undefined;
  parentSignalId?: string | undefined;
  trigger?: { condition: string; keywords?: string[] | undefined } | undefined;
  status?: 'pending' | 'completed' | undefined;
  expiresAt?: string | undefined;
  /** Reserved for future vector search — never populated now */
  embedding?: number[] | undefined;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface JsonVectorStoreConfig {
  storage: Storage;
  storageKey: string;
  maxEntries: number;
}

const DEFAULT_CONFIG: Omit<JsonVectorStoreConfig, 'storage'> = {
  storageKey: 'memory',
  maxEntries: 10000,
};

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * JSON-backed VectorStore with TF-IDF-like scoring.
 *
 * Scoring components:
 *   - Exact phrase match: +10
 *   - TF-IDF term scoring: tf(term, doc) * idf(term) per query term
 *   - Tag match: +3 per matching tag
 *   - Recency boost: 0-1 decaying over 1 week
 *   - Confidence boost: confidence * 3
 *   - Salience boost: salience * 2 (when present)
 *
 * Inverted index (Map<term, Set<entryId>>) is ephemeral — rebuilt on load,
 * updated on save/delete. Never persisted.
 */
export class JsonVectorStore implements VectorStore {
  private readonly config: JsonVectorStoreConfig;
  private readonly logger: Logger;
  private entries: MemoryEntry[] = [];
  private loaded = false;

  /** Ephemeral inverted index: lowercase term → Set of entry IDs */
  private invertedIndex = new Map<string, Set<string>>();

  constructor(logger: Logger, config: JsonVectorStoreConfig) {
    this.logger = logger.child({ component: 'vector-store' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async search(options: VectorSearchOptions): Promise<VectorSearchResult[]> {
    await this.ensureLoaded();

    const query = options.query.trim();
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const types = options.types;
    const recipientId = options.recipientId;
    const status = options.status;
    const minConfidence = options.minConfidence ?? 0;
    const metadataFilter = options.metadata;
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
    const queryLower = isTextSearch ? query.toLowerCase() : '';
    const queryTerms = isTextSearch ? this.tokenize(queryLower) : [];

    // Total document count for IDF calculation
    const totalDocs = this.entries.length;

    const scored: VectorSearchResult[] = [];

    for (const entry of this.entries) {
      // Apply filters
      if (types && !types.includes(entry.type)) continue;
      if (recipientId && entry.recipientId && entry.recipientId !== recipientId) continue;
      if (status && entry.status !== undefined && entry.status !== status) continue;
      if (minConfidence > 0 && (entry.confidence ?? 0.5) < minConfidence) continue;
      if (metadataFilter) {
        let metadataMatch = true;
        for (const [key, value] of Object.entries(metadataFilter)) {
          if (entry.metadata?.[key] !== value) {
            metadataMatch = false;
            break;
          }
        }
        if (!metadataMatch) continue;
      }

      let score = 0;

      if (isTextSearch) {
        const contentLower = entry.content.toLowerCase();

        // Exact phrase match (highest weight)
        if (contentLower.includes(queryLower)) {
          score += 10;
        }

        // TF-IDF term scoring
        const docTerms = this.tokenize(contentLower);
        const docLength = docTerms.length || 1;

        for (const term of queryTerms) {
          // Term frequency in this document
          let tf: number;
          if (term.length < 4) {
            // Short terms use word-boundary matching (same as original)
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
            const matches = contentLower.match(pattern);
            tf = matches ? matches.length / docLength : 0;
          } else {
            // Count occurrences for longer terms
            let count = 0;
            let pos = 0;
            while ((pos = contentLower.indexOf(term, pos)) !== -1) {
              count++;
              pos += term.length;
            }
            tf = count / docLength;
          }

          if (tf === 0) continue;

          // IDF: log(totalDocs / (1 + docsContainingTerm)), floored so TF still
          // matters when every document contains the term (IDF would otherwise be 0)
          const docsWithTerm = this.invertedIndex.get(term)?.size ?? 0;
          const idf = Math.max(0.1, Math.log((totalDocs + 1) / (1 + docsWithTerm)));

          score += tf * idf * 10; // Scale factor to keep comparable to old scoring
        }

        // Tag matches
        if (entry.tags) {
          for (const tag of entry.tags) {
            if (queryTerms.includes(tag.toLowerCase())) {
              score += 3;
            }
          }
        }
      }

      // Recency boost (newer entries score higher, decays over 1 week)
      const ageHours = (Date.now() - entry.timestamp.getTime()) / (1000 * 60 * 60);
      const recencyBoost = Math.max(0, 1 - ageHours / 168);
      score += recencyBoost;

      // Confidence boost
      const confidence = entry.confidence ?? 0.5;
      score += confidence * 3;

      // Salience boost (when present)
      const salience = (entry as MemoryEntry & { salience?: number }).salience;
      if (salience != null) {
        score += salience * 2;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply pagination
    return scored.slice(offset, offset + limit);
  }

  // ─── Count ────────────────────────────────────────────────────────────────

  async count(options?: {
    types?: ('message' | 'thought' | 'fact' | 'intention')[];
  }): Promise<number> {
    await this.ensureLoaded();
    if (!options?.types) return this.entries.length;
    const types = options.types;
    return this.entries.filter((e) => types.includes(e.type)).length;
  }

  // ─── Save ─────────────────────────────────────────────────────────────────

  async save(entry: MemoryEntry): Promise<void> {
    await this.ensureLoaded();

    // Upsert for facts: same subject + attribute → update existing entry
    const meta = entry.metadata;
    if (entry.type === 'fact' && meta?.['subject'] && meta['attribute']) {
      const subject = meta['subject'] as string;
      const attribute = meta['attribute'] as string;
      const existingFactIndex = this.entries.findIndex(
        (e) =>
          e.type === 'fact' &&
          e.metadata?.['subject'] === subject &&
          e.metadata['attribute'] === attribute
      );
      if (existingFactIndex >= 0) {
        const existing = this.entries[existingFactIndex];
        if (existing) {
          // Remove old entry from inverted index
          this.removeFromIndex(existing);
          entry.id = existing.id;
        }
        this.entries[existingFactIndex] = entry;
        this.addToIndex(entry);
        await this.persist();
        this.logger.debug(
          { entryId: entry.id, subject, attribute },
          'Memory fact upserted (existing updated)'
        );
        return;
      }
    }

    // Check for duplicate ID
    const existingIndex = this.entries.findIndex((e) => e.id === entry.id);
    if (existingIndex >= 0) {
      const existing = this.entries[existingIndex];
      if (existing) {
        this.removeFromIndex(existing);
      }
      this.entries[existingIndex] = entry;
    } else {
      this.entries.push(entry);
    }
    this.addToIndex(entry);

    // Prune if over limit
    if (this.entries.length > this.config.maxEntries) {
      this.prune();
    }

    await this.persist();
    this.logger.debug({ entryId: entry.id, type: entry.type }, 'Memory entry saved');
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const index = this.entries.findIndex((e) => e.id === id);
    if (index >= 0) {
      const entry = this.entries[index];
      if (entry) {
        this.removeFromIndex(entry);
      }
      this.entries.splice(index, 1);
      await this.persist();
      return true;
    }
    return false;
  }

  // ─── Get by ID ────────────────────────────────────────────────────────────

  async getById(id: string): Promise<MemoryEntry | undefined> {
    await this.ensureLoaded();
    return this.entries.find((e) => e.id === id);
  }

  // ─── Get all ──────────────────────────────────────────────────────────────

  async getAll(): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    return [...this.entries];
  }

  // ─── Clear ────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    this.entries = [];
    this.invertedIndex.clear();
    await this.persist();
    this.logger.info('VectorStore cleared');
  }

  // ─── Persist ──────────────────────────────────────────────────────────────

  async persist(): Promise<void> {
    const store: MemoryStore = {
      version: 1,
      entries: this.entries.map((e) => this.toStored(e)),
    };
    await this.config.storage.save(this.config.storageKey, store);
    this.logger.debug({ entries: this.entries.length }, 'VectorStore persisted');
  }

  // ─── Tokenization ────────────────────────────────────────────────────────

  /** Tokenize text into lowercase terms (≥2 chars). */
  private tokenize(text: string): string[] {
    return text.split(/\s+/).filter((t) => t.length >= 2);
  }

  // ─── Inverted index management ────────────────────────────────────────────

  private addToIndex(entry: MemoryEntry): void {
    const terms = this.tokenize(entry.content.toLowerCase());
    for (const term of terms) {
      let set = this.invertedIndex.get(term);
      if (!set) {
        set = new Set();
        this.invertedIndex.set(term, set);
      }
      set.add(entry.id);
    }
  }

  private removeFromIndex(entry: MemoryEntry): void {
    const terms = this.tokenize(entry.content.toLowerCase());
    for (const term of terms) {
      const set = this.invertedIndex.get(term);
      if (set) {
        set.delete(entry.id);
        if (set.size === 0) {
          this.invertedIndex.delete(term);
        }
      }
    }
  }

  private rebuildIndex(): void {
    this.invertedIndex.clear();
    for (const entry of this.entries) {
      this.addToIndex(entry);
    }
  }

  // ─── Storage serialization ────────────────────────────────────────────────

  private toStored(e: MemoryEntry): StoredEntry {
    const stored: StoredEntry = {
      id: e.id,
      type: e.type,
      content: e.content,
      timestamp: e.timestamp.toISOString(),
      recipientId: e.recipientId,
      tags: e.tags,
      confidence: e.confidence,
      metadata: e.metadata,
      tickId: e.tickId,
      parentSignalId: e.parentSignalId,
      trigger: e.trigger,
      status: e.status,
      expiresAt: e.expiresAt?.toISOString(),
    };
    // Preserve salience/embedding if present on the entry
    const ext = e as MemoryEntry & { salience?: number; embedding?: number[] };
    if (ext.salience != null) stored.salience = ext.salience;
    if (ext.embedding != null) stored.embedding = ext.embedding;
    return stored;
  }

  private fromStored(e: StoredEntry): MemoryEntry {
    const entry: MemoryEntry & { salience?: number; embedding?: number[] } = {
      id: e.id,
      type: e.type,
      content: e.content,
      timestamp: new Date(e.timestamp),
      recipientId: e.recipientId,
      tags: e.tags,
      confidence: e.confidence,
      metadata: e.metadata,
      tickId: e.tickId,
      parentSignalId: e.parentSignalId,
      trigger: e.trigger as MemoryEntry['trigger'],
      status: e.status,
      expiresAt: e.expiresAt ? new Date(e.expiresAt) : undefined,
    };
    if (e.salience != null) entry.salience = e.salience;
    if (e.embedding != null) entry.embedding = e.embedding;
    return entry;
  }

  // ─── Pruning ──────────────────────────────────────────────────────────────

  private prune(): void {
    if (this.entries.length <= this.config.maxEntries) return;

    const MAX_PROTECTED_SOUL_THOUGHTS = Math.max(
      1,
      Math.min(10, Math.floor(this.config.maxEntries / 2))
    );

    const protectedEntries: MemoryEntry[] = [];
    const pruneableEntries: MemoryEntry[] = [];

    for (const entry of this.entries) {
      if (this.isProtectedSoulThought(entry)) {
        protectedEntries.push(entry);
      } else {
        pruneableEntries.push(entry);
      }
    }

    protectedEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    while (protectedEntries.length > MAX_PROTECTED_SOUL_THOUGHTS) {
      const entry = protectedEntries.shift();
      if (entry?.tags) {
        entry.tags = entry.tags.filter((t) => t !== 'state:unresolved');
        entry.tags.push('state:expired');
        this.logger.debug({ entryId: entry.id }, 'Soul thought expired due to limit');
      }
      if (entry) pruneableEntries.push(entry);
    }

    const targetTotal = this.config.maxEntries;
    const currentTotal = protectedEntries.length + pruneableEntries.length;

    if (currentTotal <= targetTotal) {
      this.entries = [...protectedEntries, ...pruneableEntries];
      return;
    }

    const toRemove = currentTotal - targetTotal;
    pruneableEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const removed = pruneableEntries.splice(0, Math.min(toRemove, pruneableEntries.length));

    // Update inverted index for removed entries
    for (const entry of removed) {
      this.removeFromIndex(entry);
    }

    this.entries = [...protectedEntries, ...pruneableEntries];

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

  // ─── Loading ──────────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await this.config.storage.load(this.config.storageKey);
      if (data) {
        const store = data as MemoryStore;
        this.entries = store.entries.map((e) => this.fromStored(e));
        this.rebuildIndex();
        this.logger.info({ entries: this.entries.length }, 'VectorStore loaded from storage');
      } else {
        this.entries = [];
        this.logger.info('No existing memory, starting fresh');
      }
      this.loaded = true;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to load VectorStore'
      );
      this.entries = [];
      this.loaded = true;
    }
  }
}
