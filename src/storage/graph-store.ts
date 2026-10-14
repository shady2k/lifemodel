/**
 * GraphStore — Entity/relation graph for associative memory.
 *
 * Stores entities (people, places, topics) and relations between them.
 * Supports BFS traversal and spreading activation for associative recall.
 *
 * Postgres-backed implementation persists graph entities and relations.
 */

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
  transaction<T>(operation: (store: GraphStore) => Promise<T>): Promise<T>;
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
  clear(): Promise<void>;
}
