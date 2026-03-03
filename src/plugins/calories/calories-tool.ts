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
  ListEntryInfo,
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
  UpdateEntryResult,
  CorrectEntryResult,
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
import { ensureMigrated, normalizeBasis } from './calories-migration.js';
import { calculateCutoffHour, getCurrentFoodDate } from './calories-date.js';
import { DateTime } from 'luxon';

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
 * Convert a UTC ISO timestamp to a local "HH:mm" string in the given timezone.
 */
function toLocalTime(isoTimestamp: string, timezone: string): string | undefined {
  const dt = DateTime.fromISO(isoTimestamp, { zone: 'utc' }).setZone(timezone);
  if (!dt.isValid) return undefined;
  return dt.toFormat('HH:mm');
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

  async function getItemsMap(dishIds: string[]): Promise<Record<string, FoodItem>> {
    const all = await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items);
    const items = all ?? [];
    const map: Record<string, FoodItem> = {};
    for (const id of dishIds) {
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
        'chooseDishId',
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
          // Suggest the correct unit for common aliases weak models use
          const UNIT_ALIASES: Record<string, string> = {
            piece: 'item',
            pcs: 'item',
            pc: 'item',
            pieces: 'item',
            items: 'item',
            portion: 'serving',
            portions: 'serving',
            servings: 'serving',
            gram: 'g',
            grams: 'g',
            kilogram: 'kg',
            kilograms: 'kg',
            liter: 'l',
            liters: 'l',
            milliliter: 'ml',
            milliliters: 'ml',
          };
          const unitStr = typeof unit === 'string' ? unit : String(unit);
          const suggestion =
            typeof unit === 'string' ? UNIT_ALIASES[unit.toLowerCase()] : undefined;
          const hint = suggestion ? `. Use "${suggestion}" instead of "${unitStr}"` : '';
          return {
            success: false,
            error: `entries[${String(i)}].portion.unit: must be one of [${VALID_UNITS.join(', ')}]${hint}`,
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

      // Validate and normalize 'chooseDishId' (optional, can be null)
      const chooseDishIdRaw = entry['chooseDishId'];
      if (chooseDishIdRaw !== null && chooseDishIdRaw !== undefined) {
        if (typeof chooseDishIdRaw !== 'string') {
          return {
            success: false,
            error: `entries[${String(i)}].chooseDishId: must be a string`,
          };
        }
        normalized.chooseDishId = chooseDishIdRaw;
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
   * Auto-update a dish's basis when the input provides a different calories_per_100g.
   * This ensures that corrections via log propagate to the dish definition.
   */
  async function maybeUpdateDishBasis(entry: LogInputEntry, item: FoodItem): Promise<boolean> {
    if (entry.calories_per_100g === undefined) return false;

    // Check if the dish basis differs from the provided value
    const currentBasis = normalizeBasis(item.basis);
    if (
      currentBasis.perUnit === 'g' &&
      currentBasis.perQuantity === 100 &&
      currentBasis.caloriesPer === entry.calories_per_100g
    ) {
      return false; // Already matches
    }

    // Update the dish basis
    item.basis = { caloriesPer: entry.calories_per_100g, perQuantity: 100, perUnit: 'g' };
    item.updatedAt = new Date().toISOString();

    const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
    const idx = allItems.findIndex((i) => i.id === item.id);
    if (idx !== -1) {
      allItems[idx] = item;
      await storage.set(CALORIES_STORAGE_KEYS.items, allItems);
      logger.info(
        { dishId: item.id, name: item.canonicalName, newBasis: item.basis },
        'Dish basis auto-updated from log input'
      );
    }
    return true;
  }

  /**
   * Compute daily summary for a given date with relational reads.
   */
  async function computeDailySummary(recipientId: string, date: string): Promise<DailySummary> {
    const entries = await loadFoodEntries(date, recipientId);

    // Load all items for relational calorie resolution
    const dishIds = [...new Set(entries.map((e) => e.dishId))];
    const itemsMap = await getItemsMap(dishIds);

    // Compute per-entry calories and aggregate
    const byMealType: Partial<Record<MealType, { calories: number; count: number }>> = {};
    let totalCalories = 0;
    const summaryEntries: DailySummaryEntry[] = [];

    for (const entry of entries) {
      const item = itemsMap[entry.dishId];
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
      // Show kcal/100g for weight-based items
      if (item && (item.basis.perUnit === 'g' || item.basis.perUnit === 'kg')) {
        const normalized = normalizeBasis(item.basis);
        summaryEntry.caloriesPer100g = normalized.caloriesPer;
      }
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

    // Intra-batch deduplication: collapse identical entries within the same request.
    // Entries match when they share the same name + meal_type + portion (quantity & unit).
    const deduped: LogInputEntry[] = [];
    const dedupWarnings = new Map<number, string>(); // index → warning
    for (const entry of input.entries) {
      const existingIdx = deduped.findIndex(
        (d) =>
          d.name === entry.name &&
          (d.meal_type ?? undefined) === (entry.meal_type ?? undefined) &&
          d.portion?.quantity === entry.portion?.quantity &&
          d.portion?.unit === entry.portion?.unit
      );
      if (existingIdx !== -1) {
        // Already have this entry — skip duplicate, record warning on original
        const existing = dedupWarnings.get(existingIdx);
        dedupWarnings.set(
          existingIdx,
          existing
            ? existing
            : `Duplicate "${entry.name}" removed from batch (appeared multiple times in one request)`
        );
        logger.warn(
          { name: entry.name, mealType: entry.meal_type },
          'Intra-batch duplicate removed'
        );
      } else {
        deduped.push(entry);
      }
    }

    for (const [loopIdx, entry] of deduped.entries()) {
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
      if (entry.chooseDishId) {
        const chosenItem = items.find((i) => i.id === entry.chooseDishId);
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

        // Auto-update dish basis if input provides different calories_per_100g
        await maybeUpdateDishBasis(entry, chosenItem);

        const calories = resolveCalories(entry, portion, chosenItem);

        // Check for existing entries with same dishId and same meal type (duplicate detection)
        // Different meal types = intentional (e.g. raisins at breakfast and lunch)
        const entryMealType = entry.meal_type ?? undefined;
        const existingWithSameItem = existingDateEntries.filter(
          (e) => e.dishId === chosenItem.id && e.mealType === entryMealType
        );
        const existingEntries =
          existingWithSameItem.length > 0
            ? existingWithSameItem.map((e) => {
                const info: ExistingEntryInfo = {
                  entryId: e.id,
                  calories: calculatePortionCalories(chosenItem, e.portion),
                  portion: e.portion,
                  timestamp: e.timestamp,
                };
                const elt = toLocalTime(e.timestamp, timezone);
                if (elt) info.localTime = elt;
                if (e.mealType) info.mealType = e.mealType;
                return info;
              })
            : undefined;

        const foodEntry: FoodEntry = {
          id: generateId('food'),
          dishId: chosenItem.id,
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
          dishId: chosenItem.id,
          canonicalName: chosenItem.canonicalName,
          calories,
          portion,
        };
        if (existingEntries) result.existingEntries = existingEntries;
        const dedupWarn = dedupWarnings.get(loopIdx);
        if (warning || dedupWarn) result.warning = [warning, dedupWarn].filter(Boolean).join('; ');
        results.push(result);
        continue;
      }

      // Run matching
      const decision = decideMatch(parsed.canonicalName, items);

      if (decision.status === 'matched') {
        // Auto-update dish basis if input provides different calories_per_100g
        await maybeUpdateDishBasis(entry, decision.item);

        const calories = resolveCalories(entry, portion, decision.item);

        // Check for existing entries with same dishId and same meal type (duplicate detection)
        // Different meal types = intentional (e.g. raisins at breakfast and lunch)
        const matchedMealType = entry.meal_type ?? undefined;
        const existingWithSameItem = existingDateEntries.filter(
          (e) => e.dishId === decision.item.id && e.mealType === matchedMealType
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
                const dlt = toLocalTime(e.timestamp, timezone);
                if (dlt) info.localTime = dlt;
                if (e.mealType) info.mealType = e.mealType;
                return info;
              })
            : undefined;

        const foodEntry: FoodEntry = {
          id: generateId('food'),
          dishId: decision.item.id,
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
          dishId: decision.item.id,
          canonicalName: decision.item.canonicalName,
          calories,
          portion,
        };
        if (existingEntries) result.existingEntries = existingEntries;
        const dedupWarn2 = dedupWarnings.get(loopIdx);
        if (warning || dedupWarn2)
          result.warning = [warning, dedupWarn2].filter(Boolean).join('; ');
        results.push(result);

        logger.info(
          { entryId: foodEntry.id, dishId: decision.item.id, calories, date: entryDate },
          'Food entry logged (matched)'
        );
      } else if (decision.status === 'ambiguous') {
        const ambiguousResult: LogResultItem = {
          status: 'ambiguous',
          originalName: entry.name,
          candidates: decision.candidates.map((c) => ({
            dishId: c.item.id,
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
            status: 'failed',
            originalName: entry.name,
            reason: 'No calorie data. Provide calories_per_100g or calories_estimate.',
            suggestedPortion: portion,
          };
          results.push(noDataResult);
          continue;
        }

        // Build basis and normalize weight-based items to per-100g
        const rawBasis: NutrientBasis =
          entry.calories_per_100g !== undefined
            ? { caloriesPer: entry.calories_per_100g, perQuantity: 100, perUnit: 'g' as Unit }
            : { caloriesPer: calories, perQuantity: portion.quantity, perUnit: portion.unit };
        const basis = normalizeBasis(rawBasis);

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
          dishId: newItem.id,
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
          dishId: newItem.id,
          canonicalName: newItem.canonicalName,
          calories,
          portion,
        };
        const dedupWarn3 = dedupWarnings.get(loopIdx);
        if (warning || dedupWarn3)
          result.warning = [warning, dedupWarn3].filter(Boolean).join('; ');
        results.push(result);

        logger.info(
          {
            entryId: foodEntry.id,
            dishId: newItem.id,
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
              deduped.map((e) => {
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
    const allLogged = results.every((r) => r.status === 'matched' || r.status === 'created');
    return { success: allLogged, results, dailySummary };
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
    timezone: string,
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

    const dishIds = [...new Set(entries.map((e) => e.dishId))];
    const itemsMap = await getItemsMap(dishIds);

    // Resolve calories per entry
    let totalCalories = 0;
    const enrichedEntries: ListEntryInfo[] = entries.map((e) => {
      const item = itemsMap[e.dishId];
      const calories = item ? resolveEntryCalories(e, item) : 0;
      totalCalories += calories;

      const info: ListEntryInfo = {
        entryId: e.id,
        dishId: e.dishId,
        name: item?.canonicalName ?? 'Unknown',
        calories,
        portion: e.portion,
        timestamp: e.timestamp,
      };
      const lt = toLocalTime(e.timestamp, timezone);
      if (lt) info.localTime = lt;
      if (e.mealType) info.mealType = e.mealType;
      if (item && (item.basis.perUnit === 'g' || item.basis.perUnit === 'kg')) {
        const normalized = normalizeBasis(item.basis);
        info.caloriesPer100g = normalized.caloriesPer;
      }
      return info;
    });

    return { success: true, date, totalCalories, entries: enrichedEntries };
  }

  async function getSummary(recipientId: string, date: string): Promise<SummaryResult> {
    const entries = await loadFoodEntries(date, recipientId);

    // Load all items for relational calorie resolution
    const dishIds = [...new Set(entries.map((e) => e.dishId))];
    const itemsMap = await getItemsMap(dishIds);

    // Compute calories using relational reads
    let totalCalories = 0;
    const byMealType: Partial<Record<MealType, number>> = {};

    for (const entry of entries) {
      const item = itemsMap[entry.dishId];
      const calories = item ? resolveEntryCalories(entry, item) : 0;
      totalCalories += calories;

      if (entry.mealType) {
        byMealType[entry.mealType] = (byMealType[entry.mealType] ?? 0) + calories;
      }
    }

    // Build per-entry breakdown with item names
    const summaryEntries: SummaryEntryInfo[] = entries.map((e) => {
      const item = itemsMap[e.dishId];
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
          // Extract date from storage key (format: "food:YYYY-MM-DD")
          const date = key.replace(CALORIES_STORAGE_KEYS.foodPrefix, '');
          const dailySummary = await computeDailySummary(recipientId, date);
          return { success: true, entryId, dailySummary };
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
  // Update Entry (mealType / portion reclassification)
  // ============================================================================

  /**
   * Update one or more food entries in-place (e.g., change mealType for reclassification).
   * Supports bulk: pass multiple entryIds to reclassify several entries at once.
   */
  async function updateEntries(
    recipientId: string,
    entryIds: string[],
    newMealType?: MealType,
    newPortion?: Portion
  ): Promise<UpdateEntryResult> {
    if (entryIds.length === 0) {
      return { success: false, error: 'No entry IDs provided' };
    }

    const remaining = new Set(entryIds);
    const keys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);
    let affectedDate: string | undefined;

    for (const key of keys) {
      if (remaining.size === 0) break;

      const entries = await storage.get<FoodEntry[]>(key);
      if (!entries) continue;

      let modified = false;
      for (const entry of entries) {
        if (!remaining.has(entry.id) || entry.recipientId !== recipientId) continue;

        if (newMealType !== undefined) {
          entry.mealType = newMealType;
        }
        if (newPortion !== undefined) {
          entry.portion = newPortion;
        }

        remaining.delete(entry.id);
        modified = true;
      }

      if (modified) {
        await storage.set(key, entries);
        affectedDate = key.replace(CALORIES_STORAGE_KEYS.foodPrefix, '');
      }
    }

    if (remaining.size === entryIds.length) {
      return { success: false, error: 'No matching entries found' };
    }

    if (remaining.size > 0) {
      logger.warn({ notFound: [...remaining] }, 'Some entry IDs not found during update');
    }

    const firstId = entryIds[0];
    const dailySummary = affectedDate
      ? await computeDailySummary(recipientId, affectedDate)
      : undefined;

    logger.info(
      { entryIds, newMealType, updatedCount: entryIds.length - remaining.size },
      'Food entries updated'
    );

    return {
      success: true,
      entryId: firstId,
      updated: {
        mealType: newMealType,
        portion: newPortion,
      },
      dailySummary,
    };
  }

  // ============================================================================
  // Correct Entry (name-based entry correction with optional basis update)
  // ============================================================================

  /**
   * Find a logged entry by food name (fuzzy) and correct its portion and/or
   * the underlying dish basis in a single call.  Designed for user corrections
   * like "the pizza was 70 g per piece, 300 kcal / 100 g".
   */
  async function correctEntry(
    recipientId: string,
    effectiveDate: string,
    timezone: string,
    name: string,
    mealType?: MealType,
    newPortion?: Portion,
    newBasis?: NutrientBasis
  ): Promise<CorrectEntryResult> {
    // --- 1. Fuzzy-match dish by canonical name ---
    const { canonicalName } = extractCanonicalName(name);
    const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
    const userItems = allItems.filter((i) => i.recipientId === recipientId);
    const candidates = matchCandidates(canonicalName, userItems);
    const top = candidates[0];

    if (!top || top.score < 0.5) {
      return { success: false, error: `No matching dish found for "${name}"` };
    }

    if (candidates.length > 1 && candidates[1] && top.score - candidates[1].score < 0.1) {
      return {
        success: false,
        error: `Ambiguous match for "${name}" — specify dish_id with update_dish + update_entry instead`,
        candidates: candidates.slice(0, 3).map((c) => ({
          dishId: c.item.id,
          canonicalName: c.item.canonicalName,
          score: c.score,
        })),
      };
    }

    const targetItem = top.item;

    // --- 2. Find matching entry on the effective date ---
    const dateKey = `${CALORIES_STORAGE_KEYS.foodPrefix}${effectiveDate}`;
    const entries = (await storage.get<FoodEntry[]>(dateKey)) ?? [];
    const matching = entries.filter(
      (e) =>
        e.dishId === targetItem.id &&
        e.recipientId === recipientId &&
        (mealType === undefined || e.mealType === mealType)
    );

    if (matching.length === 0) {
      return {
        success: false,
        error: `No entry for "${targetItem.canonicalName}" on ${effectiveDate}${mealType ? ` (${mealType})` : ''}`,
      };
    }

    if (matching.length > 1) {
      return {
        success: false,
        ambiguousEntries: matching.map((e) => {
          const info: CorrectEntryResult['ambiguousEntries'] extends (infer T)[] | undefined
            ? T
            : never = {
            entryId: e.id,
            portion: e.portion,
            timestamp: e.timestamp,
          };
          const lt = toLocalTime(e.timestamp, timezone);
          if (lt) info.localTime = lt;
          if (e.mealType) info.mealType = e.mealType;
          return info;
        }),
        error: 'Multiple entries match — specify meal_type or use entry_id with update_entry',
      };
    }

    const entry = matching[0];
    if (!entry) {
      return { success: false, error: 'Entry not found' };
    }
    const updated: NonNullable<CorrectEntryResult['updated']> = {};
    const result: CorrectEntryResult = {
      success: true,
      entryId: entry.id,
      dishId: targetItem.id,
      updated,
    };

    // --- 3. Update entry portion (first — most important for user) ---
    if (newPortion) {
      entry.portion = newPortion;
      await storage.set(dateKey, entries);
      updated.portion = newPortion;
    }

    // --- 4. Update dish basis (global — affects all entries) ---
    if (newBasis) {
      try {
        targetItem.basis = normalizeBasis(newBasis);
        targetItem.updatedAt = new Date().toISOString();
        await storage.set(CALORIES_STORAGE_KEYS.items, allItems);
        updated.basis = targetItem.basis;

        // Count other entries affected by the basis change
        const dateKeys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);
        let affectedCount = 0;
        for (const key of dateKeys) {
          const dateEntries = await storage.get<FoodEntry[]>(key);
          if (dateEntries) {
            affectedCount += dateEntries.filter(
              (e) => e.dishId === targetItem.id && e.recipientId === recipientId
            ).length;
          }
        }
        // Subtract the corrected entry itself
        result.affectedEntryCount = Math.max(0, affectedCount - 1);
      } catch (err) {
        // Entry portion was already saved — report partial success
        if (newPortion) {
          result.partial = true;
          result.error = `Entry portion updated, but basis update failed: ${err instanceof Error ? err.message : String(err)}`;
        } else {
          return {
            success: false,
            error: `Basis update failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    result.dailySummary = await computeDailySummary(recipientId, effectiveDate);

    logger.info(
      {
        entryId: entry.id,
        dishId: targetItem.id,
        newPortion,
        newBasis: newBasis ? targetItem.basis : undefined,
        partial: result.partial,
      },
      'Food entry corrected'
    );

    return result;
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
    const itemsMap = await getItemsMap([...new Set(allEntries.map((e) => e.entry.dishId))]);

    for (const query of queries) {
      // Find matching items
      const candidates = matchCandidates(query, items);
      const matchedItems = candidates
        .filter((c) => c.score >= 0.5)
        .map((c) => ({
          dishId: c.item.id,
          canonicalName: c.item.canonicalName,
          score: c.score,
        }));

      const matchedDishIds = new Set(matchedItems.map((m) => m.dishId));

      // Filter entries by matching items
      const matchingEntries = allEntries
        .filter((e) => matchedDishIds.has(e.entry.dishId))
        .map((e) => {
          const item = itemsMap[e.entry.dishId];
          const calories = item ? resolveEntryCalories(e.entry, item) : 0;
          const entry: {
            date: string;
            entryId: string;
            dishId: string;
            name: string;
            calories: number;
            portion: Portion;
            mealType?: MealType;
          } = {
            date: e.date,
            entryId: e.entry.id,
            dishId: e.entry.dishId,
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
        const item = globalItemsMap[entry.dishId];
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
    effectiveDate: string,
    dishId?: string,
    name?: string,
    newName?: string,
    newBasis?: NutrientBasis
  ): Promise<UpdateItemResult> {
    const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
    let targetItem: FoodItem | undefined;

    if (dishId) {
      targetItem = allItems.find((i) => i.id === dishId && i.recipientId === recipientId);
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
            dishId: c.item.id,
            canonicalName: c.item.canonicalName,
            score: c.score,
          })),
        };
      }

      targetItem = top.item;
    } else {
      return { success: false, error: 'Either dish_id or name is required' };
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
      targetItem.basis = normalizeBasis(newBasis);
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
        affectedEntryCount += entries.filter((e) => e.dishId === targetItem.id).length;
      }
    }

    logger.info(
      { dishId: targetItem.id, name: targetItem.canonicalName, affectedEntryCount },
      'Food item updated'
    );

    const dailySummary = await computeDailySummary(recipientId, effectiveDate);

    return {
      success: true,
      item: targetItem,
      affectedEntryCount,
      dailySummary,
    };
  }

  /**
   * Delete a food item (with referential integrity check).
   */
  async function deleteItem(recipientId: string, dishId: string): Promise<DeleteItemResult> {
    const allItems = (await storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items)) ?? [];
    const targetItem = allItems.find((i) => i.id === dishId && i.recipientId === recipientId);

    if (!targetItem) {
      return { success: false, error: 'Item not found' };
    }

    // Check for references in entries
    const dateKeys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);
    const referencingDates: string[] = [];

    for (const key of dateKeys) {
      const entries = await storage.get<FoodEntry[]>(key);
      if (entries?.some((e) => e.dishId === dishId && e.recipientId === recipientId)) {
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
    const idx = allItems.findIndex((i) => i.id === dishId);
    if (idx !== -1) {
      allItems.splice(idx, 1);
      await storage.set(CALORIES_STORAGE_KEYS.items, allItems);
    }

    logger.info({ dishId, name: targetItem.canonicalName }, 'Food item deleted');

    return { success: true, dishId: dishId };
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
          'unlog',
          'search',
          'stats',
          'update_dish',
          'delete_dish',
          'update_entry',
          'correct',
        ],
        description: 'Action to perform',
      },
      entries: {
        type: 'array',
        description:
          'REQUIRED for log action. Array of food items: [{name, portion: {quantity, unit}, calories_per_100g?, meal_type?}]',
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
              description:
                'Calorie estimate (positive number). Omit for known foods — tool auto-fills from history.',
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
            chooseDishId: {
              type: 'string',
              description: 'Explicit dish ID (starts with "item_") to resolve ambiguity',
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
        description: 'Entry ID for unlog action (from list response entryId)',
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
      dish_id: {
        type: 'string',
        description:
          'Dish ID (starts with "item_") for update_dish or delete_dish action — NOT entry_id',
      },
      name: {
        type: 'string',
        description: 'update_dish / correct: fuzzy dish matching by name',
      },
      new_name: {
        type: 'string',
        description: 'update_dish only: rename dish',
      },
      new_basis: {
        type: 'object',
        description:
          'update_dish / correct: new nutritional basis (updates dish globally — all entries reflect new calorie density)',
        properties: {
          caloriesPer: { type: 'number' },
          perQuantity: { type: 'number' },
          perUnit: { type: 'string' },
        },
        required: ['caloriesPer', 'perQuantity', 'perUnit'],
      },
      entry_ids: {
        type: 'array',
        description:
          'update_entry: array of entry IDs (food_*) to update. Use instead of entry_id for bulk reclassification.',
        items: { type: 'string' },
      },
      new_meal_type: {
        type: 'string',
        enum: ['breakfast', 'lunch', 'dinner', 'snack'],
        description: 'update_entry: new meal type to assign',
      },
      new_portion: {
        type: 'object',
        description: 'correct: new portion to replace existing entry portion',
        properties: {
          quantity: { type: 'number', description: 'Amount (e.g., 280)' },
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
    },
    required: ['action'],
    additionalProperties: false,
  };

  const TOOL_DESCRIPTION = `Food and calorie tracking. Actions: log, list, summary, goal, log_weight, unlog, search, stats, update_dish, delete_dish, update_entry, correct.

Rules:
- ALWAYS set meal_type when user groups by meal. Batch multiple items in entries array (distinct items only).
- log response has dailySummary (totals + byMealType) — NEVER call summary after log. existingEntries = possible duplicate (already saved).
- status="ambiguous" → resolve via chooseDishId. status="failed" → NOT logged, check reason.
- name = pure food ("Americano" not "Americano 200ml"). Use calories_per_100g for kcal/100g input. Cooked kcal for cooked foods.
- date: "today", "yesterday", "tomorrow", or YYYY-MM-DD. dish_id (item_*) for update_dish/delete_dish. entry_id (food_*) for unlog/update_entry.
- update_entry: change meal_type on existing entries. Use entry_ids (array) for bulk. Prefer over unlog+log when only reclassifying.
- correct: fix a previously logged entry by food name. Updates portion (new_portion) and/or calorie basis (new_basis) in one call. No entry_id needed — finds by name+date+meal_type. new_basis updates the dish globally (all past/future entries reflect new calorie density). Use when user corrects weight, quantity, or calorie density.
- LOG FIRST: The tool has its own food database with fuzzy matching. Log food by name+portion WITHOUT calories — if the food was logged before, calories auto-fill from history. Only look up calories externally when status="failed" with reason "No calorie data".`;

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
          'Action: log, list, summary, goal, log_weight, unlog, search, stats, update_dish, delete_dish, update_entry, correct',
        required: true,
        enum: [
          'log',
          'list',
          'summary',
          'goal',
          'log_weight',
          'unlog',
          'search',
          'stats',
          'update_dish',
          'delete_dish',
          'update_entry',
          'correct',
        ],
      },
      {
        name: 'entries',
        type: 'array',
        description:
          'REQUIRED for log action. Array of food items: [{name, portion: {quantity, unit}, calories_per_100g?, meal_type?}]',
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
        description: 'Filter by meal type (list) or disambiguate entries (correct)',
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
        description:
          'Entry ID (food_*) for unlog or update_entry action (from list response entryId field)',
        required: false,
      },
      {
        name: 'entry_ids',
        type: 'array',
        description: 'update_entry: array of entry IDs (food_*) for bulk reclassification',
        required: false,
      },
      {
        name: 'new_meal_type',
        type: 'string',
        description: 'update_entry: new meal type to assign',
        required: false,
        enum: ['breakfast', 'lunch', 'dinner', 'snack'],
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
        name: 'dish_id',
        type: 'string',
        description:
          'Dish ID (starts with "item_") for update_dish or delete_dish action — NOT entry_id',
        required: false,
      },
      {
        name: 'name',
        type: 'string',
        description: 'update_dish / correct: fuzzy dish matching by name',
        required: false,
      },
      {
        name: 'new_name',
        type: 'string',
        description: 'update_dish only: rename dish',
        required: false,
      },
      {
        name: 'new_basis',
        type: 'object',
        description:
          'update_dish / correct: new nutritional basis { caloriesPer, perQuantity, perUnit }',
        required: false,
      },
      {
        name: 'new_portion',
        type: 'object',
        description: 'correct: new portion { quantity, unit } to replace existing entry portion',
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
        'unlog',
        'search',
        'stats',
        'update_dish',
        'delete_dish',
        'update_entry',
        'correct',
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
          return {
            success: false,
            error:
              'entries: required for log action. Example: entries: [{"name": "Pizza", "portion": {"quantity": 280, "unit": "g"}, "calories_per_100g": 300}]',
          };
        }
        const parsed = parseLogEntries(entriesRaw);
        if (!parsed.success) {
          return { success: false, error: parsed.error };
        }
        // Store validated entries for execute()
        a['_validatedEntries'] = parsed.entries;
      }

      if (a['action'] === 'unlog') {
        // entry_id is required for unlog (no aliases — middleware handles fuzzy suggestions)
        const entryId = a['entry_id'];
        if (!entryId || typeof entryId !== 'string') {
          return {
            success: false,
            error:
              'entry_id: required for unlog action (string, e.g. "food_abc123" — get IDs from list response)',
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

      if (a['action'] === 'delete_dish') {
        const dishId = a['dish_id'];
        if (!dishId || typeof dishId !== 'string') {
          return { success: false, error: 'dish_id: required for delete_dish action' };
        }
      }

      if (a['action'] === 'update_dish') {
        const dishId = a['dish_id'];
        const name = a['name'];
        if (!dishId && !name) {
          return {
            success: false,
            error: 'Either dish_id or name is required for update_dish action',
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
            error: 'Either new_name or new_basis is required for update_dish action',
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

      if (a['action'] === 'update_entry') {
        // Accept entry_ids (array) or fall back to single entry_id
        const entryIds = a['entry_ids'];
        const entryId = a['entry_id'];
        if (!entryIds && !entryId) {
          return {
            success: false,
            error:
              'entry_id or entry_ids required for update_entry action (food_* IDs from list response)',
          };
        }
        if (entryIds !== undefined && !Array.isArray(entryIds)) {
          return { success: false, error: 'entry_ids: must be an array of strings' };
        }
        if (Array.isArray(entryIds)) {
          if (entryIds.length === 0 || entryIds.some((id: unknown) => typeof id !== 'string')) {
            return { success: false, error: 'entry_ids: must be a non-empty array of strings' };
          }
        }
        const newMealType = a['new_meal_type'];
        if (
          newMealType !== undefined &&
          newMealType !== null &&
          (typeof newMealType !== 'string' || !VALID_MEAL_TYPES.includes(newMealType as MealType))
        ) {
          return {
            success: false,
            error: `new_meal_type: must be one of [${VALID_MEAL_TYPES.join(', ')}]`,
          };
        }
        if (!newMealType) {
          return {
            success: false,
            error: 'new_meal_type is required for update_entry action',
          };
        }
      }

      if (a['action'] === 'correct') {
        const name = a['name'];
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return { success: false, error: 'name: required for correct action (food name to find)' };
        }

        const newPortion = a['new_portion'] ?? undefined;
        const newBasis = a['new_basis'] ?? undefined;
        if (!newPortion && !newBasis) {
          return {
            success: false,
            error: 'At least one of new_portion or new_basis is required for correct action',
          };
        }

        if (
          newPortion !== undefined &&
          (typeof newPortion !== 'object' || newPortion === null || Array.isArray(newPortion))
        ) {
          return { success: false, error: 'new_portion: must be an object { quantity, unit }' };
        }

        if (
          newBasis !== undefined &&
          (typeof newBasis !== 'object' || newBasis === null || Array.isArray(newBasis))
        ) {
          return {
            success: false,
            error: 'new_basis: must be an object { caloriesPer, perQuantity, perUnit }',
          };
        }

        if (newPortion && typeof newPortion === 'object') {
          const p = newPortion as Record<string, unknown>;
          if (
            typeof p['quantity'] !== 'number' ||
            !Number.isFinite(p['quantity']) ||
            p['quantity'] <= 0
          ) {
            return { success: false, error: 'new_portion.quantity: must be a positive number' };
          }
          if (typeof p['unit'] !== 'string' || !VALID_UNITS.includes(p['unit'] as Unit)) {
            return {
              success: false,
              error: `new_portion.unit: must be one of [${VALID_UNITS.join(', ')}]`,
            };
          }
        }

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
      | UpdateEntryResult
      | CorrectEntryResult
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
            timezone,
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

        case 'unlog': {
          const entryId = args['entry_id'] as string | undefined;
          if (!entryId) {
            return { success: false, error: 'entry_id required for unlog action' } as DeleteResult;
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

        case 'update_dish': {
          return updateItem(
            recipientId,
            effectiveDate,
            args['dish_id'] as string | undefined,
            args['name'] as string | undefined,
            args['new_name'] as string | undefined,
            args['new_basis'] as NutrientBasis | undefined
          );
        }

        case 'delete_dish': {
          const dishId = args['dish_id'] as string | undefined;
          if (!dishId) {
            return {
              success: false,
              error: 'dish_id required for delete_dish action',
            } as DeleteItemResult;
          }
          return deleteItem(recipientId, dishId);
        }

        case 'update_entry': {
          const rawIds = args['entry_ids'] as string[] | undefined;
          const singleId = args['entry_id'] as string | undefined;
          const ids = rawIds ?? (singleId ? [singleId] : []);
          return updateEntries(recipientId, ids, args['new_meal_type'] as MealType | undefined);
        }

        case 'correct': {
          return correctEntry(
            recipientId,
            effectiveDate,
            timezone,
            args['name'] as string,
            args['meal_type'] as MealType | undefined,
            args['new_portion'] as Portion | undefined,
            args['new_basis'] as NutrientBasis | undefined
          );
        }

        default:
          return { success: false, error: `Unknown action: ${action}` } as DeleteResult;
      }
    },
    summarize: (
      args: Record<string, unknown>,
      resultData: Record<string, unknown> | undefined
    ): string => {
      const action = typeof args['action'] === 'string' ? args['action'] : '';

      if (action === 'log' || action === 'quick_log') {
        const rawEntries = args['entries'];
        const entries = Array.isArray(rawEntries)
          ? (rawEntries as Record<string, unknown>[])
          : undefined;
        const foodNames =
          entries
            ?.map((e) => {
              const name = typeof e['name'] === 'string' ? e['name'] : '?';
              return `"${name}"`;
            })
            .join(', ') ?? '?';

        const rawTotal = resultData?.['totalCalories'] ?? resultData?.['total_calories'];
        const calStr =
          typeof rawTotal === 'number' || typeof rawTotal === 'string'
            ? ` → total: ${String(rawTotal)} kcal`
            : '';
        return `calories.${action}: ${foodNames}${calStr}`;
      }

      if (action === 'unlog') {
        const rawId = args['entry_id'];
        const id = typeof rawId === 'string' ? rawId : '?';
        return `calories.unlog: entry ${id}`;
      }

      if (action === 'update_entry') {
        const newMealType = args['new_meal_type'];
        const mt = typeof newMealType === 'string' ? ` → ${newMealType}` : '';
        return `calories.update_entry${mt}`;
      }

      if (action === 'correct') {
        const rawName = args['name'];
        const dishName = typeof rawName === 'string' ? `"${rawName}"` : '?';
        const rawPortion = args['new_portion'] as Record<string, unknown> | undefined;
        const portionStr = rawPortion
          ? ` → ${String(rawPortion['quantity'])}${String(rawPortion['unit'])}`
          : '';
        return `calories.correct: ${dishName}${portionStr}`;
      }

      return `calories.${action || 'unknown'}`;
    },
  };

  return caloriesTool;
}

export { getCurrentFoodDate };
