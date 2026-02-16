/**
 * Calories Plugin Schema Migration
 *
 * v2: Remove calories from FoodEntry (pure relational)
 * v3: Normalize all weight-based item bases to per-100g
 *
 * Migration states:
 * - undefined: never migrated, run from v1
 * - 'migrating': interrupted, re-run (idempotent)
 * - 2: v2 done, run v3
 * - 3: fully migrated, skip
 *
 * Concurrency: module-level promise lock ensures only one migration runs.
 */

import type { Logger } from '../../types/logger.js';
import type { StoragePrimitive } from '../../types/plugin.js';
import type { FoodItem, FoodEntry, NutrientBasis } from './calories-types.js';
import { CALORIES_STORAGE_KEYS } from './calories-types.js';

const TARGET_SCHEMA_VERSION = 3;

let migrationPromise: Promise<void> | null = null;

/**
 * Reset migration state (for testing only).
 */
export function resetMigrationState(): void {
  migrationPromise = null;
}

/**
 * Derive a deterministic ID for an orphan item.
 * Uses the original itemId + recipientId to prevent duplicates on re-run.
 */
function deriveOrphanItemId(originalItemId: string, recipientId: string): string {
  const hash = simpleHash(`${recipientId}:${originalItemId}`);
  return `orphan_${hash}`;
}

/**
 * Simple string hash for deterministic ID generation.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalize a weight-based basis to per-100g canonical form.
 * Returns the basis unchanged if not weight-based.
 */
export function normalizeBasis(basis: NutrientBasis): NutrientBasis {
  if (basis.perUnit === 'g' && basis.perQuantity !== 100) {
    return {
      caloriesPer: Math.round((basis.caloriesPer / basis.perQuantity) * 100),
      perQuantity: 100,
      perUnit: 'g',
    };
  }
  if (basis.perUnit === 'kg') {
    // Convert kg basis to per-100g: e.g. 2500 kcal per 1 kg = 250 kcal per 100g
    const gramsQuantity = basis.perQuantity * 1000;
    return {
      caloriesPer: Math.round((basis.caloriesPer / gramsQuantity) * 100),
      perQuantity: 100,
      perUnit: 'g',
    };
  }
  return basis;
}

/**
 * Reconstruct a FoodItem from an orphaned entry's calorie data.
 * Uses the old calories field + portion to derive a normalized basis.
 */
function reconstructItemFromEntry(
  entry: FoodEntry & { calories: number },
  originalItemId: string
): FoodItem {
  const { portion, calories } = entry;

  // Infer measurement kind from portion unit
  let measurementKind: FoodItem['measurementKind'] = 'serving';
  if (portion.unit === 'g' || portion.unit === 'kg') {
    measurementKind = 'weight';
  } else if (portion.unit === 'ml' || portion.unit === 'l') {
    measurementKind = 'volume';
  } else if (portion.unit === 'item' || portion.unit === 'slice') {
    measurementKind = 'count';
  }

  // Create basis from the entry's calorie data, then normalize
  const rawBasis: NutrientBasis = {
    caloriesPer: calories,
    perQuantity: portion.quantity,
    perUnit: portion.unit,
  };

  const now = new Date().toISOString();

  return {
    id: deriveOrphanItemId(originalItemId, entry.recipientId),
    canonicalName: `Recovered Item (${originalItemId})`,
    measurementKind,
    basis: normalizeBasis(rawBasis),
    createdAt: now,
    updatedAt: now,
    recipientId: entry.recipientId,
  };
}

/**
 * Run the schema v2 migration (relational model).
 */
