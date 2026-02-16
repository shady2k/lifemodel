/**
 * Calories Plugin Schema Migration
 *
 * Migrates from schema v1 (calories stored in FoodEntry) to v2 (pure relational).
 *
 * Migration states:
 * - undefined: never migrated, run migration
 * - 'migrating': interrupted, re-run (idempotent)
 * - 2: done, skip
 *
 * Concurrency: module-level promise lock ensures only one migration runs.
 */

import type { Logger } from '../../types/logger.js';
import type { StoragePrimitive } from '../../types/plugin.js';
import type { FoodItem, FoodEntry, NutrientBasis } from './calories-types.js';
import { CALORIES_STORAGE_KEYS } from './calories-types.js';

const TARGET_SCHEMA_VERSION = 2;

let migrationPromise: Promise<void> | null = null;

/**
 * Reset migration state (for testing only).
 */
export function resetMigrationState(): void {
  migrationPromise = null;
}

/**
 * Derive a deterministic ID for an orphan item.
 * Uses the original itemId to prevent duplicates on re-run.
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
 * Reconstruct a FoodItem from an orphaned entry's calorie data.
 * Uses the old calories field + portion to derive a basis.
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

  // Create basis from the entry's calorie data
  const basis: NutrientBasis = {
    caloriesPer: calories,
    perQuantity: portion.quantity,
    perUnit: portion.unit,
  };

  const now = new Date().toISOString();

  return {
    id: deriveOrphanItemId(originalItemId, entry.recipientId),
    canonicalName: `Recovered Item (${originalItemId})`,
    measurementKind,
    basis,
    createdAt: now,
    updatedAt: now,
    recipientId: entry.recipientId,
  };
}

/**
 * Run the schema v2 migration.
 *
 * Steps:
 * 1. Set schema_version to 'migrating'
 * 2. Load all items into map
 * 3. Scan all food:* date partitions
 * 4. For each entry: recover orphan or strip calories field
 * 5. Save cleaned entries and updated items catalog
 * 6. Set schema_version to 2
 */
async function runMigration(
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
            // Create new orphan item
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
  // If we crash after this but before entry writes, re-run finds items exist and
  // entries still have old calories field, which gets stripped on retry.
  const updatedItems = Array.from(itemsMap.values());
  await storage.set(CALORIES_STORAGE_KEYS.items, updatedItems);

  // Step 5: Persist cleaned entries (orphan items are already durable)
  for (const [key, entries] of cleanedByKey) {
    await storage.set(key, entries);
  }

  // Step 6: Mark migration complete
  await storage.set(CALORIES_STORAGE_KEYS.schemaVersion, TARGET_SCHEMA_VERSION);

  logger.info(
    { entriesProcessed, orphansRecovered, totalItems: updatedItems.length },
    'Schema v2 migration complete'
  );

  return { entriesProcessed, orphansRecovered };
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
    logger.debug({}, 'Schema v2 already migrated, skipping');
    return;
  }

  // Start migration
  migrationPromise = runMigration(storage, logger).then(() => {
    /* resolve void */
  });

  try {
    await migrationPromise;
  } catch (error) {
    // Reset promise on failure so next call can retry
    migrationPromise = null;
    throw error;
  }
}
