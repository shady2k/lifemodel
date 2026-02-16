/**
 * Calories Plugin Tool
 *
 * Unified tool for tracking food intake with catalog-based matching.
 * Actions: log, list, summary, goal, delete, log_weight
 */

import type { PluginPrimitives, PluginTool, PluginToolContext } from '../../types/plugin.js';
import type {
  FoodItem,
  FoodEntry,
  WeightEntry,
  Portion,
  MealType,
  ActivityLevel,
  LogInput,
  LogInputEntry,
  LogResult,
  LogResultItem,
  ListResult,
  SummaryResult,
  SummaryEntryInfo,
  DailySummary,
  DailySummaryEntry,
  GoalResult,
  DeleteResult,
  DeleteItemResult,
  Unit,
  SearchResult,
  SearchQueryResult,
  StatsResult,
  StatsDay,
  UpdateItemResult,
  ExistingEntryInfo,
  NutrientBasis,
} from './calories-types.js';
import {
  CALORIES_STORAGE_KEYS,
  VALIDATION_BOUNDS,
  generateId,
  validateCalories,
  validateWeight,
  calculateAge,
  calculateBMR,
  calculateTDEE,
  calculatePortionCalories,
  resolveEntryCalories,
} from './calories-types.js';
import { extractCanonicalName, decideMatch, matchCandidates } from './calories-matching.js';
import { ensureMigrated } from './calories-migration.js';
import { DateTime } from 'luxon';

/**
 * Calculate the cutoff hour for food day boundary from sleep/wake patterns.
 * Hours before the cutoff belong to the previous food day.
 */
function calculateCutoffHour(sleepHour: number, wakeHour: number): number {
  if (sleepHour < wakeHour) {
    return Math.floor((sleepHour + wakeHour) / 2);
  }
  const wakeNormalized = wakeHour + 24;
  const midpoint = (sleepHour + wakeNormalized) / 2;
  return Math.floor(midpoint % 24);
}

type GetTimezoneFunc = (recipientId: string) => string;
type GetUserPatternsFunc = (
  recipientId: string
) => { wakeHour?: number; sleepHour?: number } | null;

interface UserModelData {
  weight_kg?: number;
  height_cm?: number;
  birthday?: string;
  gender?: string;
  activity_level?: ActivityLevel;
  calorie_goal?: number;
}

type GetUserModelFunc = (recipientId: string) => Promise<UserModelData | null>;

/**
 * Parse a relative date keyword to YYYY-MM-DD format.
 *
 * Supports:
 * - "today" → current food date (sleep-aware)
 * - "yesterday" → previous day
 * - "tomorrow" → next day
 * - YYYY-MM-DD → passthrough (already formatted)
 */
function parseRelativeDate(
  dateInput: string,
  timezone: string,
  userPatterns: { wakeHour?: number; sleepHour?: number } | null
): string {
  // Check if it's an absolute date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return dateInput;
  }

  const normalized = dateInput.toLowerCase().trim();
  const baseDate = getCurrentFoodDate(timezone, userPatterns);
  const baseDt = DateTime.fromISO(baseDate, { zone: timezone });

  switch (normalized) {
    case 'today':
      return baseDate;
    case 'yesterday':
      return baseDt.minus({ days: 1 }).toFormat('yyyy-MM-dd');
    case 'tomorrow':
      return baseDt.plus({ days: 1 }).toFormat('yyyy-MM-dd');
    default:
      // Unknown keyword — return base date as fallback
      return baseDate;
  }
}

/**
 * Get the current "food day" based on user's sleep patterns.
 */
function getCurrentFoodDate(
  timezone: string,
  userPatterns: { wakeHour?: number; sleepHour?: number } | null
): string {
  const now = DateTime.now().setZone(timezone);
  const hour = now.hour;

  const sleepHour = userPatterns?.sleepHour ?? 23;
  const wakeHour = userPatterns?.wakeHour ?? 7;

  const cutoff = calculateCutoffHour(sleepHour, wakeHour);

  if (hour < cutoff) {
    return now.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  }

  return now.toFormat('yyyy-MM-dd');
}

/**
 * Determine the food date for a specific entry timestamp.
 * Used for after-midnight logging: an entry at 2 AM with timestamp "01:30"
 * should go to yesterday's partition based on user patterns.
 *
 * Falls back to effectiveDate if timestamp is invalid.
 */
function getFoodDateForTimestamp(
  isoTimestamp: string,
  timezone: string,
  userPatterns: { wakeHour?: number; sleepHour?: number } | null,
  effectiveDate: string
): { date: string; warning?: string } {
  // Parse the timestamp in the user's timezone
  const dt = DateTime.fromISO(isoTimestamp, { zone: timezone });

  if (!dt.isValid) {
    return {
      date: effectiveDate,
      warning: `Invalid timestamp "${isoTimestamp}", using current date`,
    };
  }

  // Get the cutoff hour for day boundary
  const sleepHour = userPatterns?.sleepHour ?? 23;
  const wakeHour = userPatterns?.wakeHour ?? 7;
  const cutoff = calculateCutoffHour(sleepHour, wakeHour);

  // Determine if the entry falls before the cutoff (still "yesterday")
  const entryHour = dt.hour;
  let entryDate = dt.toFormat('yyyy-MM-dd');

  if (entryHour < cutoff) {
    // Entry is before cutoff, belongs to previous day
    entryDate = dt.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  }

  return { date: entryDate };
}

/**
 * Default portion when not specified.
 */
function getDefaultPortion(): Portion {
  return { quantity: 1, unit: 'serving' };
}

/**
 * Create the unified calories tool.
 */
