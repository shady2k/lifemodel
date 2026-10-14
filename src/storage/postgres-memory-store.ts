import type { Pool } from 'pg';
import type { Logger } from '../types/logger.js';
import type { MemoryEntry } from '../layers/cognition/tools/registry.js';
import type { Embedder } from './embedder.js';
import type { VectorStore, VectorSearchOptions, VectorSearchResult } from './vector-store.js';
import type {
  GraphStore,
  GraphEntity,
  GraphRelation,
  TraversalOptions,
  TraversalResult,
  SpreadingActivationOptions,
  ActivationResult,
} from './graph-store.js';

const DIMENSIONS = 384;
interface MemoryRow {
  id: string;
  type: MemoryEntry['type'];
  content: string;
  timestamp: Date | string;
  recipient_id: string | null;
  tags: string[] | null;
  confidence: number;
  salience: number | null;
  metadata: Record<string, unknown> | null;
  tick_id: string | null;
  parent_signal_id: string | null;
  trigger: MemoryEntry['trigger'] | null;
  status: MemoryEntry['status'] | null;
  expires_at: Date | string | null;
}
function fromMemoryRow(r: MemoryRow): MemoryEntry {
  const e: MemoryEntry & { salience?: number } = {
    id: r.id,
    type: r.type,
    content: r.content,
    timestamp: new Date(r.timestamp),
    recipientId: r.recipient_id ?? undefined,
    tags: r.tags ?? undefined,
    confidence: r.confidence,
    metadata: r.metadata ?? undefined,
    tickId: r.tick_id ?? undefined,
    parentSignalId: r.parent_signal_id ?? undefined,
    trigger: r.trigger ?? undefined,
    status: r.status ?? undefined,
    expiresAt: r.expires_at ? new Date(r.expires_at) : undefined,
  };
  if (r.salience != null) e.salience = r.salience;
  return e;
}
function vectorLiteral(v: Float32Array): string {
  if (v.length !== DIMENSIONS)
    throw new Error(`Embedding dimension mismatch: expected ${DIMENSIONS}, got ${v.length}`);
  return `[${Array.from(v).join(',')}]`;
}
const memoryColumns =
  'id,type,content,timestamp,recipient_id,tags,confidence,salience,metadata,tick_id,parent_signal_id,trigger,status,expires_at';
