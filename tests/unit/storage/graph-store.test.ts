/**
 * Tests for JsonGraphStore.
 *
 * Covers: entity/relation CRUD, name/alias lookup, BFS traversal (hops, strength filter),
 * spreading activation, cycle handling, persist/load.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonGraphStore } from '../../../src/storage/graph-store.js';
import type {
  GraphEntity,
  GraphRelation,
} from '../../../src/storage/graph-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockStorage() {
  const data = new Map<string, unknown>();
  return {
    load: vi.fn(async (key: string) => data.get(key) ?? null),
    save: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    exists: vi.fn(async (key: string) => data.has(key)),
    _data: data,
  };
}

function createMockLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as import('../../../src/types/logger.js').Logger;
}

function makeEntity(overrides: Partial<GraphEntity> & { id: string; name: string }): GraphEntity {
  return {
    aliases: [],
    type: 'person',
    lastActivated: new Date().toISOString(),
    sourceMemoryIds: [],
    ...overrides,
  };
}

function makeRelation(
  overrides: Partial<GraphRelation> & { id: string; fromId: string; toId: string }
): GraphRelation {
  return {
    type: 'related_to',
    strength: 0.8,
    confidence: 0.9,
    lastActivated: new Date().toISOString(),
    sourceMemoryIds: [],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('JsonGraphStore', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let logger: ReturnType<typeof createMockLogger>;
  let store: JsonGraphStore;

  beforeEach(() => {
    storage = createMockStorage();
    logger = createMockLogger();
    store = new JsonGraphStore(logger, { storage, storageKey: 'graph' });
  });

  // ─── Entity CRUD ────────────────────────────────────────────────────────

  describe('entity CRUD', () => {
    it('upserts and retrieves an entity', async () => {
      const entity = makeEntity({ id: 'ent_1', name: 'John' });
      await store.upsertEntity(entity);
      const result = await store.getEntity('ent_1');
      expect(result).toBeDefined();
      expect(result!.name).toBe('John');
    });

    it('updates existing entity on upsert', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'John', type: 'person' }));
      await store.upsertEntity(
        makeEntity({ id: 'ent_1', name: 'John Smith', type: 'person', aliases: ['John'] })
      );
      const result = await store.getEntity('ent_1');
      expect(result!.name).toBe('John Smith');
      expect(result!.aliases).toEqual(['John']);
    });

    it('deletes entity and its relations', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'John' }));
      await store.upsertEntity(makeEntity({ id: 'ent_2', name: 'Sarah' }));
      await store.upsertRelation(
        makeRelation({ id: 'rel_1', fromId: 'ent_1', toId: 'ent_2', type: 'married_to' })
      );

      await store.deleteEntity('ent_1');
      expect(await store.getEntity('ent_1')).toBeUndefined();
      // Relation should also be gone
      const rels = await store.getRelations('ent_2');
      expect(rels).toHaveLength(0);
    });

    it('getAllEntities returns all entities', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'John' }));
      await store.upsertEntity(makeEntity({ id: 'ent_2', name: 'Sarah' }));
      const all = await store.getAllEntities();
      expect(all).toHaveLength(2);
    });
  });

  // ─── Name/alias lookup ──────────────────────────────────────────────────

  describe('findEntity', () => {
    it('finds entity by exact name (case-insensitive)', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'John Smith' }));
      const result = await store.findEntity('john smith');
      expect(result).toBeDefined();
      expect(result!.id).toBe('ent_1');
    });

    it('finds entity by alias', async () => {
      await store.upsertEntity(
        makeEntity({ id: 'ent_1', name: 'John Smith', aliases: ['Johnny', 'JS'] })
      );
      const result = await store.findEntity('johnny');
      expect(result).toBeDefined();
      expect(result!.id).toBe('ent_1');
    });

    it('returns undefined for unknown name', async () => {
      const result = await store.findEntity('Unknown Person');
      expect(result).toBeUndefined();
    });

    it('updates name index on upsert', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'OldName' }));
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'NewName' }));
      // Old name should no longer resolve
      expect(await store.findEntity('OldName')).toBeUndefined();
      // New name should resolve
      expect(await store.findEntity('NewName')).toBeDefined();
    });
  });

  // ─── Relation CRUD ────────────────────────────────────────────────────

  describe('relation CRUD', () => {
    it('upserts and retrieves a relation', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'John' }));
      await store.upsertEntity(makeEntity({ id: 'ent_2', name: 'Google' }));
      await store.upsertRelation(
        makeRelation({ id: 'rel_1', fromId: 'ent_1', toId: 'ent_2', type: 'works_at' })
      );

      const rels = await store.getRelations('ent_1', 'from');
      expect(rels).toHaveLength(1);
      expect(rels[0]!.type).toBe('works_at');
    });

    it('getRelations with direction filter', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'John' }));
      await store.upsertEntity(makeEntity({ id: 'ent_2', name: 'Sarah' }));
      await store.upsertRelation(
        makeRelation({ id: 'rel_1', fromId: 'ent_1', toId: 'ent_2' })
      );

      expect(await store.getRelations('ent_1', 'from')).toHaveLength(1);
      expect(await store.getRelations('ent_1', 'to')).toHaveLength(0);
      expect(await store.getRelations('ent_2', 'to')).toHaveLength(1);
      expect(await store.getRelations('ent_1', 'both')).toHaveLength(1);
    });

    it('deletes a relation', async () => {
      await store.upsertRelation(
        makeRelation({ id: 'rel_1', fromId: 'ent_1', toId: 'ent_2' })
      );
      await store.deleteRelation('rel_1');
      const all = await store.getAllRelations();
      expect(all).toHaveLength(0);
    });
  });

  // ─── BFS Traversal ────────────────────────────────────────────────────

  describe('traverse', () => {
    beforeEach(async () => {
      // Build: John → married_to → Sarah → works_at → Meta → part_of → Tech
      await store.upsertEntity(makeEntity({ id: 'ent_john', name: 'John' }));
      await store.upsertEntity(makeEntity({ id: 'ent_sarah', name: 'Sarah' }));
      await store.upsertEntity(makeEntity({ id: 'ent_meta', name: 'Meta', type: 'organization' }));
      await store.upsertEntity(makeEntity({ id: 'ent_tech', name: 'Tech Industry', type: 'topic' }));

      await store.upsertRelation(
        makeRelation({
          id: 'rel_1',
          fromId: 'ent_john',
          toId: 'ent_sarah',
          type: 'married_to',
          strength: 0.9,
        })
      );
      await store.upsertRelation(
        makeRelation({
          id: 'rel_2',
          fromId: 'ent_sarah',
          toId: 'ent_meta',
          type: 'works_at',
          strength: 0.8,
        })
      );
      await store.upsertRelation(
        makeRelation({
          id: 'rel_3',
          fromId: 'ent_meta',
          toId: 'ent_tech',
          type: 'part_of',
          strength: 0.7,
        })
      );
    });

    it('finds direct neighbors at 1 hop', async () => {
      const results = await store.traverse({ startEntityId: 'ent_john', maxHops: 1 });
      expect(results).toHaveLength(1);
      expect(results[0]!.entity.name).toBe('Sarah');
      expect(results[0]!.hops).toBe(1);
    });

    it('finds transitive connections at 2 hops', async () => {
      const results = await store.traverse({ startEntityId: 'ent_john', maxHops: 2 });
      expect(results).toHaveLength(2);
      const names = results.map((r) => r.entity.name);
      expect(names).toContain('Sarah');
      expect(names).toContain('Meta');
    });

    it('finds full chain at 3 hops', async () => {
      const results = await store.traverse({ startEntityId: 'ent_john', maxHops: 3 });
      expect(results).toHaveLength(3);
      const names = results.map((r) => r.entity.name);
      expect(names).toContain('Tech Industry');
    });

    it('calculates pathStrength as product of relation strengths', async () => {
      const results = await store.traverse({ startEntityId: 'ent_john', maxHops: 3 });
      const meta = results.find((r) => r.entity.name === 'Meta');
      expect(meta).toBeDefined();
      // John→Sarah (0.9) * Sarah→Meta (0.8) = 0.72
      expect(meta!.pathStrength).toBeCloseTo(0.72, 2);
    });

    it('filters by minStrength', async () => {
      const results = await store.traverse({
        startEntityId: 'ent_john',
        maxHops: 3,
        minStrength: 0.85,
      });
      // Only John→Sarah (0.9) passes, Sarah→Meta (0.8) doesn't
      expect(results).toHaveLength(1);
      expect(results[0]!.entity.name).toBe('Sarah');
    });

    it('filters by relationTypes', async () => {
      const results = await store.traverse({
        startEntityId: 'ent_john',
        maxHops: 3,
        relationTypes: ['married_to'],
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.entity.name).toBe('Sarah');
    });

    it('handles cycles without infinite loop', async () => {
      // Add reverse relation: Sarah → John
      await store.upsertRelation(
        makeRelation({
          id: 'rel_cycle',
          fromId: 'ent_sarah',
          toId: 'ent_john',
          type: 'married_to',
          strength: 0.9,
        })
      );
      const results = await store.traverse({ startEntityId: 'ent_john', maxHops: 5 });
      // Should not revisit John — visited set prevents it
      const johnResults = results.filter((r) => r.entity.name === 'John');
      expect(johnResults).toHaveLength(0);
    });
  });

  // ─── Spreading Activation ─────────────────────────────────────────────

  describe('spreadingActivation', () => {
    beforeEach(async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_john', name: 'John' }));
      await store.upsertEntity(makeEntity({ id: 'ent_sarah', name: 'Sarah' }));
      await store.upsertEntity(makeEntity({ id: 'ent_google', name: 'Google', type: 'organization' }));
      await store.upsertEntity(makeEntity({ id: 'ent_meta', name: 'Meta', type: 'organization' }));

      await store.upsertRelation(
        makeRelation({
          id: 'rel_1',
          fromId: 'ent_john',
          toId: 'ent_sarah',
          type: 'married_to',
          strength: 0.9,
        })
      );
      await store.upsertRelation(
        makeRelation({
          id: 'rel_2',
          fromId: 'ent_john',
          toId: 'ent_google',
          type: 'works_at',
          strength: 0.8,
        })
      );
      await store.upsertRelation(
        makeRelation({
          id: 'rel_3',
          fromId: 'ent_sarah',
          toId: 'ent_meta',
          type: 'works_at',
          strength: 0.7,
        })
      );
    });

    it('activates direct neighbors from a seed', async () => {
      const results = await store.spreadingActivation({
        seeds: [{ entityId: 'ent_john', activation: 1.0 }],
      });
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.entity.name);
      expect(names).toContain('Sarah');
      expect(names).toContain('Google');
    });

    it('activation decays per hop', async () => {
      const results = await store.spreadingActivation({
        seeds: [{ entityId: 'ent_john', activation: 1.0 }],
        decayFactor: 0.5,
      });

      const sarah = results.find((r) => r.entity.name === 'Sarah');
      const meta = results.find((r) => r.entity.name === 'Meta');
      expect(sarah).toBeDefined();
      // Sarah: 1.0 * 0.9 * 0.5 = 0.45
      expect(sarah!.activation).toBeCloseTo(0.45, 2);
      // Meta (via Sarah): 0.45 * 0.7 * 0.5 = 0.157
      if (meta) {
        expect(meta.activation).toBeCloseTo(0.157, 2);
      }
    });

    it('respects threshold cutoff', async () => {
      const results = await store.spreadingActivation({
        seeds: [{ entityId: 'ent_john', activation: 1.0 }],
        decayFactor: 0.5,
        threshold: 0.3,
      });
      // Only direct neighbors should pass (activation ~ 0.45 and 0.4)
      // Meta at ~0.157 should be below threshold
      const names = results.map((r) => r.entity.name);
      expect(names).not.toContain('Meta');
    });

    it('excludes seed nodes from results', async () => {
      const results = await store.spreadingActivation({
        seeds: [{ entityId: 'ent_john', activation: 1.0 }],
      });
      const seedIds = results.filter((r) => r.entity.id === 'ent_john');
      expect(seedIds).toHaveLength(0);
    });

    it('includes via description', async () => {
      const results = await store.spreadingActivation({
        seeds: [{ entityId: 'ent_john', activation: 1.0 }],
      });
      const sarah = results.find((r) => r.entity.name === 'Sarah');
      expect(sarah).toBeDefined();
      expect(sarah!.via).toContain('John');
      expect(sarah!.via).toContain('married_to');
      expect(sarah!.via).toContain('Sarah');
    });

    it('supports multiple seeds', async () => {
      const results = await store.spreadingActivation({
        seeds: [
          { entityId: 'ent_john', activation: 1.0 },
          { entityId: 'ent_meta', activation: 0.8 },
        ],
      });
      // Both John's neighbors and Meta's neighbors should be activated
      expect(results.length).toBeGreaterThan(0);
    });

    it('respects limit', async () => {
      const results = await store.spreadingActivation({
        seeds: [{ entityId: 'ent_john', activation: 1.0 }],
        limit: 1,
      });
      expect(results).toHaveLength(1);
    });
  });

  // ─── Persistence ──────────────────────────────────────────────────────

  describe('persist and reload', () => {
    it('round-trips entities and relations through storage', async () => {
      await store.upsertEntity(
        makeEntity({ id: 'ent_1', name: 'John', aliases: ['Johnny'] })
      );
      await store.upsertEntity(makeEntity({ id: 'ent_2', name: 'Sarah' }));
      await store.upsertRelation(
        makeRelation({ id: 'rel_1', fromId: 'ent_1', toId: 'ent_2', type: 'married_to' })
      );
      await store.persist();

      // Create new store with same storage
      const store2 = new JsonGraphStore(logger, { storage, storageKey: 'graph' });
      const entity = await store2.getEntity('ent_1');
      expect(entity).toBeDefined();
      expect(entity!.name).toBe('John');

      // Name index should be rebuilt
      const found = await store2.findEntity('johnny');
      expect(found).toBeDefined();

      // Relations should be restored
      const rels = await store2.getRelations('ent_1');
      expect(rels).toHaveLength(1);
    });
  });

  // ─── Clear ────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all data', async () => {
      await store.upsertEntity(makeEntity({ id: 'ent_1', name: 'John' }));
      await store.upsertRelation(
        makeRelation({ id: 'rel_1', fromId: 'ent_1', toId: 'ent_2' })
      );
      await store.clear();

      expect(await store.getAllEntities()).toHaveLength(0);
      expect(await store.getAllRelations()).toHaveLength(0);
      expect(await store.findEntity('John')).toBeUndefined();
    });
  });
});
