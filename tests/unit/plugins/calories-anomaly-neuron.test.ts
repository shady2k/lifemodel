/**
 * Unit tests for CaloriesAnomalyNeuron.
 *
 * Tests the anomaly detection algorithm that replaces the old
 * deficit-based nagging approach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CaloriesAnomalyNeuron, DEFAULT_CALORIES_ANOMALY_CONFIG } from '../../../src/plugins/calories/calories-neuron.js';
import type { AgentState } from '../../../src/types/agent/state.js';
import type { FoodEntry, FoodItem } from '../../../src/plugins/calories/calories-types.js';
import { CALORIES_STORAGE_KEYS } from '../../../src/plugins/calories/calories-types.js';
import { DateTime, Settings } from 'luxon';

const NEURON_STATE_KEY = 'calories_anomaly_neuron_state';
const BASELINE_CACHE_KEY = 'calories_anomaly_baseline';

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

function createMockStorage(data: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...data };
  return {
    get: vi.fn(async <T>(key: string): Promise<T | null> => (store[key] as T) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { store[key] = value; }),
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => Object.keys(store)),
    query: vi.fn(async () => []),
    _store: store,
  };
}

function createAgentState(): AgentState {
  return {
    energy: 1.0,
    socialDebt: 0,
    taskPressure: 0,
    curiosity: 0,
    acquaintancePressure: 0,
    acquaintancePending: false,
    thoughtPressure: 0,
    pendingThoughtCount: 0,
    lastTickAt: new Date(),
  };
}

/**
 * Create a food entry for testing.
 */
