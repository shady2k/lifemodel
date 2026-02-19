/**
 * GraphStore — Entity/relation graph for associative memory.
 *
 * Stores entities (people, places, topics) and relations between them.
 * Supports BFS traversal and spreading activation for associative recall.
 *
 * JsonGraphStore: JSON-backed implementation with in-memory adjacency maps.
 * Populated during sleep-cycle consolidation via LLM entity extraction.
 * Swappable to Kuzu or Neo4j later.
 */

import type { Storage } from './storage.js';
import type { Logger } from '../types/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntityType =
  | 'person'
  | 'place'
  | 'organization'
  | 'topic'
  | 'event'
  | 'concept'
  | 'thing';

export type RelationType =
  | 'about'
  | 'related_to'
  | 'married_to'
  | 'works_at'
  | 'lives_in'
  | 'friend_of'
  | 'parent_of'
  | 'child_of'
  | 'sibling_of'
  | 'colleague_of'
  | 'member_of'
  | 'part_of'
  | 'owns'
  | 'likes'
  | 'dislikes'
  | 'interested_in'
  | 'committed_to'
  | 'attended'
  | 'created'
  | 'mentioned_in';

export interface GraphEntity {
  id: string; // ent_xxxx
  name: string; // canonical name
  aliases: string[]; // alternate names
  type: EntityType;
  description?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  lastActivated: string; // ISO datetime
  sourceMemoryIds: string[];
}

export interface GraphRelation {
  id: string; // rel_xxxx
  fromId: string;
  toId: string;
  type: RelationType;
  strength: number; // 0-1
  confidence: number; // 0-1
  sourceTraceId?: string;
  lastActivated: string; // ISO datetime
  sourceMemoryIds: string[];
}

// ─── Traversal types ──────────────────────────────────────────────────────────

export interface TraversalOptions {
  startEntityId: string;
  maxHops: number;
  direction?: 'from' | 'to' | 'both';
  minStrength?: number;
  minConfidence?: number;
  relationTypes?: RelationType[];
  limit?: number;
}

export interface TraversalResult {
  entity: GraphEntity;
  path: GraphRelation[];
  hops: number;
  /** Product of relation strengths along the path */
  pathStrength: number;
}

export interface SpreadingActivationOptions {
  seeds: { entityId: string; activation: number }[];
  decayFactor?: number; // Per-hop decay (default: 0.5)
  threshold?: number; // Minimum activation to continue (default: 0.1)
  maxIterations?: number; // Max propagation steps (default: 3)
  limit?: number; // Max results to return
}