export function createCaloriesTool(
  primitives: PluginPrimitives,
  getTimezone: GetTimezoneFunc,
  getUserPatterns: GetUserPatternsFunc,
  getUserModel: GetUserModelFunc
): PluginTool {
  const { storage, logger } = primitives;

  // ============================================================================
  // Storage Helpers
  // ============================================================================

  async function loadItems(recipientId: string): Promise<FoodItem[]> {
    const all = await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items);
    return (all ?? []).filter((item) => item.recipientId === recipientId);
  }

  async function saveItem(item: FoodItem): Promise<void> {
    const all = await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items);
    const items = all ?? [];
    items.push(item);
    await storage.set(CALORIES_STORAGE_KEYS.items, items);
  }

  async function loadFoodEntries(date: string, recipientId: string): Promise<FoodEntry[]> {
    const key = `${CALORIES_STORAGE_KEYS.foodPrefix}${date}`;
    const all = await storage.get<FoodEntry[]>(key);
    return (all ?? []).filter((e) => e.recipientId === recipientId);
  }

  async function saveFoodEntry(date: string, entry: FoodEntry): Promise<void> {
    const key = `${CALORIES_STORAGE_KEYS.foodPrefix}${date}`;
    const all = await storage.get<FoodEntry[]>(key);
    const entries = all ?? [];
    entries.push(entry);
    await storage.set(key, entries);
  }

  async function loadWeights(recipientId: string): Promise<WeightEntry[]> {
    const all = await storage.get<WeightEntry[]>(CALORIES_STORAGE_KEYS.weights);
    return (all ?? []).filter((w) => w.recipientId === recipientId);
  }

  async function saveWeight(entry: WeightEntry): Promise<void> {
    const all = await storage.get<WeightEntry[]>(CALORIES_STORAGE_KEYS.weights);
    const weights = all ?? [];
    weights.push(entry);
    await storage.set(CALORIES_STORAGE_KEYS.weights, weights);
  }

  async function getItemsMap(itemIds: string[]): Promise<Record<string, FoodItem>> {
    const all = await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items);
    const items = all ?? [];
    const map: Record<string, FoodItem> = {};
    for (const id of itemIds) {
      const item = items.find((i) => i.id === id);
      if (item) map[id] = item;
    }
    return map;
  }

  // ============================================================================
  // Validation Helpers
  // ============================================================================

  /**
   * Valid portion units from the schema.
   */
  const VALID_UNITS: Unit[] = [
    'g',
    'kg',
    'ml',
    'l',
    'item',
    'slice',
    'cup',
    'tbsp',
    'tsp',
    'serving',
    'custom',
  ];

  /**
   * Valid meal types from the schema.
   */
  const VALID_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

  /**
   * Parse and validate entries array for log action.
   * Returns normalized entries or an error message.
   *
   * Handles:
   * - Gemini bug: passing JSON strings instead of objects
   * - Strict mode: null values for optional fields
   * - Validation of portion structure, units, etc.
   */
  function parseLogEntries(
    raw: unknown
  ): { success: true; entries: LogInputEntry[] } | { success: false; error: string } {
    // Check entries is an array
    if (!Array.isArray(raw)) {
      return {
        success: false,
        error: 'entries: must be an array of food entry objects',
      };
    }

    // Check non-empty
    if (raw.length === 0) {
      return {
        success: false,
        error: 'entries: array cannot be empty',
      };
    }

    const entries: LogInputEntry[] = [];

    for (let i = 0; i < raw.length; i++) {
      const item: unknown = raw[i];

      // Check each entry is an object (not a string - Gemini bug)
      if (typeof item === 'string') {
        return {
          success: false,
          error: `entries[${String(i)}]: must be an object with 'name' field, got string. Parse the JSON string or pass the object directly.`,
        };
      }

      if (item === null || typeof item !== 'object') {
        return {
          success: false,
          error: `entries[${String(i)}]: must be an object with 'name' field, got ${item === null ? 'null' : typeof item}`,
        };
      }

      const entry = item as Record<string, unknown>;

      // Auto-correct common camelCase / flat-field variants from weak models
      if (('weight' in entry || 'grams' in entry) && !('portion' in entry)) {
        const val = entry['weight'] ?? entry['grams'];
        if (typeof val === 'number') {
          entry['portion'] = { quantity: val, unit: 'g' };
        }
        delete entry['weight'];
        delete entry['grams'];
      }
      if ('calories' in entry && !('calories_estimate' in entry)) {
        entry['calories_estimate'] = entry['calories'];
        delete entry['calories'];
      }
      if ('caloriesPer100g' in entry || 'caloriesper100g' in entry || 'calories_per100g' in entry) {
        entry['calories_per_100g'] =
          entry['caloriesPer100g'] ?? entry['caloriesper100g'] ?? entry['calories_per100g'];
        delete entry['caloriesPer100g'];
        delete entry['caloriesper100g'];
        delete entry['calories_per100g'];
      }
      if ('mealType' in entry && !('meal_type' in entry)) {
        entry['meal_type'] = entry['mealType'];
        delete entry['mealType'];
      }

      // Detect unknown fields — weak models send flat fields instead of nested `portion`
      const KNOWN_FIELDS = new Set([
        'name',
        'portion',
        'calories_estimate',
        'calories_per_100g',
        'meal_type',
        'timestamp',
        'chooseItemId',
      ]);
      const unknownFields = Object.keys(entry).filter((k) => !KNOWN_FIELDS.has(k));
      if (unknownFields.length > 0) {
        // Provide targeted hints for common misfields
        const hints: string[] = [];
        if (unknownFields.includes('weight') || unknownFields.includes('grams')) {
          const val = entry['weight'] ?? entry['grams'];
          hints.push(
            `use portion: { "quantity": ${typeof val === 'number' ? String(val) : '...'}, "unit": "g" } instead of "${unknownFields.includes('weight') ? 'weight' : 'grams'}"`
          );
        }
        if (unknownFields.includes('calories')) {
          hints.push('use "calories_estimate" instead of "calories"');
        }
        if (
          unknownFields.includes('caloriesPer100g') ||
          unknownFields.includes('caloriesper100g')
        ) {
          hints.push('use "calories_per_100g" instead of "caloriesPer100g"');
        }
        const hintSuffix = hints.length > 0 ? `. Hint: ${hints.join('; ')}` : '';
        return {
          success: false,
          error: `entries[${String(i)}]: unknown fields [${unknownFields.join(', ')}]${hintSuffix}`,
        };
      }

      // Validate required 'name' field
      if (typeof entry['name'] !== 'string' || entry['name'].trim() === '') {
        return {
          success: false,
          error: `entries[${String(i)}]: 'name' is required and must be a non-empty string`,
        };
      }

      // Start building normalized entry
      const normalized: LogInputEntry = {
        name: entry['name'].trim(),
      };

      // Validate and normalize 'portion' (optional, can be null)
      const portionRaw = entry['portion'];
      if (portionRaw !== null && portionRaw !== undefined) {
        if (typeof portionRaw !== 'object') {
          return {
            success: false,
            error: `entries[${String(i)}].portion: must be an object with 'quantity' and 'unit', got ${typeof portionRaw}`,
          };
        }

        const portion = portionRaw as Record<string, unknown>;
        const quantity = portion['quantity'];
        const unit = portion['unit'];

        if (typeof quantity !== 'number' || quantity <= 0) {
          return {
            success: false,
            error: `entries[${String(i)}].portion.quantity: must be a positive number`,
          };
        }

        if (typeof unit !== 'string' || !VALID_UNITS.includes(unit as Unit)) {
          return {
            success: false,
            error: `entries[${String(i)}].portion.unit: must be one of [${VALID_UNITS.join(', ')}]`,
          };
        }

        normalized.portion = { quantity, unit: unit as Unit };
      }

      // Validate and normalize 'calories_estimate' (optional, can be null)
      const caloriesRaw = entry['calories_estimate'];
      if (caloriesRaw !== null && caloriesRaw !== undefined) {
        if (typeof caloriesRaw !== 'number' || caloriesRaw < 0) {
          return {
            success: false,
            error: `entries[${String(i)}].calories_estimate: must be a non-negative number`,
          };
        }
        normalized.calories_estimate = caloriesRaw;
      }

      // Validate and normalize 'calories_per_100g' (optional, can be null)
      const per100gRaw = entry['calories_per_100g'];
      if (per100gRaw !== null && per100gRaw !== undefined) {
        if (typeof per100gRaw !== 'number' || !Number.isFinite(per100gRaw) || per100gRaw < 0) {
          return {
            success: false,
            error: `entries[${String(i)}].calories_per_100g: must be a non-negative number`,
          };
        }
        if (per100gRaw > 1000) {
          return {
            success: false,
            error: `entries[${String(i)}].calories_per_100g: max 1000 (pure fat is ~900 kcal/100g)`,
          };
        }
        // calories_per_100g requires a weight-based portion (g or kg)
        const portionUnit = normalized.portion?.unit;
        if (!portionUnit || (portionUnit !== 'g' && portionUnit !== 'kg')) {
          return {
            success: false,
            error: `entries[${String(i)}].calories_per_100g: requires portion with unit 'g' or 'kg'. Add portion: { "quantity": <weight_in_grams>, "unit": "g" }`,
          };
        }
        // Validate computed calories won't exceed max
        const portionQuantity = normalized.portion?.quantity ?? 0;
        const grams = portionUnit === 'kg' ? portionQuantity * 1000 : portionQuantity;
        const computedCalories = Math.round((grams * per100gRaw) / 100);
        if (computedCalories > VALIDATION_BOUNDS.calories.max) {
          return {
            success: false,
            error: `entries[${String(i)}]: computed calories ${String(computedCalories)} exceeds max ${String(VALIDATION_BOUNDS.calories.max)}`,
          };
        }
        normalized.calories_per_100g = per100gRaw;
      }

      // Validate and normalize 'meal_type' (optional, can be null)
      const mealTypeRaw = entry['meal_type'];
      if (mealTypeRaw !== null && mealTypeRaw !== undefined) {
        if (
          typeof mealTypeRaw !== 'string' ||
          !VALID_MEAL_TYPES.includes(mealTypeRaw as MealType)
        ) {
          return {
            success: false,
            error: `entries[${String(i)}].meal_type: must be one of [${VALID_MEAL_TYPES.join(', ')}]`,
          };
        }
        normalized.meal_type = mealTypeRaw as MealType;
      }

      // Validate and normalize 'timestamp' (optional, can be null)
      const timestampRaw = entry['timestamp'];
      if (timestampRaw !== null && timestampRaw !== undefined) {
        if (typeof timestampRaw !== 'string') {
          return {
            success: false,
            error: `entries[${String(i)}].timestamp: must be an ISO timestamp string`,
          };
        }
        normalized.timestamp = timestampRaw;
      }

      // Validate and normalize 'chooseItemId' (optional, can be null)
      const chooseItemIdRaw = entry['chooseItemId'];
      if (chooseItemIdRaw !== null && chooseItemIdRaw !== undefined) {
        if (typeof chooseItemIdRaw !== 'string') {
          return {
            success: false,
            error: `entries[${String(i)}].chooseItemId: must be a string`,
          };
        }
        normalized.chooseItemId = chooseItemIdRaw;
      }

      entries.push(normalized);
    }

    return { success: true, entries };
  }

  // ============================================================================
  // Core Logic
  // ============================================================================

  /**
   * Resolve calories for a log entry.
   * Priority: calories_estimate > calories_per_100g * weight > calculatePortionCalories > 0
   */
  function resolveCalories(entry: LogInputEntry, portion: Portion, item: FoodItem | null): number {
    // 1. Explicit estimate always wins
    if (entry.calories_estimate !== undefined) {
      return entry.calories_estimate;
    }

    // 2. calories_per_100g with weight portion
    if (entry.calories_per_100g !== undefined && (portion.unit === 'g' || portion.unit === 'kg')) {
      const grams = portion.unit === 'kg' ? portion.quantity * 1000 : portion.quantity;
      return Math.round((grams * entry.calories_per_100g) / 100);
    }

    // 3. Calculate from existing item basis
    if (item) {
      return calculatePortionCalories(item, portion);
    }

    // 4. No data — 0
    return 0;
  }

  /**
   * Compute daily summary for a given date with relational reads.
   */
  async function computeDailySummary(recipientId: string, date: string): Promise<DailySummary> {
    const entries = await loadFoodEntries(date, recipientId);

    // Load all items for relational calorie resolution
    const itemIds = [...new Set(entries.map((e) => e.itemId))];
    const itemsMap = await getItemsMap(itemIds);

    // Compute per-entry calories and aggregate
    const byMealType: Partial<Record<MealType, { calories: number; count: number }>> = {};
    let totalCalories = 0;
    const summaryEntries: DailySummaryEntry[] = [];

    for (const entry of entries) {
      const item = itemsMap[entry.itemId];
      const calories = item ? resolveEntryCalories(entry, item) : 0;
      totalCalories += calories;

      if (entry.mealType) {
        const meal = byMealType[entry.mealType] ?? { calories: 0, count: 0 };
        meal.calories += calories;
        meal.count += 1;
        byMealType[entry.mealType] = meal;
      }

      const summaryEntry: DailySummaryEntry = {
        name: item?.canonicalName ?? 'Unknown',
        calories,
        portion: entry.portion,
      };
      if (entry.mealType) summaryEntry.mealType = entry.mealType;
      summaryEntries.push(summaryEntry);
    }

    const userModel = await getUserModel(recipientId);
    const goal = userModel?.calorie_goal ?? null;

    return {
      date,
      totalCalories,
      goal,
      remaining: goal !== null ? goal - totalCalories : null,
      byMealType,
      entries: summaryEntries,
    };
  }

  async function logFood(
    input: LogInput,
    recipientId: string,
    effectiveDate: string,
    timezone: string,
    userPatterns: { wakeHour?: number; sleepHour?: number } | null
  ): Promise<LogResult> {
    const items = await loadItems(recipientId);
    const results: LogResultItem[] = [];
    const now = new Date().toISOString();

    for (const entry of input.entries) {
      // Extract canonical name and portion from input
      const parsed = extractCanonicalName(entry.name);
      const portion = entry.portion ?? parsed.defaultPortion ?? getDefaultPortion();

      // Determine date partition for this entry (after-midnight fix)
      let entryDate = effectiveDate;
      let warning: string | undefined;

      if (entry.timestamp) {
        const dateResult = getFoodDateForTimestamp(
          entry.timestamp,
          timezone,
          userPatterns,
          effectiveDate
        );
        entryDate = dateResult.date;
        warning = dateResult.warning;
      }

      // Load existing entries for this date to check duplicates
      const existingDateEntries = await loadFoodEntries(entryDate, recipientId);

      // If explicit item choice provided, use it
      if (entry.chooseItemId) {
        const chosenItem = items.find((i) => i.id === entry.chooseItemId);
        if (!chosenItem) {
          const ambiguousResult: LogResultItem = {
            status: 'ambiguous',
            originalName: entry.name,
            candidates: [],
            suggestedPortion: portion,
          };
          if (warning) ambiguousResult.warning = warning;
          results.push(ambiguousResult);
          continue;
        }

        const calories = resolveCalories(entry, portion, chosenItem);

        // Check for existing entries with same itemId (duplicate detection)
        const existingWithSameItem = existingDateEntries.filter((e) => e.itemId === chosenItem.id);
        const existingEntries =
          existingWithSameItem.length > 0
            ? existingWithSameItem.map((e) => {
                const info: ExistingEntryInfo = {
                  entryId: e.id,
                  calories: calculatePortionCalories(chosenItem, e.portion),
                  portion: e.portion,
                  timestamp: e.timestamp,
                };
                if (e.mealType) info.mealType = e.mealType;
                return info;
              })
            : undefined;

        const foodEntry: FoodEntry = {
          id: generateId('food'),
          itemId: chosenItem.id,
          portion,
          timestamp: entry.timestamp ?? now,
          recipientId,
        };
        if (entry.meal_type) {
          foodEntry.mealType = entry.meal_type;
        }

        await saveFoodEntry(entryDate, foodEntry);

        const result: LogResultItem = {
          status: 'matched',
          entryId: foodEntry.id,
          itemId: chosenItem.id,
          canonicalName: chosenItem.canonicalName,
          calories,
          portion,
        };
        if (existingEntries) result.existingEntries = existingEntries;
        if (warning) result.warning = warning;
        results.push(result);
        continue;
      }

      // Run matching
      const decision = decideMatch(parsed.canonicalName, items);

      if (decision.status === 'matched') {
        const calories = resolveCalories(entry, portion, decision.item);

        // Check for existing entries with same itemId (duplicate detection)
        const existingWithSameItem = existingDateEntries.filter(
          (e) => e.itemId === decision.item.id
        );
        const existingEntries =
          existingWithSameItem.length > 0
            ? existingWithSameItem.map((e) => {
                const info: ExistingEntryInfo = {
                  entryId: e.id,
                  calories: calculatePortionCalories(decision.item, e.portion),
                  portion: e.portion,
                  timestamp: e.timestamp,
                };
                if (e.mealType) info.mealType = e.mealType;
                return info;
              })
            : undefined;

        const foodEntry: FoodEntry = {
          id: generateId('food'),
          itemId: decision.item.id,
          portion,
          timestamp: entry.timestamp ?? now,
          recipientId,
        };
        if (entry.meal_type) {
          foodEntry.mealType = entry.meal_type;
        }

        await saveFoodEntry(entryDate, foodEntry);

        const result: LogResultItem = {
          status: 'matched',
          entryId: foodEntry.id,
          itemId: decision.item.id,
          canonicalName: decision.item.canonicalName,
          calories,
          portion,
        };
        if (existingEntries) result.existingEntries = existingEntries;
        if (warning) result.warning = warning;
        results.push(result);

        logger.info(
          { entryId: foodEntry.id, itemId: decision.item.id, calories, date: entryDate },
          'Food entry logged (matched)'
        );
      } else if (decision.status === 'ambiguous') {
        const ambiguousResult: LogResultItem = {
          status: 'ambiguous',
          originalName: entry.name,
          candidates: decision.candidates.map((c) => ({
            itemId: c.item.id,
            canonicalName: c.item.canonicalName,
            score: c.score,
          })),
          suggestedPortion: portion,
        };
        if (warning) ambiguousResult.warning = warning;
        results.push(ambiguousResult);

        logger.info(
          { originalName: entry.name, candidateCount: decision.candidates.length },
          'Ambiguous match - user choice needed'
        );
      } else {
        // Create new item
        const calories = resolveCalories(entry, portion, null);
        if (
          calories === 0 &&
          entry.calories_estimate === undefined &&
          entry.calories_per_100g === undefined
        ) {
          // Can't create without calorie data
          const noDataResult: LogResultItem = {
            status: 'ambiguous',
            originalName: entry.name,
            candidates: [],
            suggestedPortion: portion,
          };
          if (warning) noDataResult.warning = warning;
          results.push(noDataResult);
          continue;
        }

        // Prefer calories_per_100g for item basis when available
        const basis =
          entry.calories_per_100g !== undefined
            ? { caloriesPer: entry.calories_per_100g, perQuantity: 100, perUnit: 'g' as Unit }
            : { caloriesPer: calories, perQuantity: portion.quantity, perUnit: portion.unit };

        const newItem: FoodItem = {
          id: generateId('item'),
          canonicalName: parsed.canonicalName,
          measurementKind:
            entry.calories_per_100g !== undefined ? 'weight' : inferMeasurementKind(portion.unit),
          basis,
          createdAt: now,
          updatedAt: now,
          recipientId,
        };

        await saveItem(newItem);
        items.push(newItem); // Add to local cache for subsequent matches

        // No duplicate detection for new items (by definition, no existing entries)
        const foodEntry: FoodEntry = {
          id: generateId('food'),
          itemId: newItem.id,
          portion,
          timestamp: entry.timestamp ?? now,
          recipientId,
        };
        if (entry.meal_type) {
          foodEntry.mealType = entry.meal_type;
        }

        await saveFoodEntry(entryDate, foodEntry);

        const result: LogResultItem = {
          status: 'created',
          entryId: foodEntry.id,
          itemId: newItem.id,
          canonicalName: newItem.canonicalName,
          calories,
          portion,
        };
        if (warning) result.warning = warning;
        results.push(result);

        logger.info(
          {
            entryId: foodEntry.id,
            itemId: newItem.id,
            name: newItem.canonicalName,
            calories,
            date: entryDate,
          },
          'Food entry logged (new item created)'
        );
      }
    }

    // Use the date where entries actually landed (may differ from effectiveDate after midnight)
    const entryDates =
      results
        .filter(
          (r): r is LogResultItem & { status: 'matched' | 'created' } =>
            r.status === 'matched' || r.status === 'created'
        )
        .map((r) => r.entryId).length > 0
        ? [
            ...new Set(
              input.entries.map((e) => {
                if (e.timestamp) {
                  const { date } = getFoodDateForTimestamp(
                    e.timestamp,
                    timezone,
                    userPatterns,
                    effectiveDate
                  );
                  return date;
                }
                return effectiveDate;
              })
            ),
          ]
        : [effectiveDate];

    const summaryDate = entryDates.length === 1 && entryDates[0] ? entryDates[0] : effectiveDate;
    const dailySummary = await computeDailySummary(recipientId, summaryDate);
    return { success: true, results, dailySummary };
  }

  function inferMeasurementKind(unit: Unit): FoodItem['measurementKind'] {
    if (unit === 'g' || unit === 'kg') return 'weight';
    if (unit === 'ml' || unit === 'l') return 'volume';
    if (unit === 'item' || unit === 'slice') return 'count';
    return 'serving';
  }

  async function listFood(
    recipientId: string,
    date: string,
    mealType?: MealType,
    limit?: number
  ): Promise<ListResult> {
    let entries = await loadFoodEntries(date, recipientId);

    if (mealType) {
      entries = entries.filter((e) => e.mealType === mealType);
    }

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (limit) {
      entries = entries.slice(0, limit);
    }

    const itemIds = [...new Set(entries.map((e) => e.itemId))];
    const items = await getItemsMap(itemIds);

    return { success: true, date, entries, items };
  }

  async function getSummary(recipientId: string, date: string): Promise<SummaryResult> {
    const entries = await loadFoodEntries(date, recipientId);

    // Load all items for relational calorie resolution
    const itemIds = [...new Set(entries.map((e) => e.itemId))];
    const itemsMap = await getItemsMap(itemIds);

    // Compute calories using relational reads
    let totalCalories = 0;
    const byMealType: Partial<Record<MealType, number>> = {};

    for (const entry of entries) {
      const item = itemsMap[entry.itemId];
      const calories = item ? resolveEntryCalories(entry, item) : 0;
      totalCalories += calories;

      if (entry.mealType) {
        byMealType[entry.mealType] = (byMealType[entry.mealType] ?? 0) + calories;
      }
    }

    // Build per-entry breakdown with item names
    const summaryEntries: SummaryEntryInfo[] = entries.map((e) => {
      const item = itemsMap[e.itemId];
      const calories = item ? resolveEntryCalories(e, item) : 0;
      const info: SummaryEntryInfo = {
        entryId: e.id,
        name: item?.canonicalName ?? 'Unknown',
        calories,
      };
      if (e.mealType) {
        info.mealType = e.mealType;
      }
      return info;
    });

    const userModel = await getUserModel(recipientId);
    const goal = userModel?.calorie_goal ?? null;

    return {
      success: true,
      date,
      totalCalories,
      goal,
      remaining: goal !== null ? goal - totalCalories : null,
      entryCount: entries.length,
      byMealType,
      entries: summaryEntries,
    };
  }

  async function setGoal(
    recipientId: string,
    dailyTarget?: number,
    calculateFromStats?: boolean
  ): Promise<GoalResult> {
    if (dailyTarget !== undefined) {
      const validation = validateCalories(dailyTarget);
      if (!validation.valid) {
        return { success: false, error: validation.error ?? 'Invalid calorie value' };
      }

      await primitives.services.setUserProperty('calorie_goal', dailyTarget, recipientId);

      return {
        success: true,
        goal: { daily: dailyTarget, source: 'manual' },
      };
    }

    if (calculateFromStats) {
      const userModel = await getUserModel(recipientId);
      const missing: string[] = [];

      if (!userModel?.weight_kg) missing.push('weight_kg');
      if (!userModel?.height_cm) missing.push('height_cm');
      if (!userModel?.birthday) missing.push('birthday');
      if (!userModel?.gender) missing.push('gender');

      // All required fields must be present for TDEE calculation
      if (
        missing.length > 0 ||
        !userModel?.weight_kg ||
        !userModel.height_cm ||
        !userModel.birthday ||
        !userModel.gender
      ) {
        return {
          success: false,
          error: 'Missing user data for TDEE calculation',
          missingStats: missing,
        };
      }

      const age = calculateAge(userModel.birthday);
      const isMale = userModel.gender === 'male';
      const bmr = calculateBMR(userModel.weight_kg, userModel.height_cm, age, isMale);
      const tdee = calculateTDEE(bmr, userModel.activity_level ?? 'moderate');

      return {
        success: true,
        goal: { daily: tdee, source: 'calculated', tdee },
      };
    }

    const userModel = await getUserModel(recipientId);
    if (userModel?.calorie_goal) {
      return {
        success: true,
        goal: { daily: userModel.calorie_goal, source: 'manual' },
      };
    }

    return { success: false, error: 'No calorie goal set' };
  }

  async function logWeight(weight: number, recipientId: string): Promise<DeleteResult> {
    const validation = validateWeight(weight);
    if (!validation.valid) {
      return { success: false, error: validation.error ?? 'Invalid weight value' };
    }

    const entry: WeightEntry = {
      id: generateId('weight'),
      weight,
      measuredAt: new Date().toISOString(),
      recipientId,
    };

    await saveWeight(entry);
    logger.info({ entryId: entry.id, weight }, 'Weight entry logged');

    return { success: true, entryId: entry.id };
  }

  async function deleteEntry(entryId: string, recipientId: string): Promise<DeleteResult> {
    if (entryId.startsWith('food_')) {
      const keys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);

      for (const key of keys) {
        const entries = await storage.get<FoodEntry[]>(key);
        if (!entries) continue;

        const idx = entries.findIndex((e) => e.id === entryId && e.recipientId === recipientId);
        if (idx !== -1) {
          entries.splice(idx, 1);
          await storage.set(key, entries);
          logger.info({ entryId }, 'Food entry deleted');
          return { success: true, entryId };
        }
      }
    }

    if (entryId.startsWith('weight_')) {
      const allWeights = (await storage.get<WeightEntry[]>(CALORIES_STORAGE_KEYS.weights)) ?? [];
      const idx = allWeights.findIndex((w) => w.id === entryId && w.recipientId === recipientId);
      if (idx !== -1) {
        allWeights.splice(idx, 1);
        await storage.set(CALORIES_STORAGE_KEYS.weights, allWeights);
        logger.info({ entryId }, 'Weight entry deleted');
        return { success: true, entryId };
      }
    }

    return { success: false, error: 'Entry not found' };
  }

  // ============================================================================
  // New Actions: Search, Stats, Update Item, Delete Item
  // ============================================================================

  /**
   * Search for food entries by query across all date partitions.
   */
  async function searchFood(
    recipientId: string,
    queries: string[],
    maxResults: number
  ): Promise<SearchResult> {
    const items = await loadItems(recipientId);
    const results: SearchQueryResult[] = [];

    // Get all date partitions
    const dateKeys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);
    const allEntries: { date: string; entry: FoodEntry }[] = [];

    for (const key of dateKeys) {
      const dateMatch = key.replace(CALORIES_STORAGE_KEYS.foodPrefix, '');
      const entries = await storage.get<FoodEntry[]>(key);
      if (entries) {
        for (const entry of entries) {
          if (entry.recipientId === recipientId) {
            allEntries.push({ date: dateMatch, entry });
          }
        }
      }
    }

    // Build items map for calorie resolution
    const itemsMap = await getItemsMap([...new Set(allEntries.map((e) => e.entry.itemId))]);

    for (const query of queries) {
      // Find matching items
      const candidates = matchCandidates(query, items);
      const matchedItems = candidates
        .filter((c) => c.score >= 0.5)
        .map((c) => ({
          itemId: c.item.id,
          canonicalName: c.item.canonicalName,
          score: c.score,
        }));

      const matchedItemIds = new Set(matchedItems.map((m) => m.itemId));

      // Filter entries by matching items
      const matchingEntries = allEntries
        .filter((e) => matchedItemIds.has(e.entry.itemId))
        .map((e) => {
          const item = itemsMap[e.entry.itemId];
          const calories = item ? resolveEntryCalories(e.entry, item) : 0;
          const entry: {
            date: string;
            entryId: string;
            itemId: string;
            name: string;
            calories: number;
            portion: Portion;
            mealType?: MealType;
          } = {
            date: e.date,
            entryId: e.entry.id,
            itemId: e.entry.itemId,
            name: item?.canonicalName ?? 'Unknown',
            calories,
            portion: e.entry.portion,
          };
          if (e.entry.mealType) entry.mealType = e.entry.mealType;
          return entry;
        });

      // Calculate totals before truncation
      const totalEntries = matchingEntries.length;
      const totalCalories = matchingEntries.reduce((sum, e) => sum + e.calories, 0);
      const truncated = matchingEntries.length > maxResults;

      results.push({
        query,
        matchedItems,
        entries: matchingEntries.slice(0, maxResults),
        totalEntries,
        totalCalories,
        truncated,
      });
    }

    return { success: true, results };
  }

  /**
   * Get multi-day statistics with weight trend and streak.
   */
  async function getStats(recipientId: string, days: number): Promise<StatsResult> {
    const tz = getTimezone(recipientId);
    const userPatterns = getUserPatterns(recipientId);
    const today = getCurrentFoodDate(tz, userPatterns);
    const todayDt = DateTime.fromISO(today, { zone: tz });

    const dailyCalories: StatsDay[] = [];
    let totalCalories = 0;
    let streak = 0;

    const userModel = await getUserModel(recipientId);
    const goal = userModel?.calorie_goal ?? null;

    // Pre-load all items once (avoids N+1 reads per day)
    const allItemsRaw = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
    const globalItemsMap: Record<string, FoodItem> = {};
    for (const item of allItemsRaw) {
      globalItemsMap[item.id] = item;
    }

    // Load entries for each day
    for (let i = days - 1; i >= 0; i--) {
      const date = todayDt.minus({ days: i }).toFormat('yyyy-MM-dd');
      const entries = await loadFoodEntries(date, recipientId);

      let dayCalories = 0;
      const byMealType: Partial<Record<MealType, number>> = {};

      for (const entry of entries) {
        const item = globalItemsMap[entry.itemId];
        const calories = item ? resolveEntryCalories(entry, item) : 0;
        dayCalories += calories;

        if (entry.mealType) {
          byMealType[entry.mealType] = (byMealType[entry.mealType] ?? 0) + calories;
        }
      }

      dailyCalories.push({
        date,
        totalCalories: dayCalories,
        goal,
        entryCount: entries.length,
        byMealType,
      });

      totalCalories += dayCalories;

      // Update streak (consecutive days with logging)
      if (entries.length > 0) {
        streak++;
      } else if (i > 0) {
        // Only reset streak if not today (today might be incomplete)
        streak = 0;
      }
    }

    const averageCalories = Math.round(totalCalories / days);

    // Weight trend
    const weights = await loadWeights(recipientId);
    const recentWeights = weights
      .filter((w) => {
        const daysAgo = DateTime.fromISO(w.measuredAt, { zone: tz }).diff(todayDt, 'days').days;
        return Math.abs(daysAgo) <= days;
      })
      .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime());

    let weightChange: number | null = null;
    let direction: StatsResult['weightTrend']['direction'] = 'insufficient_data';

    if (recentWeights.length >= 2) {
      const latestWeight = recentWeights[0];
      const oldestWeight = recentWeights[recentWeights.length - 1];
      if (latestWeight && oldestWeight) {
        const latest = latestWeight.weight;
        const oldest = oldestWeight.weight;
        weightChange = latest - oldest;

        if (Math.abs(weightChange) < 0.5) {
          direction = 'stable';
        } else if (weightChange > 0) {
          direction = 'up';
        } else {
          direction = 'down';
        }
      }
    }

    return {
      success: true,
      period: {
        from: dailyCalories[0]?.date ?? today,
        to: dailyCalories[dailyCalories.length - 1]?.date ?? today,
      },
      dailyCalories,
      averageCalories,
      weightTrend: {
        entries: recentWeights.slice(0, 10), // Limit to 10 most recent
        change: weightChange,
        direction,
      },
      streak,
    };
  }

  /**
   * Update an existing food item.
   */
  async function updateItem(
    recipientId: string,
    itemId?: string,
    name?: string,
    newName?: string,
    newBasis?: NutrientBasis
  ): Promise<UpdateItemResult> {
    const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
    let targetItem: FoodItem | undefined;

    if (itemId) {
      targetItem = allItems.find((i) => i.id === itemId && i.recipientId === recipientId);
    } else if (name) {
      // Fuzzy match by name
      const candidates = matchCandidates(
        name,
        allItems.filter((i) => i.recipientId === recipientId)
      );
      const top = candidates[0];

      if (!top || top.score < 0.5) {
        return { success: false, error: 'No matching item found' };
      }

      if (candidates.length > 1 && candidates[1] && top.score - candidates[1].score < 0.1) {
        // Ambiguous match
        return {
          success: false,
          candidates: candidates.slice(0, 3).map((c) => ({
            itemId: c.item.id,
            canonicalName: c.item.canonicalName,
            score: c.score,
          })),
        };
      }

      targetItem = top.item;
    } else {
      return { success: false, error: 'Either item_id or name is required' };
    }

    if (!targetItem) {
      return { success: false, error: 'Item not found' };
    }

    // Update fields
    const now = new Date().toISOString();
    if (newName) {
      targetItem.canonicalName = newName;
    }
    if (newBasis) {
      targetItem.basis = newBasis;
    }
    targetItem.updatedAt = now;

    // Save updated items
    await storage.set(CALORIES_STORAGE_KEYS.items, allItems);

    // Count affected entries
    const dateKeys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);
    let affectedEntryCount = 0;

    for (const key of dateKeys) {
      const entries = await storage.get<FoodEntry[]>(key);
      if (entries) {
        affectedEntryCount += entries.filter((e) => e.itemId === targetItem.id).length;
      }
    }

    logger.info(
      { itemId: targetItem.id, name: targetItem.canonicalName, affectedEntryCount },
      'Food item updated'
    );

    return {
      success: true,
      item: targetItem,
      affectedEntryCount,
    };
  }

  /**
   * Delete a food item (with referential integrity check).
   */
  async function deleteItem(recipientId: string, itemId: string): Promise<DeleteItemResult> {
    const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
    const targetItem = allItems.find((i) => i.id === itemId && i.recipientId === recipientId);

    if (!targetItem) {
      return { success: false, error: 'Item not found' };
    }

    // Check for references in entries
    const dateKeys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);
    const referencingDates: string[] = [];

    for (const key of dateKeys) {
      const entries = await storage.get<FoodEntry[]>(key);
      if (entries?.some((e) => e.itemId === itemId && e.recipientId === recipientId)) {
        referencingDates.push(key.replace(CALORIES_STORAGE_KEYS.foodPrefix, ''));
      }
    }

    if (referencingDates.length > 0) {
      return {
        success: false,
        error: 'Cannot delete item: it has food entries referencing it',
        referencedBy: {
          count: referencingDates.length,
          dateRange: {
            from: referencingDates.sort()[0] ?? '',
            to: referencingDates.sort()[referencingDates.length - 1] ?? '',
          },
        },
      };
    }

    // No references - safe to delete
    const idx = allItems.findIndex((i) => i.id === itemId);
    if (idx !== -1) {
      allItems.splice(idx, 1);
      await storage.set(CALORIES_STORAGE_KEYS.items, allItems);
    }

    logger.info({ itemId, name: targetItem.canonicalName }, 'Food item deleted');

    return { success: true, itemId };
  }

  // ============================================================================
  // Tool Definition
  // ============================================================================

  /**
   * OpenAI-compatible JSON Schema for the calories tool.
   * Canonical (non-strict) form: only truly required fields in `required`.
   * Optional fields use plain types without nullable union.
   * Strict mode transformation is applied dynamically in vercel-ai-provider.ts
   * for models that support it (OpenAI, Claude).
   */
  const CALORIES_RAW_SCHEMA = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'log',
          'list',
          'summary',
          'goal',
          'log_weight',
          'delete',
          'search',
          'stats',
          'update_item',
          'delete_item',
        ],
        description: 'Action to perform',
      },
      entries: {
        type: 'array',
        description: 'Array of food entries for log action',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Food name (no quantity, e.g., "Американо" not "Американо 200мл")',
            },
            portion: {
              type: 'object',
              description: 'Portion specification: { quantity, unit }',
              properties: {
                quantity: { type: 'number', description: 'Amount (e.g., 200)' },
                unit: {
                  type: 'string',
                  enum: [
                    'g',
                    'kg',
                    'ml',
                    'l',
                    'item',
                    'slice',
                    'cup',
                    'tbsp',
                    'tsp',
                    'serving',
                    'custom',
                  ],
                  description: 'Unit of measurement',
                },
              },
              required: ['quantity', 'unit'],
              additionalProperties: false,
            },
            calories_estimate: {
              type: 'number',
              description: 'Calorie estimate if known (positive number)',
            },
            calories_per_100g: {
              type: 'number',
              description:
                'Caloric density (kcal per 100g). Use with weight portion (g/kg) — tool computes calories automatically.',
            },
            meal_type: {
              type: 'string',
              enum: ['breakfast', 'lunch', 'dinner', 'snack'],
              description: 'Meal type',
            },
            timestamp: {
              type: 'string',
              description: 'ISO timestamp override (optional)',
            },
            chooseItemId: {
              type: 'string',
              description: 'Explicit item ID to resolve ambiguity',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      date: {
        type: 'string',
        description:
          'Date: "today", "yesterday", "tomorrow", or YYYY-MM-DD (default: today based on sleep patterns)',
      },
      meal_type: {
        type: 'string',
        enum: ['breakfast', 'lunch', 'dinner', 'snack'],
        description: 'Filter by meal type for list action',
      },
      limit: {
        type: 'number',
        description: 'Max entries for list (default: 20)',
      },
      daily_target: {
        type: 'number',
        description: 'Calorie goal for goal action',
      },
      calculate_from_stats: {
        type: 'boolean',
        description: 'Calculate TDEE from user data for goal action',
      },
      weight: {
        type: 'number',
        description: 'Weight in kg for log_weight action',
      },
      entry_id: {
        type: 'string',
        description: 'Entry ID for delete action',
      },
      queries: {
        type: 'array',
        description: 'Search queries for search action (max 5)',
        items: { type: 'string' },
      },
      max_results: {
        type: 'number',
        description: 'Max results per query for search action (default: 50)',
      },
      days: {
        type: 'number',
        description: 'Number of days for stats action (default: 7, max: 30)',
      },
      item_id: {
        type: 'string',
        description: 'Item ID for update_item or delete_item action',
      },
      name: {
        type: 'string',
        description: 'Name for fuzzy item matching (update_item action)',
      },
      new_name: {
        type: 'string',
        description: 'New name for update_item action',
      },
      new_basis: {
        type: 'object',
        description: 'New nutritional basis for update_item action',
        properties: {
          caloriesPer: { type: 'number' },
          perQuantity: { type: 'number' },
          perUnit: { type: 'string' },
        },
        required: ['caloriesPer', 'perQuantity', 'perUnit'],
      },
    },
    required: ['action'],
    additionalProperties: false,
  };

  const TOOL_DESCRIPTION = `Food and calorie tracking.

ACTIONS: log, list, summary, goal, log_weight, delete, search, stats, update_item, delete_item

KEY RULES:
- log response includes dailySummary with daily totals — NEVER call summary after log
- name = pure food name, no quantities ("Americano", not "Americano 200ml")
- When user gives kcal/100g, use calories_per_100g (with portion in g/kg) — tool computes total automatically
- If status="ambiguous", resolve via chooseItemId — do NOT create a new item for a different portion
- log supports entries array for multiple items in one call
- date parameter supports: "today", "yesterday", "tomorrow", or YYYY-MM-DD
- If existingEntries present in log response, inform user about potential duplicates
- search: find entries by food name across all dates (max 5 queries)
- stats: multi-day calorie summary with weight trend (default 7 days)
- update_item: modify existing food item (name or nutritional basis)
- delete_item: remove item only if no entries reference it`;

  const caloriesTool: PluginTool = {
    name: 'calories',
    description: TOOL_DESCRIPTION,
    tags: ['food', 'calories', 'weight', 'nutrition', 'diet', 'health', 'tracking'],
    rawParameterSchema: CALORIES_RAW_SCHEMA,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description:
          'Action: log, list, summary, goal, log_weight, delete, search, stats, update_item, delete_item',
        required: true,
        enum: [
          'log',
          'list',
          'summary',
          'goal',
          'log_weight',
          'delete',
          'search',
          'stats',
          'update_item',
          'delete_item',
        ],
      },
      {
        name: 'entries',
        type: 'array',
        description:
          'Array of food entries for log action. Each: {name, portion?: {quantity, unit}, calories_estimate?, calories_per_100g?, meal_type?, chooseItemId?}',
        required: false,
      },
      {
        name: 'date',
        type: 'string',
        description:
          'Date: "today", "yesterday", "tomorrow", or YYYY-MM-DD (default: today based on sleep patterns)',
        required: false,
      },
      {
        name: 'meal_type',
        type: 'string',
        description: 'Filter by meal type for list action',
        required: false,
        enum: ['breakfast', 'lunch', 'dinner', 'snack'],
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Max entries for list (default: 20)',
        required: false,
      },
      {
        name: 'daily_target',
        type: 'number',
        description: 'Calorie goal for goal action',
        required: false,
      },
      {
        name: 'calculate_from_stats',
        type: 'boolean',
        description: 'Calculate TDEE from user data for goal action',
        required: false,
      },
      {
        name: 'weight',
        type: 'number',
        description: 'Weight in kg for log_weight action',
        required: false,
      },
      {
        name: 'entry_id',
        type: 'string',
        description: 'Entry ID for delete action',
        required: false,
      },
      {
        name: 'queries',
        type: 'array',
        description: 'Search queries for search action (max 5)',
        required: false,
      },
      {
        name: 'max_results',
        type: 'number',
        description: 'Max results per query for search action (default: 50)',
        required: false,
      },
      {
        name: 'days',
        type: 'number',
        description: 'Number of days for stats action (default: 7, max: 30)',
        required: false,
      },
      {
        name: 'item_id',
        type: 'string',
        description: 'Item ID for update_item or delete_item action',
        required: false,
      },
      {
        name: 'name',
        type: 'string',
        description: 'Name for fuzzy item matching (update_item action)',
        required: false,
      },
      {
        name: 'new_name',
        type: 'string',
        description: 'New name for update_item action',
        required: false,
      },
      {
        name: 'new_basis',
        type: 'object',
        description:
          'New nutritional basis for update_item action: { caloriesPer, perQuantity, perUnit }',
        required: false,
      },
    ],
    validate: (args) => {
      const a = args as Record<string, unknown>;
      if (!a['action'] || typeof a['action'] !== 'string') {
        return { success: false, error: 'action: required' };
      }
      const validActions = [
        'log',
        'list',
        'summary',
        'goal',
        'log_weight',
        'delete',
        'search',
        'stats',
        'update_item',
        'delete_item',
      ];
      if (!validActions.includes(a['action'])) {
        return { success: false, error: `action: must be one of [${validActions.join(', ')}]` };
      }

      // Action-specific required parameter validation
      // (Global unknown key checks are handled by prevalidateToolArgs middleware)
      if (a['action'] === 'log') {
        const entriesRaw = a['entries'];
        // Allow null (strict mode) but not missing when action is log
        if (entriesRaw === null || entriesRaw === undefined) {
          return { success: false, error: 'entries: required for log action' };
        }
        const parsed = parseLogEntries(entriesRaw);
        if (!parsed.success) {
          return { success: false, error: parsed.error };
        }
        // Store validated entries for execute()
        a['_validatedEntries'] = parsed.entries;
      }

      if (a['action'] === 'delete') {
        // entry_id is required for delete (no aliases — middleware handles fuzzy suggestions)
        const entryId = a['entry_id'];
        if (!entryId || typeof entryId !== 'string') {
          return {
            success: false,
            error: 'entry_id: required for delete action (string, e.g. "food_abc123")',
          };
        }
      }

      if (a['action'] === 'search') {
        const queries = a['queries'];
        if (!Array.isArray(queries) || queries.length === 0) {
          return {
            success: false,
            error: 'queries: required for search action (array of strings)',
          };
        }
        if (queries.length > 5) {
          return { success: false, error: 'queries: max 5 queries allowed' };
        }
        const maxResults = a['max_results'];
        if (
          maxResults !== undefined &&
          (typeof maxResults !== 'number' ||
            !Number.isFinite(maxResults) ||
            maxResults < 1 ||
            maxResults > 200)
        ) {
          return { success: false, error: 'max_results: must be a number between 1 and 200' };
        }
      }

      if (a['action'] === 'stats') {
        const days = a['days'];
        if (days !== undefined && (typeof days !== 'number' || days < 1 || days > 30)) {
          return { success: false, error: 'days: must be a number between 1 and 30' };
        }
      }

      if (a['action'] === 'delete_item') {
        const itemId = a['item_id'];
        if (!itemId || typeof itemId !== 'string') {
          return { success: false, error: 'item_id: required for delete_item action' };
        }
      }

      if (a['action'] === 'update_item') {
        const itemId = a['item_id'];
        const name = a['name'];
        if (!itemId && !name) {
          return {
            success: false,
            error: 'Either item_id or name is required for update_item action',
          };
        }
        const newName = a['new_name'];
        if (newName !== undefined && (typeof newName !== 'string' || newName.trim().length === 0)) {
          return { success: false, error: 'new_name: must be a non-empty string' };
        }
        const newBasis = a['new_basis'];
        if (!newName && !newBasis) {
          return {
            success: false,
            error: 'Either new_name or new_basis is required for update_item action',
          };
        }
        // Validate new_basis structure if provided
        if (newBasis && typeof newBasis === 'object') {
          const basis = newBasis as Record<string, unknown>;
          if (
            typeof basis['caloriesPer'] !== 'number' ||
            !Number.isFinite(basis['caloriesPer']) ||
            typeof basis['perQuantity'] !== 'number' ||
            !Number.isFinite(basis['perQuantity']) ||
            typeof basis['perUnit'] !== 'string'
          ) {
            return {
              success: false,
              error:
                'new_basis: must have caloriesPer (number), perQuantity (number), perUnit (string)',
            };
          }
          if (basis['caloriesPer'] < 0) {
            return { success: false, error: 'new_basis.caloriesPer: must be >= 0' };
          }
          if (basis['perQuantity'] <= 0) {
            return { success: false, error: 'new_basis.perQuantity: must be > 0' };
          }
          if (!VALID_UNITS.includes(basis['perUnit'] as Unit)) {
            return {
              success: false,
              error: `new_basis.perUnit: must be one of [${VALID_UNITS.join(', ')}]`,
            };
          }
        }
      }

      return { success: true, data: a };
    },
    execute: async (
      args,
      context?: PluginToolContext
    ): Promise<
      | LogResult
      | ListResult
      | SummaryResult
      | GoalResult
      | DeleteResult
      | SearchResult
      | StatsResult
      | UpdateItemResult
      | DeleteItemResult
    > => {
      // Run migration on first execute (lazy, not in activate which is sync)
      await ensureMigrated(storage, logger);

      const action = args['action'] as string;
      const recipientId = context?.recipientId;

      if (!recipientId) {
        return { success: false, error: 'No recipient context' } as DeleteResult;
      }

      const timezone = getTimezone(recipientId);
      const userPatterns = getUserPatterns(recipientId);
      const dateArg = args['date'];
      const effectiveDate =
        typeof dateArg === 'string'
          ? parseRelativeDate(dateArg, timezone, userPatterns)
          : getCurrentFoodDate(timezone, userPatterns);

      switch (action) {
        case 'log': {
          // Use pre-validated entries from validate() if available (defense-in-depth)
          let entries = args['_validatedEntries'] as LogInputEntry[] | undefined;

          // Fallback: re-validate if not already done (shouldn't happen in normal flow)
          if (!entries) {
            const entriesRaw = args['entries'];
            if (entriesRaw === null || entriesRaw === undefined) {
              return {
                success: false,
                error: 'entries array required for log action',
              } as DeleteResult;
            }
            const parsed = parseLogEntries(entriesRaw);
            if (!parsed.success) {
              return {
                success: false,
                error: parsed.error,
              } as DeleteResult;
            }
            entries = parsed.entries;
          }

          return logFood({ entries }, recipientId, effectiveDate, timezone, userPatterns);
        }

        case 'list': {
          const limitArg = args['limit'];
          return listFood(
            recipientId,
            effectiveDate,
            args['meal_type'] as MealType | undefined,
            typeof limitArg === 'number' ? limitArg : 20
          );
        }

        case 'summary': {
          return getSummary(recipientId, effectiveDate);
        }

        case 'goal': {
          return setGoal(
            recipientId,
            args['daily_target'] as number | undefined,
            args['calculate_from_stats'] as boolean | undefined
          );
        }

        case 'log_weight': {
          const weight = args['weight'] as number | undefined;
          if (weight === undefined) {
            return {
              success: false,
              error: 'weight required for log_weight action',
            } as DeleteResult;
          }
          return logWeight(weight, recipientId);
        }

        case 'delete': {
          const entryId = args['entry_id'] as string | undefined;
          if (!entryId) {
            return { success: false, error: 'entry_id required for delete action' } as DeleteResult;
          }
          return deleteEntry(entryId, recipientId);
        }

        case 'search': {
          const queries = args['queries'] as string[];
          const maxResults = args['max_results'] as number | undefined;
          return searchFood(recipientId, queries, maxResults ?? 50);
        }

        case 'stats': {
          const days = args['days'] as number | undefined;
          const safeDays = Math.min(Math.max(days ?? 7, 1), 30);
          return getStats(recipientId, safeDays);
        }

        case 'update_item': {
          return updateItem(
            recipientId,
            args['item_id'] as string | undefined,
            args['name'] as string | undefined,
            args['new_name'] as string | undefined,
            args['new_basis'] as NutrientBasis | undefined
          );
        }

        case 'delete_item': {
          const itemId = args['item_id'] as string | undefined;
          if (!itemId) {
            return {
              success: false,
              error: 'item_id required for delete_item action',
            } as DeleteItemResult;
          }
          return deleteItem(recipientId, itemId);
        }

        default:
          return { success: false, error: `Unknown action: ${action}` } as DeleteResult;
      }
    },
  };

  return caloriesTool;
}

export { getCurrentFoodDate };
