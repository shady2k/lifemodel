/**
 * Memory Provider
 *
 * Abstracts memory storage for the COGNITION layer.
 * Delegates storage/search to VectorStore, keeps domain-specific
 * operations (getRecentByType, findByKind, getBehaviorRules) as
 * orchestration with in-memory filtering over getAll().
 *
 * GraphStore is accepted but used only for graph-enhanced search
 * (Step 4) and association retrieval.
 */

import type { Storage } from './storage.js';
import type { Logger } from '../types/logger.js';
import type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchOptions,
  RecentByTypeOptions,
  SearchResult,
  AssociationResult,
  BehaviorRuleOptions,
  BehaviorRule,
} from '../layers/cognition/tools/registry.js';
import type { VectorStore } from './vector-store.js';
import { JsonVectorStore } from './vector-store.js';
import type { GraphStore } from './graph-store.js';
import { JsonGraphStore } from './graph-store.js';

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Configuration for JSON memory provider (legacy factory signature).
 */
export interface JsonMemoryProviderConfig {
  /** Storage interface for persistence (DeferredStorage recommended) */
  storage: Storage;
  /** Storage key for memory data */
  storageKey: string;
  /** Maximum entries to keep (older entries pruned) */
  maxEntries: number;
}

/**
 * Dependencies for the new dual-store constructor.
 */
export interface MemoryProviderDeps {
  vectorStore: VectorStore;
  graphStore?: GraphStore;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * JSON-based Memory Provider.
 *
 * Delegates storage CRUD and search to VectorStore.
 * Domain methods (getRecentByType, findByKind, getBehaviorRules) use
 * vectorStore.getAll() + in-memory filtering — these are orchestration
 * that a LanceDB VectorStore wouldn't need to implement.
 */
export class JsonMemoryProvider implements MemoryProvider {
  private readonly logger: Logger;
  readonly vectorStore: VectorStore;
  readonly graphStore: GraphStore | undefined;

  /**
   * Write-invalidated cache for getAll() results.
   * Domain methods (getRecent, getRecentByType, findByKind, getBehaviorRules, getStats)
   * all call getAll() independently — this cache ensures only one round-trip per tick.
   * Invalidated on any write (save, delete, clear).
   */
  private allCache: MemoryEntry[] | null = null;

  constructor(logger: Logger, deps: MemoryProviderDeps) {
    this.logger = logger.child({ component: 'memory-provider' });
    this.vectorStore = deps.vectorStore;
    this.graphStore = deps.graphStore;
  }

  /** Get all entries with write-invalidated caching. */
  private async getAllCached(): Promise<MemoryEntry[]> {
    this.allCache ??= await this.vectorStore.getAll();
    return this.allCache;
  }

  /** Invalidate the getAll cache (called on writes). */
  private invalidateCache(): void {
    this.allCache = null;
  }

  // ─── Search (delegates to VectorStore) ────────────────────────────────────

  async search(query: string, options?: MemorySearchOptions): Promise<SearchResult> {
    const trimmedQuery = query.trim();
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;

    // Single unbounded search — slice for pagination, use full results for metadata.
    const allResults = await this.vectorStore.search({
      query: trimmedQuery,
      limit: 100000,
      offset: 0,
      types: options?.types,
      recipientId: options?.recipientId,
      status: options?.status,
      minConfidence: options?.minConfidence,
      metadata: options?.metadata,
    });

    // Filter by since if provided (before pagination so counts are correct)
    const sinceDate = options?.since;
    const filtered = sinceDate
      ? allResults.filter((r) => r.entry.timestamp >= sinceDate)
      : allResults;

    const totalMatched = filtered.length;
    const entries = filtered.slice(offset, offset + limit).map((r) => r.entry);

    let highConfidence = 0;
    let mediumConfidence = 0;
    let lowConfidence = 0;
    for (const s of filtered) {
      const c = s.entry.confidence ?? 0.5;
      if (c >= 0.5) highConfidence++;
      else if (c >= 0.3) mediumConfidence++;
      else lowConfidence++;
    }

    const totalPages = Math.max(1, Math.ceil(totalMatched / limit));
    const page = Math.floor(offset / limit) + 1;
    const hasMoreResults = offset + entries.length < totalMatched;

    this.logger.debug(
      {
        query: trimmedQuery || undefined,
        results: entries.length,
        totalMatched,
        limit,
        offset,
        page,
        totalPages,
      },
      'Memory search completed'
    );

    return {
      entries,
      metadata: {
        totalMatched,
        highConfidence,
        mediumConfidence,
        lowConfidence,
        hasMoreResults,
        page,
        totalPages,
        offset,
        limit,
      },
    };
  }

  // ─── Save / Delete / GetById (delegates to VectorStore) ───────────────────

  async save(entry: MemoryEntry): Promise<void> {
    this.invalidateCache();
    await this.vectorStore.save(entry);
  }