async function runMigrationV2(
  storage: StoragePrimitive,
  logger: Logger
): Promise<{ entriesProcessed: number; orphansRecovered: number }> {
  logger.info({}, 'Starting schema v2 migration');

  // Step 1: Mark as migrating
  await storage.set(CALORIES_STORAGE_KEYS.schemaVersion, 'migrating');

  // Step 2: Load all items
  const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
  const itemsMap = new Map<string, FoodItem>();
  const orphanItems: FoodItem[] = [];

  for (const item of allItems) {
    itemsMap.set(item.id, item);
  }

  // Track orphan itemIds to avoid duplicates
  const orphanItemIds = new Set<string>();

  // Step 3: Scan all date partitions — build transforms in memory first
  const dateKeys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);
  let entriesProcessed = 0;
  let orphansRecovered = 0;

  // Collect all cleaned entries per key before writing anything
  const cleanedByKey = new Map<string, FoodEntry[]>();

  for (const key of dateKeys) {
    const entries = await storage.get<(FoodEntry & { calories?: number })[]>(key);
    if (!entries || entries.length === 0) continue;

    const cleanedEntries: FoodEntry[] = [];

    for (const entry of entries) {
      entriesProcessed++;

      // Check if this entry references an existing item
      const existingItem = itemsMap.get(entry.itemId);

      if (!existingItem) {
        // Orphaned entry - need to recover if it has calories data
        if (typeof entry.calories === 'number') {
          // Check if we already created an orphan for this itemId
          const orphanId = deriveOrphanItemId(entry.itemId, entry.recipientId);
          let orphanItem: FoodItem | undefined = orphanItems.find((o) => o.id === orphanId);

          if (!orphanItem) {
            // Create new orphan item (basis already normalized in reconstructItemFromEntry)
            orphanItem = reconstructItemFromEntry(
              entry as FoodEntry & { calories: number },
              entry.itemId
            );
            orphanItems.push(orphanItem);
            itemsMap.set(orphanItem.id, orphanItem);
            orphanItemIds.add(orphanId);
            orphansRecovered++;
          }

          // Update entry to point to orphan
          const cleanedEntry: FoodEntry = {
            id: entry.id,
            itemId: orphanItem.id,
            portion: entry.portion,
            timestamp: entry.timestamp,
            recipientId: entry.recipientId,
          };
          if (entry.mealType) cleanedEntry.mealType = entry.mealType;
          if (entry.note) cleanedEntry.note = entry.note;
          cleanedEntries.push(cleanedEntry);
        } else {
          // Entry without calories data and item doesn't exist - skip
          logger.warn(
            { entryId: entry.id, itemId: entry.itemId },
            'Skipping orphan entry without calories data'
          );
        }
      } else {
        // Normal entry - just strip calories field
        const cleanedEntry: FoodEntry = {
          id: entry.id,
          itemId: entry.itemId,
          portion: entry.portion,
          timestamp: entry.timestamp,
          recipientId: entry.recipientId,
        };
        if (entry.mealType) cleanedEntry.mealType = entry.mealType;
        if (entry.note) cleanedEntry.note = entry.note;
        cleanedEntries.push(cleanedEntry);
      }
    }

    cleanedByKey.set(key, cleanedEntries);
  }

  // Step 4: Persist items FIRST (with recovered orphans) — crash-safe ordering
  const updatedItems = Array.from(itemsMap.values());
  await storage.set(CALORIES_STORAGE_KEYS.items, updatedItems);

  // Step 5: Persist cleaned entries (orphan items are already durable)
  for (const [key, entries] of cleanedByKey) {
    await storage.set(key, entries);
  }

  // Step 6: Mark v2 complete
  await storage.set(CALORIES_STORAGE_KEYS.schemaVersion, 2);

  logger.info(
    { entriesProcessed, orphansRecovered, totalItems: updatedItems.length },
    'Schema v2 migration complete'
  );

  return { entriesProcessed, orphansRecovered };
}

/**
 * Run the schema v3 migration (normalize all weight-based bases to per-100g).
 */
async function runMigrationV3(storage: StoragePrimitive, logger: Logger): Promise<number> {
  logger.info({}, 'Starting schema v3 migration (basis normalization)');

  const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
  let normalized = 0;

  for (const item of allItems) {
    const newBasis = normalizeBasis(item.basis);
    if (
      newBasis.caloriesPer !== item.basis.caloriesPer ||
      newBasis.perQuantity !== item.basis.perQuantity ||
      newBasis.perUnit !== item.basis.perUnit
    ) {
      item.basis = newBasis;
      item.updatedAt = new Date().toISOString();
      normalized++;
    }
  }

  if (normalized > 0) {
    await storage.set(CALORIES_STORAGE_KEYS.items, allItems);
  }

  await storage.set(CALORIES_STORAGE_KEYS.schemaVersion, TARGET_SCHEMA_VERSION);

  logger.info({ normalized, totalItems: allItems.length }, 'Schema v3 migration complete');
  return normalized;
}

/**
 * Ensure migration has run. Safe to call multiple times.
 * Uses module-level promise lock for concurrency safety.
 */
export async function ensureMigrated(storage: StoragePrimitive, logger: Logger): Promise<void> {
  // Check if migration already in progress or done
  if (migrationPromise) {
    await migrationPromise;
    return;
  }

  // Check current schema version
  const currentVersion = await storage.get<number | 'migrating' | undefined>(
    CALORIES_STORAGE_KEYS.schemaVersion
  );

  if (currentVersion === TARGET_SCHEMA_VERSION) {
    return;
  }

  // Start migration chain
  migrationPromise = (async () => {
    // Run v2 if needed (relational model)
    if (currentVersion === undefined || currentVersion === 'migrating') {
      await runMigrationV2(storage, logger);
    }

    // Run v3 (basis normalization) — always runs if version < 3
    const versionAfterV2 = (await storage.get<number>(CALORIES_STORAGE_KEYS.schemaVersion)) ?? 0;
    if (versionAfterV2 < TARGET_SCHEMA_VERSION) {
      await runMigrationV3(storage, logger);
    }
  })();

  try {
    await migrationPromise;
  } catch (error) {
    // Reset promise on failure so next call can retry
    migrationPromise = null;
    throw error;
  }
}