function createFoodEntry(
  id: string,
  dishId: string,
  hour: number,
  date: string,
  mealType?: string,
  recipientId: string = 'default'
): FoodEntry {
  return {
    id,
    dishId,
    portion: { quantity: 1, unit: 'serving' },
    timestamp: `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    recipientId,
    ...(mealType ? { mealType } : {}),
  };
}

/**
 * Create a food item for testing.
 */
function createFoodItem(id: string, name: string, calories: number): FoodItem {
  return {
    id,
    canonicalName: name,
    measurementKind: 'count',
    basis: {
      caloriesPer: calories,
      perQuantity: 1,
      perUnit: 'serving',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recipientId: 'default',
  };
}

/**
 * Helper to set the fake "now" for both Luxon and Date.now.
 */
function setFakeNow(isoString: string) {
  const dt = DateTime.fromISO(isoString, { zone: 'UTC' });
  Settings.now = () => dt.toMillis();
  vi.spyOn(Date, 'now').mockReturnValue(dt.toMillis());
}

function afterFakeNow() {
  vi.restoreAllMocks();
  Settings.now = () => Date.now();
}

describe('CaloriesAnomalyNeuron', () => {
  const TZ = 'UTC';
  const RECIPIENT_ID = 'default';
  const TODAY = '2025-06-15'; // Sunday
  // 4 PM UTC = 10 hours after 6 AM wake, 10/16 = 62.5% day progress (past 60% threshold)
  const NOW_4PM = `${TODAY}T16:00:00.000Z`;

  // Standard wake patterns for testing
  const WAKE_PATTERNS = { wakeHour: 6, sleepHour: 22 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    afterFakeNow();
  });

  function createNeuron(
    storage: ReturnType<typeof createMockStorage>,
    goal: number | null = 2000,
    patterns: { wakeHour?: number; sleepHour?: number } | null = WAKE_PATTERNS,
  ) {
    return new CaloriesAnomalyNeuron(
      mockLogger as any,
      {},
      storage,
      () => TZ,
      () => patterns,
      async () => goal,
    );
  }

  /**
   * Create storage with baseline history (past days with food entries).
   * Note: Does NOT add today's entries - caller should set those directly in the store.
   */
  function createStorageWithBaseline(
    dayCount: number,
    caloriesPerDay: number = 1500,
    mealsPerDay: number = 3,
    todayEntries: FoodEntry[] = []
  ): Record<string, unknown> {
    const store: Record<string, unknown> = {};

    // Create items catalog
    const items: FoodItem[] = [];
    for (let i = 1; i <= 5; i++) {
      items.push(createFoodItem(`item-${i}`, `Food ${i}`, 300));
    }
    store[CALORIES_STORAGE_KEYS.items] = items;

    // Create entries for past days
    const todayDate = DateTime.fromISO(TODAY);
    for (let i = 1; i <= dayCount; i++) {
      const date = todayDate.minus({ days: i }).toISODate();
      if (!date) continue;

      const entries: FoodEntry[] = [];
      const caloriesPerMeal = Math.floor(caloriesPerDay / mealsPerDay);
      const itemsNeeded = Math.ceil(caloriesPerMeal / 300);

      // Breakfast at 7 AM (wake hour + 1)
      for (let j = 0; j < itemsNeeded; j++) {
        entries.push(createFoodEntry(
          `entry-${date}-b-${j}`,
          `item-${j + 1}`,
          7,
          date,
          'breakfast'
        ));
      }

      // Lunch at 12 PM
      for (let j = 0; j < itemsNeeded; j++) {
        entries.push(createFoodEntry(
          `entry-${date}-l-${j}`,
          `item-${j + 1}`,
          12,
          date,
          'lunch'
        ));
      }

      // Dinner at 18 PM
      for (let j = 0; j < itemsNeeded; j++) {
        entries.push(createFoodEntry(
          `entry-${date}-d-${j}`,
          `item-${j + 1}`,
          18,
          date,
          'dinner'
        ));
      }

      store[`${CALORIES_STORAGE_KEYS.foodPrefix}${date}`] = entries;
    }

    // Add today's entries (can be empty array or populated)
    store[`${CALORIES_STORAGE_KEYS.foodPrefix}${TODAY}`] = todayEntries;

    return store;
  }

  describe('insufficient history', () => {
    it('should be silent with less than 3 days of history', async () => {
      const store = createStorageWithBaseline(2); // Only 2 days
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeUndefined();
    });
  });

  describe('normal day', () => {
    it('should be silent when eating at normal pace', async () => {
      const todayEntries: FoodEntry[] = [
        createFoodEntry('today-b-1', 'item-1', 7, TODAY, 'breakfast'),
        createFoodEntry('today-b-2', 'item-2', 7, TODAY, 'breakfast'),
        createFoodEntry('today-l-1', 'item-1', 12, TODAY, 'lunch'),
      ];
      const store = createStorageWithBaseline(7, 1500, 3, todayEntries);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeUndefined();
    });
  });

  describe('anomalous low intake', () => {
    it('should fire when calories significantly below baseline', async () => {
      // Both meals logged but tiny portions — calories well below baseline
      // while meal count (2) stays close to expected (2 by 4 PM)
      const todayEntries: FoodEntry[] = [
        createFoodEntry('today-b-1', 'item-1', 7, TODAY, 'breakfast'),
        createFoodEntry('today-l-1', 'item-1', 12, TODAY, 'lunch'),
      ];
      const store = createStorageWithBaseline(7, 1500, 3, todayEntries);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeDefined();
      expect(signal?.data.eventKind).toBe('calories:anomaly');
      expect(signal?.data.payload.anomalyType).toBe('low_intake');
    });
  });

  describe('missing meals', () => {
    it('should fire when meal count significantly below baseline', async () => {
      // Enough total calories but only one meal type
      const todayEntries: FoodEntry[] = [
        createFoodEntry('today-1', 'item-1', 7, TODAY, 'breakfast'),
        createFoodEntry('today-2', 'item-2', 8, TODAY, 'breakfast'),
        createFoodEntry('today-3', 'item-3', 9, TODAY, 'breakfast'),
        createFoodEntry('today-4', 'item-4', 10, TODAY, 'breakfast'),
      ];
      const store = createStorageWithBaseline(7, 1500, 3, todayEntries);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeDefined();
      expect(signal?.data.payload.anomalyType).toBe('missing_meals');
    });
  });

  describe('too early in day', () => {
    it('should be silent before 60% of waking hours elapsed', async () => {
      // No food at all today
      const store = createStorageWithBaseline(7, 1500, 3, []);
      const storage = createMockStorage(store);

      // 9 AM = 3 hours after 6 AM wake, 3/16 = 18.75% (below 60%)
      const NOW_9AM = `${TODAY}T09:00:00.000Z`;
      setFakeNow(NOW_9AM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeUndefined();
    });
  });

  describe('once-per-day guard', () => {
    it('should not emit more than once per day', async () => {
      // No food today
      const store = createStorageWithBaseline(7, 1500, 3, []);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      // First emission
      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 10));

      const signal1 = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal1).toBeDefined();

      // Try again later (6 PM)
      const NOW_6PM = `${TODAY}T18:00:00.000Z`;
      setFakeNow(NOW_6PM);

      neuron.check(createAgentState(), 0.8, 'test-3');
      await new Promise(resolve => setTimeout(resolve, 10));

      const signal2 = neuron.check(createAgentState(), 0.8, 'test-4');
      expect(signal2).toBeUndefined();
    });

    it('should respect persisted lastEmittedDate after restart', async () => {
      // Simulate already emitted today
      const store = createStorageWithBaseline(7, 1500, 3, []);
      store[NEURON_STATE_KEY] = { lastEmittedDate: TODAY };
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeUndefined();
    });
  });

  describe('no calorie goal', () => {
    it('should be dormant when no goal is set', async () => {
      const store = createStorageWithBaseline(7, 1500, 3, []);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage, null); // No goal

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeUndefined();
    });
  });

  describe('sleep hours', () => {
    it('should be silent during sleep hours (low alertness)', async () => {
      const store = createStorageWithBaseline(7, 1500, 3, []);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      // Alertness < 0.3 = sleep
      const signal = neuron.check(createAgentState(), 0.2, 'test-1');
      expect(signal).toBeUndefined();
    });
  });

  describe('floor guard', () => {
    it('should be silent when expected calories below 200 kcal', async () => {
      // Create baseline with very low expected calories at this hour
      // (e.g., user is a late eater / OMAD)
      const store = createStorageWithBaseline(7, 500, 1, []); // Only 500 cal/day, 1 meal
      const storage = createMockStorage(store);

      // Early afternoon - expected would be very low
      const NOW_2PM = `${TODAY}T14:00:00.000Z`;
      setFakeNow(NOW_2PM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100)); // Increased timeout for async baseline computation

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      // Silent because expected calories too low (floor guard)
      expect(signal).toBeUndefined();
    });
  });

  describe('compute in flight guard', () => {
    it('should not start new computation while one is in flight', async () => {
      const store = createStorageWithBaseline(7, 1500, 3, []);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      // First check starts async computation
      neuron.check(createAgentState(), 0.8, 'test-1');
      // Immediate second check should be skipped (compute in flight)
      neuron.check(createAgentState(), 0.8, 'test-1b');

      await new Promise(resolve => setTimeout(resolve, 10));

      // Third check should return the pending signal
      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeDefined();

      // Fourth check should return undefined (signal consumed)
      const signal2 = neuron.check(createAgentState(), 0.8, 'test-3');
      expect(signal2).toBeUndefined();
    });
  });

  describe('both anomaly type', () => {
    it('should report both when calories and meals are anomalous', async () => {
      // Only 1 breakfast entry (1 meal, 300 cal) vs baseline of 3 meals, 1500 cal
      const todayEntries: FoodEntry[] = [
        createFoodEntry('today-b-1', 'item-1', 7, TODAY, 'breakfast'),
      ];
      const store = createStorageWithBaseline(7, 1500, 3, todayEntries);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      const neuron = createNeuron(storage);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100));

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      expect(signal).toBeDefined();
      expect(signal?.data.payload.anomalyType).toBe('both');
    });
  });

  describe('null wake patterns fallback', () => {
    it('should use wall clock hours when no wake patterns available', async () => {
      // No food today, null patterns → falls back to wall clock
      const store = createStorageWithBaseline(7, 1500, 3, []);
      const storage = createMockStorage(store);

      setFakeNow(NOW_4PM);
      // Pass null patterns — should fall back to wall clock hour (16)
      // and default 16 waking hours, dayProgress = 16/16 = 100%
      const neuron = createNeuron(storage, 2000, null);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100));

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      // Should fire — no food logged, well past 60% of day
      expect(signal).toBeDefined();
    });
  });

  describe('food-day boundary (sleep midpoint)', () => {
    it('should use food-day (yesterday) at midnight, not calendar date', async () => {
      // User: sleepHour=23, wakeHour=8 → cutoff = floor((23 + 32) / 2 % 24) = 3
      // At 00:22, hour 0 < cutoff 3, so food-day = yesterday (2025-06-14)
      const patterns = { wakeHour: 8, sleepHour: 23 };
      const YESTERDAY = '2025-06-14';

      const store: Record<string, unknown> = {};
      const items: FoodItem[] = [];
      for (let i = 1; i <= 5; i++) {
        items.push(createFoodItem(`item-${i}`, `Food ${i}`, 300));
      }
      store[CALORIES_STORAGE_KEYS.items] = items;

      // Past 7 days of history before yesterday
      const yesterdayDate = DateTime.fromISO(YESTERDAY);
      for (let i = 1; i <= 7; i++) {
        const date = yesterdayDate.minus({ days: i }).toISODate();
        if (!date) continue;
        store[`${CALORIES_STORAGE_KEYS.foodPrefix}${date}`] = [
          createFoodEntry(`entry-${date}-b`, 'item-1', 9, date, 'breakfast'),
          createFoodEntry(`entry-${date}-l`, 'item-2', 13, date, 'lunch'),
          createFoodEntry(`entry-${date}-d`, 'item-3', 19, date, 'dinner'),
        ];
      }

      // Yesterday (the food-day) has full meals
      store[`${CALORIES_STORAGE_KEYS.foodPrefix}${YESTERDAY}`] = [
        createFoodEntry('yest-b', 'item-1', 9, YESTERDAY, 'breakfast'),
        createFoodEntry('yest-l', 'item-2', 13, YESTERDAY, 'lunch'),
        createFoodEntry('yest-d', 'item-3', 19, YESTERDAY, 'dinner'),
      ];

      // Calendar today has nothing — user is sleeping
      store[`${CALORIES_STORAGE_KEYS.foodPrefix}${TODAY}`] = [];

      const storage = createMockStorage(store);

      setFakeNow(`${TODAY}T00:22:00.000Z`);
      const neuron = createNeuron(storage, 2000, patterns);

      neuron.check(createAgentState(), 0.5, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify the neuron resolved "today" as the food-day (yesterday), not calendar date.
      // The baseline cache stores {date: today, ...} — check it used the food-day.
      const setCalls = storage.set.mock.calls;
      const baselineCache = setCalls.find(
        (c: unknown[]) => c[0] === 'calories_anomaly_baseline'
      );
      expect(baselineCache).toBeDefined();
      // The cached date should be yesterday (food-day), not calendar today
      const cachedDate = (baselineCache![1] as { date: string }).date;
      expect(cachedDate).toBe(YESTERDAY);
      expect(cachedDate).not.toBe(TODAY);
    });
  });

  describe('wakeHour=0 falsy bug', () => {
    it('should respect wakeHour=0 as valid midnight wake time', async () => {
      // User wakes at midnight (wakeHour=0), sleeps at 16 (4 PM)
      // cutoff = floor((16 + 24) / 2 % 24) = 20
      // At 10 AM, hour 10 < cutoff 20, so food-day = yesterday (2025-06-14)
      // wakeRelativeHour = 10 - 0 = 10, wakingHours = 16, dayProgress = 0.625
      const patterns = { wakeHour: 0, sleepHour: 16 };
      const YESTERDAY = '2025-06-14';

      const store: Record<string, unknown> = {};
      const items: FoodItem[] = [
        createFoodItem('item-1', 'Food 1', 500),
      ];
      store[CALORIES_STORAGE_KEYS.items] = items;

      // Build baseline: 7 days of history before yesterday
      const yesterdayDate = DateTime.fromISO(YESTERDAY);
      for (let i = 1; i <= 7; i++) {
        const date = yesterdayDate.minus({ days: i }).toISODate();
        if (!date) continue;
        store[`${CALORIES_STORAGE_KEYS.foodPrefix}${date}`] = [
          createFoodEntry(`entry-${date}-1`, 'item-1', 1, date, 'breakfast'),
          createFoodEntry(`entry-${date}-2`, 'item-1', 6, date, 'lunch'),
          createFoodEntry(`entry-${date}-3`, 'item-1', 12, date, 'dinner'),
        ];
      }

      // Yesterday (the current food-day at 10 AM): no food logged
      store[`${CALORIES_STORAGE_KEYS.foodPrefix}${YESTERDAY}`] = [];

      const storage = createMockStorage(store);

      // 10 AM — well into the day for someone who wakes at midnight
      setFakeNow(`${TODAY}T10:00:00.000Z`);
      const neuron = createNeuron(storage, 2000, patterns);

      neuron.check(createAgentState(), 0.8, 'test-1');
      await new Promise(resolve => setTimeout(resolve, 100));

      const signal = neuron.check(createAgentState(), 0.8, 'test-2');
      // Should fire — wakeHour=0 is valid (not treated as falsy/missing),
      // food-day is yesterday which has no entries
      expect(signal).toBeDefined();
    });
  });
});