  async delete(id: string): Promise<boolean> {
    this.invalidateCache();
    return this.vectorStore.delete(id);
  }

  async getById(id: string): Promise<MemoryEntry | undefined> {
    return this.vectorStore.getById(id);
  }

  async getAll(): Promise<MemoryEntry[]> {
    return this.vectorStore.getAll();
  }

  async clear(): Promise<void> {
    this.invalidateCache();
    await this.vectorStore.clear();
  }

  async persist(): Promise<void> {
    await this.vectorStore.persist();
  }

  // ─── Domain methods (orchestration over getAll + in-memory filtering) ─────

  async getRecent(recipientId: string, limit: number): Promise<MemoryEntry[]> {
    const all = await this.getAllCached();
    return all
      .filter((e) => e.recipientId === recipientId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async getRecentByType(
    type: 'thought' | 'fact' | 'intention',
    options?: RecentByTypeOptions
  ): Promise<MemoryEntry[]> {
    const all = await this.getAllCached();

    const windowMs = options?.windowMs ?? 30 * 60 * 1000;
    const limit = options?.limit ?? 10;
    const excludeIds = new Set(options?.excludeIds ?? []);
    const cutoff = new Date(Date.now() - windowMs);

    return all
      .filter((e) => {
        if (e.type !== type) return false;
        if (e.timestamp < cutoff) return false;
        if (options?.recipientId && e.recipientId && e.recipientId !== options.recipientId) {
          return false;
        }
        if (excludeIds.has(e.id)) return false;
        return true;
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async findByKind(
    kind: string,
    options?: {
      state?: string | undefined;
      recipientId?: string | undefined;
      limit?: number | undefined;
    }
  ): Promise<MemoryEntry[]> {
    const all = await this.getAllCached();

    const state = options?.state;
    const recipientId = options?.recipientId;
    const limit = options?.limit ?? 50;

    const results: MemoryEntry[] = [];
    for (const entry of all) {
      if (entry.metadata?.['kind'] !== kind) continue;
      if (state && !entry.tags?.includes(`state:${state}`)) continue;
      if (recipientId && entry.recipientId && entry.recipientId !== recipientId) continue;
      results.push(entry);
      if (results.length >= limit) break;
    }

    this.logger.debug({ kind, state, results: results.length }, 'findByKind completed');
    return results;
  }

  async getBehaviorRules(options?: BehaviorRuleOptions): Promise<BehaviorRule[]> {
    const all = await this.getAllCached();

    const limit = options?.limit ?? 5;
    const recipientId = options?.recipientId;
    const now = Date.now();

    const HALF_LIFE_USER_FEEDBACK_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
    const HALF_LIFE_PATTERN_MS = 21 * 24 * 60 * 60 * 1000; // 21 days

    const ruleEntries = all.filter((e) => {
      if (e.type !== 'fact') return false;
      if (!e.tags?.includes('behavior:rule') || !e.tags.includes('state:active')) return false;
      if (recipientId && e.recipientId && e.recipientId !== recipientId) return false;
      return true;
    });

    const rulesWithWeight: { entry: MemoryEntry; effectiveWeight: number }[] = [];
    const toDelete: string[] = [];

    for (const entry of ruleEntries) {
      const baseWeight = (entry.metadata?.['weight'] as number | undefined) ?? 1.0;
      const source = (entry.metadata?.['source'] as string | undefined) ?? 'user_feedback';
      const lastReinforcedAt = entry.metadata?.['lastReinforcedAt'] as string | undefined;
      const parsedTime = lastReinforcedAt ? new Date(lastReinforcedAt).getTime() : NaN;
      const referenceTime = Number.isFinite(parsedTime) ? parsedTime : entry.timestamp.getTime();
      const elapsed = Math.max(0, now - referenceTime);

      const halfLife =
        source === 'pattern' || source === 'implicit_correction'
          ? HALF_LIFE_PATTERN_MS
          : HALF_LIFE_USER_FEEDBACK_MS;
      const effectiveWeight = baseWeight * Math.pow(0.5, elapsed / halfLife);

      if (effectiveWeight < 0.05) {
        toDelete.push(entry.id);
      } else if (effectiveWeight >= 0.1) {
        rulesWithWeight.push({ entry, effectiveWeight });
      }
    }

    // Clean up fully-decayed rules as side effect
    if (toDelete.length > 0) {
      for (const id of toDelete) {
        await this.vectorStore.delete(id);
      }
      this.invalidateCache();
      this.logger.info({ count: toDelete.length }, 'Cleaned up fully-decayed behavior rules');
    }

    return rulesWithWeight.sort((a, b) => b.effectiveWeight - a.effectiveWeight).slice(0, limit);
  }

  async getLatestByKind(kind: string, recipientId?: string): Promise<MemoryEntry | undefined> {
    const all = await this.getAllCached();
    let latest: MemoryEntry | undefined;

    for (const entry of all) {
      if (entry.metadata?.['kind'] !== kind) continue;
      if (recipientId && entry.recipientId !== recipientId) continue;
      if (!latest || entry.timestamp > latest.timestamp) {
        latest = entry;
      }
    }

    return latest;
  }

  // ─── Associations (graph-enhanced) ─────────────────────────────────────────

  async getAssociations(inputText: string, limit = 5): Promise<AssociationResult> {
    const empty: AssociationResult = { directMatches: [], relatedContext: [], openCommitments: [] };

    // Direct vector search (always available)
    const directResults = await this.vectorStore.search({
      query: inputText,
      limit: Math.min(limit, 3), // Hard cap: max 3 direct
    });
    const directMatches = directResults.map((r) => r.entry);

    if (!this.graphStore) {
      return { ...empty, directMatches };
    }

    // Extract key terms and find matching entities
    const terms = inputText
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .map((t) => t.replace(/[.,!?;:'"]/g, ''));

    const seedEntities: { entityId: string; activation: number }[] = [];
    const seenEntityIds = new Set<string>();

    for (const term of terms) {
      const entity = await this.graphStore.findEntity(term);
      if (entity && !seenEntityIds.has(entity.id)) {
        seedEntities.push({ entityId: entity.id, activation: 1.0 });
        seenEntityIds.add(entity.id);
      }
    }

    if (seedEntities.length === 0) {
      return { ...empty, directMatches };
    }

    // Spreading activation from found entities
    const activationResults = await this.graphStore.spreadingActivation({
      seeds: seedEntities,
      decayFactor: 0.5,
      limit: Math.min(limit, 5),
    });

    // Fetch source memory entries for activated entities
    const directIds = new Set(directMatches.map((e) => e.id));
    const relatedContext: { entry: MemoryEntry; via: string }[] = [];

    for (const result of activationResults) {
      if (relatedContext.length >= 2) break; // Hard cap: max 2 related

      for (const memId of result.entity.sourceMemoryIds) {
        if (directIds.has(memId)) continue; // Skip duplicates from direct search
        const entry = await this.vectorStore.getById(memId);
        if (entry) {
          relatedContext.push({ entry, via: result.via });
          directIds.add(memId); // Prevent further duplicates
          break; // One entry per activated entity
        }
      }
    }

    // Find open commitments linked to mentioned entities
    const commitmentEntries = await this.findByKind('commitment', { state: 'active', limit: 10 });
    const openCommitments: MemoryEntry[] = [];
    for (const commitment of commitmentEntries) {
      if (openCommitments.length >= 2) break; // Hard cap: max 2 commitments
      if (directIds.has(commitment.id)) continue;

      // Check if commitment content mentions any of the found entities
      const contentLower = commitment.content.toLowerCase();
      let relevant = false;
      for (const seed of seedEntities) {
        const entity = await this.graphStore.getEntity(seed.entityId);
        if (entity && contentLower.includes(entity.name.toLowerCase())) {
          relevant = true;
          break;
        }
      }
      if (relevant) {
        openCommitments.push(commitment);
        directIds.add(commitment.id);
      }
    }

    this.logger.debug(
      {
        direct: directMatches.length,
        related: relatedContext.length,
        commitments: openCommitments.length,
        seeds: seedEntities.length,
      },
      'Associations retrieved'
    );

    return { directMatches, relatedContext, openCommitments };
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats(): Promise<{
    totalEntries: number;
    byType: Record<string, number>;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  }> {
    const entries = await this.getAllCached();

    const byType: Record<string, number> = {};
    let oldest: Date | null = null;
    let newest: Date | null = null;

    for (const entry of entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      if (!oldest || entry.timestamp < oldest) oldest = entry.timestamp;
      if (!newest || entry.timestamp > newest) newest = entry.timestamp;
    }

    return { totalEntries: entries.length, byType, oldestEntry: oldest, newestEntry: newest };
  }
}

// ─── Factory (backward-compatible) ──────────────────────────────────────────

/**
 * Create a JSON memory provider.
 *
 * Transitional factory that creates VectorStore + GraphStore internally.
 * Existing callers pass the old { storage, storageKey, maxEntries } config.
 */
export function createJsonMemoryProvider(
  logger: Logger,
  config: JsonMemoryProviderConfig
): JsonMemoryProvider {
  const vectorStore = new JsonVectorStore(logger, {
    storage: config.storage,
    storageKey: config.storageKey,
    maxEntries: config.maxEntries,
  });
  const graphStore = new JsonGraphStore(logger, {
    storage: config.storage,
    storageKey: 'graph',
  });
  return new JsonMemoryProvider(logger, { vectorStore, graphStore });
}