export class PostgresVectorStore implements VectorStore {
  constructor(
    logger: Logger,
    private readonly pool: Pool,
    private readonly embedder: Embedder,
    private readonly maxEntries = 10000
  ) {
    if (embedder.dimensions() !== DIMENSIONS)
      throw new Error(
        `Embedder dimension mismatch: database requires ${DIMENSIONS}, got ${embedder.dimensions()}`
      );
    this.logger = logger.child({ component: 'vector-store' });
  }
  private readonly logger: Logger;
  async search(o: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const query = o.query.trim(),
      limit = o.limit ?? 10,
      offset = o.offset ?? 0;
    const hasFilters =
      o.types != null ||
      o.recipientId != null ||
      o.status != null ||
      (o.minConfidence ?? 0) > 0 ||
      o.metadata != null;
    if (query.length < 2 && !hasFilters) return [];
    if (o.types?.length === 0) return [];
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (o.types) add('type = ANY(?::text[])', o.types);
    if (o.recipientId) add('(recipient_id IS NULL OR recipient_id = ?)', o.recipientId);
    if (o.status) add('(status IS NULL OR status = ?)', o.status);
    if ((o.minConfidence ?? 0) > 0) add('confidence >= ?', o.minConfidence);
    if (o.metadata)
      for (const [k, v] of Object.entries(o.metadata)) {
        values.push(JSON.stringify({ [k]: v }));
        where.push(`metadata @> $${values.length}::jsonb`);
      }
    let queryVector: Float32Array | undefined;
    if (query.length >= 2) {
      queryVector = await this.embedder.embed(query);
      if (queryVector.length !== DIMENSIONS)
        throw new Error(
          `Embedding dimension mismatch: expected ${DIMENSIONS}, got ${queryVector.length}`
        );
    }
    const vectorSql = queryVector
      ? 'embedding <=> $' + (values.push(vectorLiteral(queryVector)), values.length) + '::vector'
      : '';
    const sql = `SELECT ${memoryColumns}, ${queryVector ? `(${vectorSql}) AS distance` : '0::float AS distance'} FROM core.memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${queryVector ? `ORDER BY ${vectorSql}` : 'ORDER BY timestamp DESC'} LIMIT $${(values.push(Math.max(0, limit + offset) * 3), values.length)} OFFSET 0`;
    const { rows } = await this.pool.query(sql, values);
    const results = rows
      .filter(
        (r) =>
          !o.metadata ||
          Object.entries(o.metadata).every(
            ([k, v]) => JSON.stringify(r.metadata?.[k]) === JSON.stringify(v)
          )
      )
      .map((r) => {
        const entry = fromMemoryRow(r);
        const similarity = queryVector
          ? Math.max(0, Math.min(1, 1 - Number(r.distance) / 2)) * 10
          : 0;
        const age = (Date.now() - entry.timestamp.getTime()) / 3600000;
        const extra =
          Math.max(0, 1 - age / 168) +
          (entry.confidence ?? 0.5) * 3 +
          ((entry as MemoryEntry & { salience?: number }).salience ?? 0) * 2;
        return { entry, score: similarity + extra };
      })
      .sort((a, b) => b.score - a.score);
    return results.slice(offset, offset + limit);
  }
  async count(o?: { types?: MemoryEntry['type'][] }): Promise<number> {
    const r = o?.types
      ? await this.pool.query(
          'SELECT count(*)::int AS count FROM core.memories WHERE type=ANY($1::text[])',
          [o.types]
        )
      : await this.pool.query('SELECT count(*)::int AS count FROM core.memories');
    return Number(r.rows[0]?.count ?? 0);
  }
  async save(e: MemoryEntry): Promise<void> {
    const v = await this.embedder.embed(e.content);
    if (v.length !== DIMENSIONS)
      throw new Error(`Embedding dimension mismatch: expected ${DIMENSIONS}, got ${v.length}`);
    const x = e as MemoryEntry & { salience?: number };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (e.type === 'fact' && e.metadata?.['subject'] && e.metadata['attribute']) {
        const old = await client.query(
          "SELECT id FROM core.memories WHERE type=$1 AND metadata->>'subject'=$2 AND metadata->>'attribute'=$3 LIMIT 1 FOR UPDATE",
          ['fact', String(e.metadata['subject']), String(e.metadata['attribute'])]
        );
        if (old.rows[0]) e.id = old.rows[0].id;
      }
      await client.query(
        `INSERT INTO core.memories (${memoryColumns},embedding) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15::vector) ON CONFLICT(id) DO UPDATE SET type=EXCLUDED.type,content=EXCLUDED.content,timestamp=EXCLUDED.timestamp,recipient_id=EXCLUDED.recipient_id,tags=EXCLUDED.tags,confidence=EXCLUDED.confidence,salience=EXCLUDED.salience,metadata=EXCLUDED.metadata,tick_id=EXCLUDED.tick_id,parent_signal_id=EXCLUDED.parent_signal_id,trigger=EXCLUDED.trigger,status=EXCLUDED.status,expires_at=EXCLUDED.expires_at,embedding=EXCLUDED.embedding`,
        [
          e.id,
          e.type,
          e.content,
          e.timestamp,
          e.recipientId ?? null,
          JSON.stringify(e.tags ?? null),
          e.confidence ?? 0.5,
          x.salience ?? null,
          JSON.stringify(e.metadata ?? null),
          e.tickId ?? null,
          e.parentSignalId ?? null,
          JSON.stringify(e.trigger ?? null),
          e.status ?? null,
          e.expiresAt ?? null,
          vectorLiteral(v),
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await this.prune();
  }
  private async prune() {
    const n = await this.count();
    if (n <= this.maxEntries) return;
    await this.pool.query(
      `DELETE FROM core.memories WHERE id IN (SELECT id FROM core.memories WHERE NOT (type='thought' AND tags @> '["state:unresolved","soul:reflection"]'::jsonb) ORDER BY timestamp ASC LIMIT $1)`,
      [n - this.maxEntries]
    );
  }
  async delete(id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM core.memories WHERE id=$1', [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async getById(id: string): Promise<MemoryEntry | undefined> {
    const r = await this.pool.query<MemoryRow>(
      `SELECT ${memoryColumns} FROM core.memories WHERE id=$1`,
      [id]
    );
    return r.rows[0] ? fromMemoryRow(r.rows[0]) : undefined;
  }
  async getAll(): Promise<MemoryEntry[]> {
    const r = await this.pool.query<MemoryRow>(
      `SELECT ${memoryColumns} FROM core.memories ORDER BY timestamp DESC`
    );
    return r.rows.map(fromMemoryRow);
  }
  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM core.memories');
  }
  async persist(): Promise<void> {}
}

interface EntityRow {
  id: string;
  name: string;
  aliases: string[];
  type: GraphEntity['type'];
  description: string | null;
  metadata: Record<string, unknown>;
  last_activated: Date | string;
  source_memory_ids: string[];
}
interface RelationRow {
  id: string;
  from_id: string;
  to_id: string;
  type: GraphRelation['type'];
  strength: number;
  confidence: number;
  source_trace_id: string | null;
  last_activated: Date | string;
  source_memory_ids: string[];
}
const entity = (r: EntityRow): GraphEntity => ({
  id: r.id,
  name: r.name,
  aliases: r.aliases,
  type: r.type,
  description: r.description ?? undefined,
  metadata: r.metadata,
  lastActivated: new Date(r.last_activated).toISOString(),
  sourceMemoryIds: r.source_memory_ids,
});
const relation = (r: RelationRow): GraphRelation => ({
  id: r.id,
  fromId: r.from_id,
  toId: r.to_id,
  type: r.type,
  strength: r.strength,
  confidence: r.confidence,
  sourceTraceId: r.source_trace_id ?? undefined,
  lastActivated: new Date(r.last_activated).toISOString(),
  sourceMemoryIds: r.source_memory_ids,
});
export class PostgresGraphStore implements GraphStore {
  constructor(
    private readonly pool: Pool,
    logger: Logger
  ) {
    this.logger = logger.child({ component: 'graph-store' });
  }
  private readonly logger: Logger;
  async upsertEntity(e: GraphEntity): Promise<void> {
    await this.pool.query(
      `INSERT INTO core.memory_entities(id,name,aliases,type,description,metadata,last_activated,source_memory_ids) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8::jsonb) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,aliases=EXCLUDED.aliases,type=EXCLUDED.type,description=EXCLUDED.description,metadata=EXCLUDED.metadata,last_activated=EXCLUDED.last_activated,source_memory_ids=EXCLUDED.source_memory_ids`,
      [
        e.id,
        e.name,
        JSON.stringify(e.aliases),
        e.type,
        e.description ?? null,
        JSON.stringify(e.metadata ?? {}),
        e.lastActivated,
        JSON.stringify(e.sourceMemoryIds),
      ]
    );
  }
  async upsertRelation(e: GraphRelation): Promise<void> {
    await this.pool.query(
      `INSERT INTO core.memory_relations(id,from_id,to_id,type,strength,confidence,source_trace_id,last_activated,source_memory_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(id) DO UPDATE SET from_id=EXCLUDED.from_id,to_id=EXCLUDED.to_id,type=EXCLUDED.type,strength=EXCLUDED.strength,confidence=EXCLUDED.confidence,source_trace_id=EXCLUDED.source_trace_id,last_activated=EXCLUDED.last_activated,source_memory_ids=EXCLUDED.source_memory_ids`,
      [
        e.id,
        e.fromId,
        e.toId,
        e.type,
        e.strength,
        e.confidence,
        e.sourceTraceId ?? null,
        e.lastActivated,
        JSON.stringify(e.sourceMemoryIds),
      ]
    );
  }
  async getEntity(id: string) {
    const r = await this.pool.query<EntityRow>('SELECT * FROM core.memory_entities WHERE id=$1', [
      id,
    ]);
    return r.rows[0] ? entity(r.rows[0]) : undefined;
  }
  async findEntity(name: string) {
    const r = await this.pool.query<EntityRow>(
      `SELECT * FROM core.memory_entities WHERE lower(name)=lower($1) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(aliases) a WHERE lower(a)=lower($1)) LIMIT 1`,
      [name]
    );
    return r.rows[0] ? entity(r.rows[0]) : undefined;
  }
  async getRelations(id: string, direction: 'from' | 'to' | 'both' = 'both') {
    const op =
      direction === 'from'
        ? 'from_id=$1'
        : direction === 'to'
          ? 'to_id=$1'
          : '(from_id=$1 OR to_id=$1)';
    const r = await this.pool.query<RelationRow>(
      `SELECT * FROM core.memory_relations WHERE ${op}`,
      [id]
    );
    return r.rows.map(relation);
  }
  async getAllEntities() {
    const r = await this.pool.query<EntityRow>('SELECT * FROM core.memory_entities');
    return r.rows.map(entity);
  }
  async getAllRelations() {
    const r = await this.pool.query<RelationRow>('SELECT * FROM core.memory_relations');
    return r.rows.map(relation);
  }
  async traverse(o: TraversalOptions): Promise<TraversalResult[]> {
    const entities = new Map((await this.getAllEntities()).map((e) => [e.id, e]));
    const edges = await this.getAllRelations();
    const start = entities.get(o.startEntityId);
    if (!start) return [];
    const results: TraversalResult[] = [];
    const seen = new Set([start.id]);
    let q: [string, GraphRelation[], number, number][] = [[start.id, [], 0, 1]];
    while (q.length) {
      const [id, path, hops, strength] = q.shift()!;
      if (hops && entities.get(id))
        results.push({ entity: entities.get(id)!, path, hops, pathStrength: strength });
      if (hops >= o.maxHops || results.length >= (o.limit ?? 50)) continue;
      for (const edge of edges) {
        if (
          (o.direction === 'from' && edge.fromId !== id) ||
          (o.direction === 'to' && edge.toId !== id) ||
          ((o.direction ?? 'both') === 'both' && edge.fromId !== id && edge.toId !== id) ||
          edge.strength < (o.minStrength ?? 0) ||
          edge.confidence < (o.minConfidence ?? 0) ||
          (o.relationTypes && !o.relationTypes.includes(edge.type))
        )
          continue;
        const next = edge.fromId === id ? edge.toId : edge.fromId;
        if (seen.has(next)) continue;
        seen.add(next);
        q.push([next, [...path, edge], hops + 1, strength * edge.strength]);
      }
    }
    return results.sort((a, b) => b.pathStrength - a.pathStrength).slice(0, o.limit ?? 50);
  }
  async spreadingActivation(o: SpreadingActivationOptions): Promise<ActivationResult[]> {
    const entities = new Map((await this.getAllEntities()).map((e) => [e.id, e]));
    const edges = await this.getAllRelations();
    const acts = new Map(
      o.seeds.filter((s) => entities.has(s.entityId)).map((s) => [s.entityId, s.activation])
    );
    const via = new Map(o.seeds.map((s) => [s.entityId, entities.get(s.entityId)?.name ?? '']));
    const threshold = o.threshold ?? 0.1;
    for (let i = 0; i < (o.maxIterations ?? 3); i++) {
      let changed = false;
      for (const [id, a] of [...acts])
        if (a >= threshold)
          for (const edge of edges) {
            if (edge.fromId !== id && edge.toId !== id) continue;
            const next = edge.fromId === id ? edge.toId : edge.fromId;
            const n = a * edge.strength * (o.decayFactor ?? 0.5);
            if (n >= threshold && n > (acts.get(next) ?? 0)) {
              acts.set(next, n);
              via.set(
                next,
                `${entities.get(id)?.name} → ${edge.type} → ${entities.get(next)?.name}`
              );
              changed = true;
            }
          }
      if (!changed) break;
    }
    const seeds = new Set(o.seeds.map((s) => s.entityId));
    return [...acts]
      .filter(([id, a]) => !seeds.has(id) && a >= threshold && entities.has(id))
      .map(([id, activation]) => ({
        entity: entities.get(id)!,
        activation,
        via: via.get(id) ?? '',
      }))
      .sort((a, b) => b.activation - a.activation)
      .slice(0, o.limit ?? 10);
  }
  async deleteEntity(id: string) {
    await this.pool.query('DELETE FROM core.memory_entities WHERE id=$1', [id]);
  }
  async deleteRelation(id: string) {
    await this.pool.query('DELETE FROM core.memory_relations WHERE id=$1', [id]);
  }
  async persist(): Promise<void> {}
  async clear(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM core.memory_relations');
      await c.query('DELETE FROM core.memory_entities');
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
