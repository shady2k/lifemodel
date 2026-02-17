/**
 * Calories Plugin Tool Tests
 *
 * Tests for migration, new actions, and relational calorie reads.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCaloriesTool } from '../../../../src/plugins/calories/calories-tool.js';
import type { PluginPrimitives, PluginToolContext } from '../../../../src/types/plugin.js';
import type { FoodItem, FoodEntry, WeightEntry } from '../../../../src/plugins/calories/calories-types.js';
import { CALORIES_STORAGE_KEYS } from '../../../../src/plugins/calories/calories-types.js';
import { resetMigrationState } from '../../../../src/plugins/calories/calories-migration.js';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock storage
function createMockStorage() {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
      return store[key] as T | undefined;
    }),
    set: vi.fn(async (key: string, value: unknown): Promise<void> => {
      store[key] = value;
    }),
    keys: vi.fn(async (pattern?: string): Promise<string[]> => {
      if (!pattern) return Object.keys(store);
      const prefix = pattern.replace('*', '');
      return Object.keys(store).filter((k) => k.startsWith(prefix));
    }),
    delete: vi.fn(async (key: string): Promise<boolean> => {
      if (key in store) {
        delete store[key];
        return true;
      }
      return false;
    }),
    _store: store,
  };
}

// Mock services
function createMockServices(storage: ReturnType<typeof createMockStorage>) {
  return {
    getTimezone: () => 'Europe/Moscow',
    getUserPatterns: () => ({ wakeHour: 7, sleepHour: 23 }),
    getUserProperty: (attr: string) => {
      if (attr === 'calorie_goal') return { value: 2000 };
      return null;
    },
    setUserProperty: vi.fn(),
    registerEventSchema: vi.fn(),
  };
}

// Helper to create tool and context
function setupTool() {
  const storage = createMockStorage();
  const services = createMockServices(storage);
  const primitives: PluginPrimitives = {
    storage,
    logger: mockLogger as unknown as PluginPrimitives['logger'],
    services: services as unknown as PluginPrimitives['services'],
    scheduler: {} as PluginPrimitives['scheduler'],
    signalEmitter: {} as PluginPrimitives['signalEmitter'],
    intentEmitter: {} as PluginPrimitives['intentEmitter'],
  };

  const tool = createCaloriesTool(
    primitives,
    () => 'Europe/Moscow',
    () => ({ wakeHour: 7, sleepHour: 23 }),
    async () => ({ calorie_goal: 2000 })
  );

  const context: PluginToolContext = {
    recipientId: 'user_test',
  };

  return { tool, storage, context };
}

describe('Calories Tool - Migration', () => {
  beforeEach(() => {
    resetMigrationState();
    vi.clearAllMocks();
  });

  it('should migrate schema v1 to v2 on first execute', async () => {
    const { tool, storage, context } = setupTool();

    // Setup v1 data: entries with calories field
    const item: FoodItem = {
      id: 'item_bacon',
      canonicalName: 'Бекон',
      measurementKind: 'weight',
      basis: { caloriesPer: 425, perQuantity: 100, perUnit: 'g' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };
    storage._store[CALORIES_STORAGE_KEYS.items] = [item];

    const entryWithCalories = {
      id: 'food_123',
      dishId: 'item_bacon',
      calories: 191, // v1 field
      portion: { quantity: 45, unit: 'g' as const },
      timestamp: '2026-01-10T08:00:00Z',
      recipientId: 'user_test',
    };
    storage._store['food:2026-01-10'] = [entryWithCalories];

    // Execute a simple action (triggers migration)
    await tool.execute({ action: 'list' }, context);

    // Verify migration completed
    expect(storage._store['schema_version']).toBe(4);

    // Verify calories field removed from entry
    const migratedEntries = storage._store['food:2026-01-10'] as FoodEntry[];
    expect(migratedEntries).toBeDefined();
    expect(migratedEntries[0]).not.toHaveProperty('calories');
  });

  it('should recover orphan entries with calorie data', async () => {
    const { tool, storage, context } = setupTool();

    // Entry with non-existent dishId but has calories
    const orphanEntry = {
      id: 'food_orphan',
      dishId: 'item_missing',
      calories: 150,
      portion: { quantity: 100, unit: 'g' as const },
      timestamp: '2026-01-10T08:00:00Z',
      recipientId: 'user_test',
    };
    storage._store['food:2026-01-10'] = [orphanEntry];
    // Initialize items array explicitly
    storage._store[CALORIES_STORAGE_KEYS.items] = [];

    // Execute triggers migration
    const result = await tool.execute({ action: 'list' }, context);

    // Verify migration completed
    expect(storage._store['schema_version']).toBe(4);

    // Should have created an orphan item
    const items = storage._store[CALORIES_STORAGE_KEYS.items] as FoodItem[];
    expect(items).toBeDefined();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].id).toMatch(/^orphan_/);

    // Entry should reference the orphan item
    const entries = storage._store['food:2026-01-10'] as FoodEntry[];
    expect(entries).toBeDefined();
    expect(entries[0].dishId).toMatch(/^orphan_/);
  });

  it('should skip migration if already v3', async () => {
    const { tool, storage, context } = setupTool();
    storage._store['schema_version'] = 4;

    await tool.execute({ action: 'list' }, context);

    // Should still be v3
    expect(storage._store['schema_version']).toBe(4);
  });
});

describe('Calories Tool - Relational Reads', () => {
  it('should compute calories from item basis at read time', async () => {
    const { tool, storage, context } = setupTool();

    // Setup v2 data (no calories in entry)
    const item: FoodItem = {
      id: 'item_bacon',
      canonicalName: 'Бекон',
      measurementKind: 'weight',
      basis: { caloriesPer: 425, perQuantity: 100, perUnit: 'g' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };
    const entry: FoodEntry = {
      id: 'food_123',
      dishId: 'item_bacon',
      portion: { quantity: 45, unit: 'g' },
      timestamp: '2026-01-10T08:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['food:2026-01-10'] = [entry];
    storage._store['schema_version'] = 4;

    // Get summary
    const result = await tool.execute({ action: 'summary', date: '2026-01-10' }, context);

    expect(result.success).toBe(true);
    if ('totalCalories' in result) {
      // 45g * 425cal/100g = 191.25 ≈ 191
      expect(result.totalCalories).toBe(191);
    }
  });

  it('should return 0 calories for missing item', async () => {
    const { tool, storage, context } = setupTool();

    const entry: FoodEntry = {
      id: 'food_missing',
      dishId: 'item_nonexistent',
      portion: { quantity: 100, unit: 'g' },
      timestamp: '2026-01-10T08:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [];
    storage._store['food:2026-01-10'] = [entry];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({ action: 'summary', date: '2026-01-10' }, context);

    expect(result.success).toBe(true);
    if ('totalCalories' in result) {
      expect(result.totalCalories).toBe(0);
    }
  });
});

describe('Calories Tool - Search Action', () => {
  it('should search entries by item name across all dates', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    const entry1: FoodEntry = {
      id: 'food_1',
      dishId: 'item_coffee',
      portion: { quantity: 200, unit: 'ml' },
      timestamp: '2026-01-10T08:00:00Z',
      recipientId: 'user_test',
    };
    const entry2: FoodEntry = {
      id: 'food_2',
      dishId: 'item_coffee',
      portion: { quantity: 400, unit: 'ml' },
      timestamp: '2026-01-09T08:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['food:2026-01-10'] = [entry1];
    storage._store['food:2026-01-09'] = [entry2];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({ action: 'search', queries: ['американо'] }, context);

    expect(result.success).toBe(true);
    if ('results' in result) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].matchedItems).toHaveLength(1);
      expect(result.results[0].entries).toHaveLength(2);
      expect(result.results[0].totalCalories).toBe(15); // 5 + 10
    }
  });

  it('should limit results per query', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    // Create many entries
    for (let i = 0; i < 100; i++) {
      const entry: FoodEntry = {
        id: `food_${i}`,
        dishId: 'item_coffee',
        portion: { quantity: 200, unit: 'ml' },
        timestamp: `2026-01-${String(10 + (i % 20)).padStart(2, '0')}T08:00:00Z`,
        recipientId: 'user_test',
      };
      const date = `2026-01-${String(10 + (i % 20)).padStart(2, '0')}`;
      const key = `food:${date}`;
      const existing = (storage._store[key] as FoodEntry[]) ?? [];
      existing.push(entry);
      storage._store[key] = existing;
    }

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({ action: 'search', queries: ['американо'], max_results: 10 }, context);

    expect(result.success).toBe(true);
    if ('results' in result) {
      expect(result.results[0].entries.length).toBeLessThanOrEqual(10);
      expect(result.results[0].truncated).toBe(true);
      expect(result.results[0].totalEntries).toBeGreaterThan(10);
    }
  });

  it('should support multiple queries', async () => {
    const { tool, storage, context } = setupTool();

    const coffee: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };
    const yogurt: FoodItem = {
      id: 'item_yogurt',
      canonicalName: 'Йогурт',
      measurementKind: 'weight',
      basis: { caloriesPer: 67, perQuantity: 100, perUnit: 'g' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [coffee, yogurt];
    storage._store['food:2026-01-10'] = [
      { id: 'food_1', dishId: 'item_coffee', portion: { quantity: 200, unit: 'ml' }, timestamp: '2026-01-10T08:00:00Z', recipientId: 'user_test' },
      { id: 'food_2', dishId: 'item_yogurt', portion: { quantity: 140, unit: 'g' }, timestamp: '2026-01-10T08:00:00Z', recipientId: 'user_test' },
    ];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({ action: 'search', queries: ['американо', 'йогурт'] }, context);

    expect(result.success).toBe(true);
    if ('results' in result) {
      expect(result.results).toHaveLength(2);
      expect(result.results[0].query).toBe('американо');
      expect(result.results[1].query).toBe('йогурт');
    }
  });
});

describe('Calories Tool - Stats Action', () => {
  it('should compute multi-day statistics', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    // Create entries for 7 days (relative to today so test doesn't break as dates advance)
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      storage._store[`food:${dateStr}`] = [
        {
          id: `food_${i}`,
          dishId: 'item_coffee',
          portion: { quantity: 200, unit: 'ml' },
          timestamp: `${dateStr}T08:00:00Z`,
          recipientId: 'user_test',
        },
      ];
    }

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    const recentWeight = new Date(today);
    const olderWeight = new Date(today);
    olderWeight.setDate(olderWeight.getDate() - 7);
    storage._store[CALORIES_STORAGE_KEYS.weights] = [
      { id: 'weight_1', weight: 75, measuredAt: recentWeight.toISOString(), recipientId: 'user_test' },
      { id: 'weight_2', weight: 75.5, measuredAt: olderWeight.toISOString(), recipientId: 'user_test' },
    ];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({ action: 'stats', days: 7 }, context);

    expect(result.success).toBe(true);
    if ('dailyCalories' in result) {
      expect(result.dailyCalories).toHaveLength(7);
      expect(result.averageCalories).toBe(5);
      expect(result.streak).toBe(7);
      expect(result.weightTrend.direction).toBe('down'); // 75.5 -> 75
    }
  });
});

describe('Calories Tool - Update Item Action', () => {
  it('should update item name', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'update_dish',
      dish_id: 'item_coffee',
      new_name: 'Американо с молоком',
    }, context);

    expect(result.success).toBe(true);
    if ('item' in result && result.item) {
      expect(result.item.canonicalName).toBe('Американо с молоком');
    }
  });

  it('should update item basis', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'update_dish',
      dish_id: 'item_coffee',
      new_basis: { caloriesPer: 10, perQuantity: 200, perUnit: 'ml' },
    }, context);

    expect(result.success).toBe(true);
    if ('item' in result && result.item) {
      expect(result.item.basis.caloriesPer).toBe(10);
    }
  });

  it('should return dailySummary with recalculated calories after basis update', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_pasta',
      canonicalName: 'Макароны',
      measurementKind: 'weight',
      basis: { caloriesPer: 350, perQuantity: 100, perUnit: 'g' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    const todayStr = new Date().toISOString().split('T')[0];
    const entry: FoodEntry = {
      id: 'food_pasta1',
      dishId: 'item_pasta',
      portion: { quantity: 170, unit: 'g' },
      timestamp: `${todayStr}T12:00:00Z`,
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store[`food:${todayStr}`] = [entry];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'update_dish',
      dish_id: 'item_pasta',
      new_basis: { caloriesPer: 130, perQuantity: 100, perUnit: 'g' },
    }, context);

    expect(result.success).toBe(true);
    // Should include dailySummary with recalculated calories (170g × 130/100 = 221)
    if ('dailySummary' in result && result.dailySummary) {
      expect(result.dailySummary.totalCalories).toBe(221);
    } else {
      throw new Error('Expected dailySummary in update_dish result');
    }
  });

  it('should return candidates for ambiguous name match', async () => {
    const { tool, storage, context } = setupTool();

    const items: FoodItem[] = [
      {
        id: 'item_yogurt1',
        canonicalName: 'Йогурт Греческий',
        measurementKind: 'weight',
        basis: { caloriesPer: 67, perQuantity: 100, perUnit: 'g' },
        createdAt: '2026-01-10T10:00:00Z',
        updatedAt: '2026-01-10T10:00:00Z',
        recipientId: 'user_test',
      },
      {
        id: 'item_yogurt2',
        canonicalName: 'Йогурт Фруктовый',
        measurementKind: 'weight',
        basis: { caloriesPer: 90, perQuantity: 100, perUnit: 'g' },
        createdAt: '2026-01-10T10:00:00Z',
        updatedAt: '2026-01-10T10:00:00Z',
        recipientId: 'user_test',
      },
    ];

    storage._store[CALORIES_STORAGE_KEYS.items] = items;
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'update_dish',
      name: 'йогурт',
      new_name: 'Новый йогурт',
    }, context);

    expect(result.success).toBe(false);
    if ('candidates' in result && result.candidates) {
      expect(result.candidates.length).toBeGreaterThan(0);
    }
  });
});

describe('Calories Tool - Delete Item Action', () => {
  it('should reject deletion if entries reference the item', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['food:2026-01-10'] = [
      { id: 'food_1', dishId: 'item_coffee', portion: { quantity: 200, unit: 'ml' }, timestamp: '2026-01-10T08:00:00Z', recipientId: 'user_test' },
    ];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'delete_dish',
      dish_id: 'item_coffee',
    }, context);

    expect(result.success).toBe(false);
    if ('referencedBy' in result && result.referencedBy) {
      expect(result.referencedBy.count).toBeGreaterThan(0);
    }
  });

  it('should delete item with no references', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'delete_dish',
      dish_id: 'item_coffee',
    }, context);

    expect(result.success).toBe(true);
    const items = storage._store[CALORIES_STORAGE_KEYS.items] as FoodItem[];
    expect(items).toHaveLength(0);
  });
});

describe('Calories Tool - Duplicate Detection', () => {
  it('should return existingEntries when logging same item on same day', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    // Existing entry for today
    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['food:2026-02-16'] = [
      { id: 'food_existing', dishId: 'item_coffee', portion: { quantity: 200, unit: 'ml' }, mealType: 'breakfast', timestamp: '2026-02-16T08:00:00Z', recipientId: 'user_test' },
    ];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'log',
      entries: [{ name: 'Американо', portion: { quantity: 200, unit: 'ml' } }],
    }, context);

    expect(result.success).toBe(true);
    if ('results' in result && result.results.length > 0) {
      const logResult = result.results[0];
      if ('existingEntries' in logResult && logResult.existingEntries) {
        expect(logResult.existingEntries).toHaveLength(1);
        expect(logResult.existingEntries[0].entryId).toBe('food_existing');
      }
    }
  });
});

describe('Calories Tool - After-Midnight Fix', () => {
  it('should route late-night entry to previous day based on timestamp', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['schema_version'] = 4;

    // Log entry with timestamp 01:30 AM - before cutoff (3 AM for 23-7 sleep pattern)
    // Should go to yesterday's partition
    const yesterdayStr = '2026-02-15';

    await tool.execute({
      action: 'log',
      entries: [{
        name: 'Американо',
        portion: { quantity: 200, unit: 'ml' },
        timestamp: `2026-02-16T01:30:00`, // 1:30 AM on Feb 16, should route to Feb 15
      }],
    }, context);

    // Entry should be in yesterday's partition (Feb 15)
    const yesterdayEntries = storage._store['food:2026-02-15'] as FoodEntry[];
    expect(yesterdayEntries).toBeDefined();
    expect(yesterdayEntries.length).toBeGreaterThan(0);
  });

  it('should add warning for invalid timestamp', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };

    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'log',
      entries: [{
        name: 'Американо',
        portion: { quantity: 200, unit: 'ml' },
        timestamp: 'invalid-timestamp',
      }],
    }, context);

    expect(result.success).toBe(true);
    if ('results' in result && result.results.length > 0) {
      const logResult = result.results[0];
      if ('warning' in logResult) {
        expect(logResult.warning).toContain('Invalid timestamp');
      }
    }
  });
});

describe('Calories Tool - Intra-Batch Deduplication', () => {
  beforeEach(() => {
    resetMigrationState();
    vi.clearAllMocks();
  });

  it('should collapse identical entries within a single batch', async () => {
    const { tool, storage, context } = setupTool();
    storage._store[CALORIES_STORAGE_KEYS.items] = [];
    storage._store['schema_version'] = 4;

    // Send 3 identical "Трилече" entries in one batch — only 1 should be saved
    const result = await tool.execute({
      action: 'log',
      entries: [
        { name: 'Трилече', portion: { quantity: 100, unit: 'g' }, calories_per_100g: 245, meal_type: 'snack' },
        { name: 'Трилече', portion: { quantity: 100, unit: 'g' }, calories_per_100g: 245, meal_type: 'snack' },
        { name: 'Трилече', portion: { quantity: 100, unit: 'g' }, calories_per_100g: 245, meal_type: 'snack' },
      ],
    }, context);

    expect(result.success).toBe(true);
    // Only 1 result — the other 2 were deduped
    expect((result as { results: unknown[] }).results).toHaveLength(1);

    // Verify only 1 entry was actually saved in storage
    const dateKeys = await storage.keys('food:*');
    let totalEntries = 0;
    for (const key of dateKeys) {
      const entries = await storage.get<FoodEntry[]>(key);
      if (entries) totalEntries += entries.length;
    }
    expect(totalEntries).toBe(1);
  });

  it('should keep entries with different meal types as separate', async () => {
    const { tool, storage, context } = setupTool();
    storage._store[CALORIES_STORAGE_KEYS.items] = [];
    storage._store['schema_version'] = 4;

    // Same food at different meals — should NOT be deduped
    const result = await tool.execute({
      action: 'log',
      entries: [
        { name: 'Изюм', portion: { quantity: 30, unit: 'g' }, calories_per_100g: 300, meal_type: 'breakfast' },
        { name: 'Изюм', portion: { quantity: 30, unit: 'g' }, calories_per_100g: 300, meal_type: 'snack' },
      ],
    }, context);

    expect(result.success).toBe(true);
    expect((result as { results: unknown[] }).results).toHaveLength(2);
  });

  it('should keep entries with different portions as separate', async () => {
    const { tool, storage, context } = setupTool();
    storage._store[CALORIES_STORAGE_KEYS.items] = [];
    storage._store['schema_version'] = 4;

    // Same food, different portions — should NOT be deduped
    const result = await tool.execute({
      action: 'log',
      entries: [
        { name: 'Кофе', portion: { quantity: 200, unit: 'ml' }, calories_estimate: 5 },
        { name: 'Кофе', portion: { quantity: 400, unit: 'ml' }, calories_estimate: 10 },
      ],
    }, context);

    expect(result.success).toBe(true);
    expect((result as { results: unknown[] }).results).toHaveLength(2);
  });

  it('should add dedup warning to the surviving entry', async () => {
    const { tool, storage, context } = setupTool();
    storage._store[CALORIES_STORAGE_KEYS.items] = [];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'log',
      entries: [
        { name: 'Трилече', portion: { quantity: 100, unit: 'g' }, calories_per_100g: 245, meal_type: 'snack' },
        { name: 'Трилече', portion: { quantity: 100, unit: 'g' }, calories_per_100g: 245, meal_type: 'snack' },
      ],
    }, context);

    const results = (result as { results: Array<{ warning?: string }> }).results;
    expect(results).toHaveLength(1);
    expect(results[0].warning).toContain('Duplicate');
  });
});

describe('Calories Tool - Unlog Returns Daily Summary', () => {
  beforeEach(() => {
    resetMigrationState();
    vi.clearAllMocks();
  });

  it('should return updated daily summary after deleting an entry', async () => {
    const { tool, storage, context } = setupTool();

    const item: FoodItem = {
      id: 'item_coffee',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };
    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['food:2026-02-16'] = [
      { id: 'food_keep', dishId: 'item_coffee', portion: { quantity: 200, unit: 'ml' }, timestamp: '2026-02-16T08:00:00Z', recipientId: 'user_test' },
      { id: 'food_delete', dishId: 'item_coffee', portion: { quantity: 200, unit: 'ml' }, timestamp: '2026-02-16T10:00:00Z', recipientId: 'user_test' },
    ];
    storage._store['schema_version'] = 4;

    const result = await tool.execute({
      action: 'unlog',
      entry_id: 'food_delete',
    }, context);

    expect(result.success).toBe(true);
    // Should include daily summary with updated totals
    expect((result as { dailySummary: { totalCalories: number } }).dailySummary).toBeDefined();
    expect((result as { dailySummary: { totalCalories: number } }).dailySummary.totalCalories).toBe(5);
    // Only 1 entry should remain
    const remaining = storage._store['food:2026-02-16'] as FoodEntry[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('food_keep');
  });
});

describe('Calories Tool - Auto-Update Dish Basis', () => {
  beforeEach(() => {
    resetMigrationState();
    vi.clearAllMocks();
  });

  it('should update dish basis when log provides different calories_per_100g', async () => {
    const { tool, storage, context } = setupTool();

    // Existing dish with 350 kcal/100g (wrong — dry pasta rate)
    const item: FoodItem = {
      id: 'item_pasta',
      canonicalName: 'Макароны',
      measurementKind: 'weight',
      basis: { caloriesPer: 350, perQuantity: 100, perUnit: 'g' },
      createdAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      recipientId: 'user_test',
    };
    storage._store[CALORIES_STORAGE_KEYS.items] = [item];
    storage._store['schema_version'] = 4;

    // Log with corrected calories_per_100g (130 — cooked pasta)
    const result = await tool.execute({
      action: 'log',
      entries: [{ name: 'Макароны', portion: { quantity: 170, unit: 'g' }, calories_per_100g: 130 }],
    }, context);

    expect(result.success).toBe(true);

    // The dish basis should have been updated
    const items = storage._store[CALORIES_STORAGE_KEYS.items] as FoodItem[];
    const pasta = items.find((i) => i.id === 'item_pasta');
    expect(pasta).toBeDefined();
    expect(pasta!.basis.caloriesPer).toBe(130);
    expect(pasta!.basis.perQuantity).toBe(100);
    expect(pasta!.basis.perUnit).toBe('g');

    // The daily summary should reflect the corrected calories
    const logResult = result as { dailySummary: { totalCalories: number } };
    expect(logResult.dailySummary.totalCalories).toBe(221); // 170g × 130/100
  });
});