export interface ActivationResult {
  entity: GraphEntity;
  activation: number;
  /** Human-readable path description, e.g. "John → married_to → Sarah" */
  via: string;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface GraphStore {
  upsertEntity(entity: GraphEntity): Promise<void>;
  upsertRelation(relation: GraphRelation): Promise<void>;
  getEntity(id: string): Promise<GraphEntity | undefined>;
  findEntity(nameOrAlias: string): Promise<GraphEntity | undefined>;
  getRelations(entityId: string, direction?: 'from' | 'to' | 'both'): Promise<GraphRelation[]>;
  traverse(options: TraversalOptions): Promise<TraversalResult[]>;
  spreadingActivation(options: SpreadingActivationOptions): Promise<ActivationResult[]>;
  deleteEntity(id: string): Promise<void>;
  deleteRelation(id: string): Promise<void>;
  getAllEntities(): Promise<GraphEntity[]>;
  getAllRelations(): Promise<GraphRelation[]>;
  persist(): Promise<void>;
  clear(): Promise<void>;
}

// ─── Stored format ────────────────────────────────────────────────────────────

interface GraphStoreData {
  version: number;
  entities: GraphEntity[];
  relations: GraphRelation[];
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface JsonGraphStoreConfig {
  storage: Storage;
  storageKey: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class JsonGraphStore implements GraphStore {
  private readonly logger: Logger;
  private readonly config: JsonGraphStoreConfig;
  private loaded = false;

  // Primary storage
  private entities = new Map<string, GraphEntity>();
  private relations = new Map<string, GraphRelation>();

  // Adjacency indexes
  private outEdges = new Map<string, Set<string>>(); // entityId → Set<relationId>
  private inEdges = new Map<string, Set<string>>(); // entityId → Set<relationId>

  // Name index: lowercase name/alias → entityId
  private nameIndex = new Map<string, string>();

  constructor(logger: Logger, config: JsonGraphStoreConfig) {
    this.logger = logger.child({ component: 'graph-store' });
    this.config = config;
  }

  // ─── Entity CRUD ──────────────────────────────────────────────────────────

  async upsertEntity(entity: GraphEntity): Promise<void> {
    await this.ensureLoaded();

    const existing = this.entities.get(entity.id);
    if (existing) {
      // Remove old name/alias entries from index
      this.removeNameIndexEntries(existing);
    }

    this.entities.set(entity.id, entity);
    this.addNameIndexEntries(entity);

    this.logger.debug({ entityId: entity.id, name: entity.name }, 'Entity upserted');
  }

  async getEntity(id: string): Promise<GraphEntity | undefined> {
    await this.ensureLoaded();
    return this.entities.get(id);
  }

  async findEntity(nameOrAlias: string): Promise<GraphEntity | undefined> {
    await this.ensureLoaded();
    const id = this.nameIndex.get(nameOrAlias.toLowerCase());
    if (!id) return undefined;
    return this.entities.get(id);
  }

  async deleteEntity(id: string): Promise<void> {
    await this.ensureLoaded();

    const entity = this.entities.get(id);
    if (!entity) return;

    // Remove name index entries
    this.removeNameIndexEntries(entity);

    // Remove all relations involving this entity
    const relIds = new Set<string>();
    const out = this.outEdges.get(id);
    if (out) for (const rid of out) relIds.add(rid);
    const inc = this.inEdges.get(id);
    if (inc) for (const rid of inc) relIds.add(rid);

    for (const rid of relIds) {
      this.removeRelation(rid);
    }

    // Remove entity
    this.entities.delete(id);
    this.outEdges.delete(id);
    this.inEdges.delete(id);

    this.logger.debug({ entityId: id }, 'Entity deleted');
  }

  async getAllEntities(): Promise<GraphEntity[]> {
    await this.ensureLoaded();
    return Array.from(this.entities.values());
  }

  // ─── Relation CRUD ────────────────────────────────────────────────────────

  async upsertRelation(relation: GraphRelation): Promise<void> {
    await this.ensureLoaded();

    const existing = this.relations.get(relation.id);
    if (existing) {
      // Remove old adjacency entries
      this.outEdges.get(existing.fromId)?.delete(existing.id);
      this.inEdges.get(existing.toId)?.delete(existing.id);
    }

    this.relations.set(relation.id, relation);

    // Update adjacency
    let out = this.outEdges.get(relation.fromId);
    if (!out) {
      out = new Set();
      this.outEdges.set(relation.fromId, out);
    }
    out.add(relation.id);

    let inc = this.inEdges.get(relation.toId);
    if (!inc) {
      inc = new Set();
      this.inEdges.set(relation.toId, inc);
    }
    inc.add(relation.id);

    this.logger.debug(
      { relationId: relation.id, from: relation.fromId, to: relation.toId, type: relation.type },
      'Relation upserted'
    );
  }

  async getRelations(
    entityId: string,
    direction: 'from' | 'to' | 'both' = 'both'
  ): Promise<GraphRelation[]> {
    await this.ensureLoaded();

    const results: GraphRelation[] = [];
    const seen = new Set<string>();

    if (direction === 'from' || direction === 'both') {
      const out = this.outEdges.get(entityId);
      if (out) {
        for (const rid of out) {
          if (!seen.has(rid)) {
            const rel = this.relations.get(rid);
            if (rel) results.push(rel);
            seen.add(rid);
          }
        }
      }
    }

    if (direction === 'to' || direction === 'both') {
      const inc = this.inEdges.get(entityId);
      if (inc) {
        for (const rid of inc) {
          if (!seen.has(rid)) {
            const rel = this.relations.get(rid);
            if (rel) results.push(rel);
            seen.add(rid);
          }
        }
      }
    }

    return results;
  }

  async deleteRelation(id: string): Promise<void> {
    await this.ensureLoaded();
    this.removeRelation(id);
  }

  async getAllRelations(): Promise<GraphRelation[]> {
    await this.ensureLoaded();
    return Array.from(this.relations.values());
  }

  // ─── Traversal ────────────────────────────────────────────────────────────

  async traverse(options: TraversalOptions): Promise<TraversalResult[]> {
    await this.ensureLoaded();

    const {
      startEntityId,
      maxHops,
      direction = 'both',
      minStrength = 0,
      minConfidence = 0,
      relationTypes,
      limit = 50,
    } = options;

    const startEntity = this.entities.get(startEntityId);
    if (!startEntity) return [];

    const results: TraversalResult[] = [];
    const visited = new Set<string>([startEntityId]);

    // BFS queue: [entityId, path, hops, pathStrength]
    const queue: [string, GraphRelation[], number, number][] = [[startEntityId, [], 0, 1.0]];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const [currentId, path, hops, pathStrength] = item;

      if (hops > 0) {
        const entity = this.entities.get(currentId);
        if (entity) {
          results.push({ entity, path: [...path], hops, pathStrength });
          if (results.length >= limit) break;
        }
      }

      if (hops >= maxHops) continue;

      // Get edges in requested direction
      const edgeIds = this.getEdgeIds(currentId, direction);

      for (const rid of edgeIds) {
        const rel = this.relations.get(rid);
        if (!rel) continue;

        // Apply filters
        if (rel.strength < minStrength) continue;
        if (rel.confidence < minConfidence) continue;
        if (relationTypes && !relationTypes.includes(rel.type)) continue;

        // Determine neighbor
        const neighborId = rel.fromId === currentId ? rel.toId : rel.fromId;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        queue.push([neighborId, [...path, rel], hops + 1, pathStrength * rel.strength]);
      }
    }

    // Sort by pathStrength descending
    results.sort((a, b) => b.pathStrength - a.pathStrength);
    return results;
  }

  // ─── Spreading Activation ─────────────────────────────────────────────────

  async spreadingActivation(options: SpreadingActivationOptions): Promise<ActivationResult[]> {
    await this.ensureLoaded();

    const { seeds, decayFactor = 0.5, threshold = 0.1, maxIterations = 3, limit = 10 } = options;

    // activation[entityId] = current activation level
    const activation = new Map<string, number>();
    // via[entityId] = human-readable path description
    const via = new Map<string, string>();

    // Initialize seeds
    for (const seed of seeds) {
      const entity = this.entities.get(seed.entityId);
      if (!entity) continue;
      activation.set(seed.entityId, seed.activation);
      via.set(seed.entityId, entity.name);
    }

    // Iterative propagation
    for (let iter = 0; iter < maxIterations; iter++) {
      const updates = new Map<string, { activation: number; via: string }>();

      for (const [entityId, currentActivation] of activation) {
        if (currentActivation < threshold) continue;

        const edges = this.getEdgeIds(entityId, 'both');
        const sourceName = this.entities.get(entityId)?.name ?? entityId;

        for (const rid of edges) {
          const rel = this.relations.get(rid);
          if (!rel) continue;

          const neighborId = rel.fromId === entityId ? rel.toId : rel.fromId;
          const spreadActivation = currentActivation * rel.strength * decayFactor;

          if (spreadActivation < threshold) continue;

          const existingUpdate = updates.get(neighborId);
          const existingActivation = existingUpdate?.activation ?? activation.get(neighborId) ?? 0;

          if (spreadActivation > existingActivation) {
            const neighborName = this.entities.get(neighborId)?.name ?? neighborId;
            updates.set(neighborId, {
              activation: spreadActivation,
              via: `${sourceName} → ${rel.type} → ${neighborName}`,
            });
          }
        }
      }

      // Apply updates
      let changed = false;
      for (const [entityId, update] of updates) {
        const current = activation.get(entityId) ?? 0;
        if (update.activation > current) {
          activation.set(entityId, update.activation);
          via.set(entityId, update.via);
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Build results, excluding seed nodes
    const seedIds = new Set(seeds.map((s) => s.entityId));
    const results: ActivationResult[] = [];

    for (const [entityId, act] of activation) {
      if (seedIds.has(entityId)) continue;
      if (act < threshold) continue;

      const entity = this.entities.get(entityId);
      if (!entity) continue;

      results.push({
        entity,
        activation: act,
        via: via.get(entityId) ?? '',
      });
    }

    // Sort by activation descending, take top N
    results.sort((a, b) => b.activation - a.activation);
    return results.slice(0, limit);
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  async persist(): Promise<void> {
    const data: GraphStoreData = {
      version: 1,
      entities: Array.from(this.entities.values()),
      relations: Array.from(this.relations.values()),
    };
    await this.config.storage.save(this.config.storageKey, data);
    this.logger.debug(
      { entities: this.entities.size, relations: this.relations.size },
      'GraphStore persisted'
    );
  }

  async clear(): Promise<void> {
    this.entities.clear();
    this.relations.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.nameIndex.clear();
    await this.persist();
    this.logger.info('GraphStore cleared');
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private removeRelation(id: string): void {
    const rel = this.relations.get(id);
    if (!rel) return;
    this.outEdges.get(rel.fromId)?.delete(id);
    this.inEdges.get(rel.toId)?.delete(id);
    this.relations.delete(id);
  }

  private addNameIndexEntries(entity: GraphEntity): void {
    this.nameIndex.set(entity.name.toLowerCase(), entity.id);
    for (const alias of entity.aliases) {
      this.nameIndex.set(alias.toLowerCase(), entity.id);
    }
  }

  private removeNameIndexEntries(entity: GraphEntity): void {
    this.nameIndex.delete(entity.name.toLowerCase());
    for (const alias of entity.aliases) {
      this.nameIndex.delete(alias.toLowerCase());
    }
  }

  private getEdgeIds(entityId: string, direction: 'from' | 'to' | 'both'): Set<string> {
    const result = new Set<string>();
    if (direction === 'from' || direction === 'both') {
      const out = this.outEdges.get(entityId);
      if (out) for (const rid of out) result.add(rid);
    }
    if (direction === 'to' || direction === 'both') {
      const inc = this.inEdges.get(entityId);
      if (inc) for (const rid of inc) result.add(rid);
    }
    return result;
  }

  private rebuildIndexes(): void {
    this.outEdges.clear();
    this.inEdges.clear();
    this.nameIndex.clear();

    for (const entity of this.entities.values()) {
      this.addNameIndexEntries(entity);
    }

    for (const rel of this.relations.values()) {
      let out = this.outEdges.get(rel.fromId);
      if (!out) {
        out = new Set();
        this.outEdges.set(rel.fromId, out);
      }
      out.add(rel.id);

      let inc = this.inEdges.get(rel.toId);
      if (!inc) {
        inc = new Set();
        this.inEdges.set(rel.toId, inc);
      }
      inc.add(rel.id);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await this.config.storage.load(this.config.storageKey);
      if (data) {
        const store = data as GraphStoreData;
        for (const entity of store.entities) {
          this.entities.set(entity.id, entity);
        }
        for (const relation of store.relations) {
          this.relations.set(relation.id, relation);
        }
        this.rebuildIndexes();
        this.logger.info(
          { entities: this.entities.size, relations: this.relations.size },
          'GraphStore loaded from storage'
        );
      } else {
        this.logger.info('No existing graph, starting fresh');
      }
      this.loaded = true;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to load GraphStore'
      );
      this.loaded = true;
    }
  }
}
