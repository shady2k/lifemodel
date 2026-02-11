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
  GoalResult,
  DeleteResult,
  Unit,
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
} from './calories-types.js';
import { extractCanonicalName, decideMatch } from './calories-matching.js';
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

  let cutoff: number;
  if (sleepHour < wakeHour) {
    cutoff = Math.floor((sleepHour + wakeHour) / 2);
  } else {
    const wakeNormalized = wakeHour + 24;
    const midpoint = (sleepHour + wakeNormalized) / 2;
    cutoff = Math.floor(midpoint % 24);
  }

  if (hour < cutoff) {
    return now.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  }

  return now.toFormat('yyyy-MM-dd');
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
            error: `entries[${String(i)}].calories_per_100g: requires portion with unit 'g' or 'kg'`,
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
   * Compute daily summary for a given date.
   */
  async function computeDailySummary(recipientId: string, date: string): Promise<DailySummary> {
    const entries = await loadFoodEntries(date, recipientId);
    const totalCalories = entries.reduce((sum, e) => sum + e.calories, 0);
    const userModel = await getUserModel(recipientId);
    const goal = userModel?.calorie_goal ?? null;
    return {
      totalCalories,
      goal,
      remaining: goal !== null ? goal - totalCalories : null,
    };
  }

  async function logFood(
    input: LogInput,
    recipientId: string,
    effectiveDate: string
  ): Promise<LogResult> {
    const items = await loadItems(recipientId);
    const results: LogResultItem[] = [];
    const now = new Date().toISOString();

    for (const entry of input.entries) {
      // Extract canonical name and portion from input
      const parsed = extractCanonicalName(entry.name);
      const portion = entry.portion ?? parsed.defaultPortion ?? getDefaultPortion();

      // If explicit item choice provided, use it
      if (entry.chooseItemId) {
        const chosenItem = items.find((i) => i.id === entry.chooseItemId);
        if (!chosenItem) {
          results.push({
            status: 'ambiguous',
            originalName: entry.name,
            candidates: [],
            suggestedPortion: portion,
          });
          continue;
        }

        const calories = resolveCalories(entry, portion, chosenItem);
        const foodEntry: FoodEntry = {
          id: generateId('food'),
          itemId: chosenItem.id,
          calories,
          portion,
          timestamp: entry.timestamp ?? now,
          recipientId,
        };
        if (entry.meal_type) {
          foodEntry.mealType = entry.meal_type;
        }

        await saveFoodEntry(effectiveDate, foodEntry);

        results.push({
          status: 'matched',
          entryId: foodEntry.id,
          itemId: chosenItem.id,
          canonicalName: chosenItem.canonicalName,
          calories,
          portion,
        });
        continue;
      }

      // Run matching
      const decision = decideMatch(parsed.canonicalName, items);

      if (decision.status === 'matched') {
        const calories = resolveCalories(entry, portion, decision.item);
        const foodEntry: FoodEntry = {
          id: generateId('food'),
          itemId: decision.item.id,
          calories,
          portion,
          timestamp: entry.timestamp ?? now,
          recipientId,
        };
        if (entry.meal_type) {
          foodEntry.mealType = entry.meal_type;
        }

        await saveFoodEntry(effectiveDate, foodEntry);

        results.push({
          status: 'matched',
          entryId: foodEntry.id,
          itemId: decision.item.id,
          canonicalName: decision.item.canonicalName,
          calories,
          portion,
        });

        logger.info(
          { entryId: foodEntry.id, itemId: decision.item.id, calories },
          'Food entry logged (matched)'
        );
      } else if (decision.status === 'ambiguous') {
        results.push({
          status: 'ambiguous',
          originalName: entry.name,
          candidates: decision.candidates.map((c) => ({
            itemId: c.item.id,
            canonicalName: c.item.canonicalName,
            score: c.score,
          })),
          suggestedPortion: portion,
        });

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
          results.push({
            status: 'ambiguous',
            originalName: entry.name,
            candidates: [],
            suggestedPortion: portion,
          });
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

        const foodEntry: FoodEntry = {
          id: generateId('food'),
          itemId: newItem.id,
          calories,
          portion,
          timestamp: entry.timestamp ?? now,
          recipientId,
        };
        if (entry.meal_type) {
          foodEntry.mealType = entry.meal_type;
        }

        await saveFoodEntry(effectiveDate, foodEntry);

        results.push({
          status: 'created',
          entryId: foodEntry.id,
          itemId: newItem.id,
          canonicalName: newItem.canonicalName,
          calories,
          portion,
        });

        logger.info(
          { entryId: foodEntry.id, itemId: newItem.id, name: newItem.canonicalName, calories },
          'Food entry logged (new item created)'
        );
      }
    }

    const dailySummary = await computeDailySummary(recipientId, effectiveDate);
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
    const totalCalories = entries.reduce((sum, e) => sum + e.calories, 0);

    const byMealType: Partial<Record<MealType, number>> = {};
    for (const entry of entries) {
      if (entry.mealType) {
        byMealType[entry.mealType] = (byMealType[entry.mealType] ?? 0) + entry.calories;
      }
    }

    // Build per-entry breakdown with item names
    const itemIds = [...new Set(entries.map((e) => e.itemId))];
    const itemsMap = await getItemsMap(itemIds);
    const summaryEntries: SummaryEntryInfo[] = entries.map((e) => {
      const info: SummaryEntryInfo = {
        entryId: e.id,
        name: itemsMap[e.itemId]?.canonicalName ?? 'Unknown',
        calories: e.calories,
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
      const weights = await loadWeights(recipientId);
      const idx = weights.findIndex((w) => w.id === entryId);
      if (idx !== -1) {
        weights.splice(idx, 1);
        await storage.set(CALORIES_STORAGE_KEYS.weights, weights);
        logger.info({ entryId }, 'Weight entry deleted');
        return { success: true, entryId };
      }
    }

    return { success: false, error: 'Entry not found' };
  }

  // ============================================================================
  // Tool Definition
  // ============================================================================

  /**
   * OpenAI-compatible JSON Schema for the calories tool.
   * Uses proper nested properties so OpenAI strict mode enforces structure.
   *
   * Key requirements for OpenAI strict mode:
   * - All fields in `required` array (optional fields use type: ["type", "null"])
   * - `additionalProperties: false` on all object types
   */
  const CALORIES_RAW_SCHEMA = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['log', 'list', 'summary', 'goal', 'log_weight', 'delete'],
        description: 'Action to perform',
      },
      entries: {
        type: ['array', 'null'],
        description: 'Array of food entries for log action',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Food name (no quantity, e.g., "Американо" not "Американо 200мл")',
            },
            portion: {
              type: ['object', 'null'],
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
              type: ['number', 'null'],
              description: 'Calorie estimate if known (positive number)',
            },
            calories_per_100g: {
              type: ['number', 'null'],
              description:
                'Caloric density (kcal per 100g). Use with weight portion (g/kg) — tool computes calories automatically.',
            },
            meal_type: {
              type: ['string', 'null'],
              enum: ['breakfast', 'lunch', 'dinner', 'snack', null],
              description: 'Meal type',
            },
            timestamp: {
              type: ['string', 'null'],
              description: 'ISO timestamp override (optional)',
            },
            chooseItemId: {
              type: ['string', 'null'],
              description: 'Explicit item ID to resolve ambiguity',
            },
          },
          required: [
            'name',
            'portion',
            'calories_estimate',
            'calories_per_100g',
            'meal_type',
            'timestamp',
            'chooseItemId',
          ],
          additionalProperties: false,
        },
      },
      date: {
        type: ['string', 'null'],
        description:
          'Date: "today", "yesterday", "tomorrow", or YYYY-MM-DD (default: today based on sleep patterns)',
      },
      meal_type: {
        type: ['string', 'null'],
        enum: ['breakfast', 'lunch', 'dinner', 'snack', null],
        description: 'Filter by meal type for list action',
      },
      limit: {
        type: ['number', 'null'],
        description: 'Max entries for list (default: 20)',
      },
      daily_target: {
        type: ['number', 'null'],
        description: 'Calorie goal for goal action',
      },
      calculate_from_stats: {
        type: ['boolean', 'null'],
        description: 'Calculate TDEE from user data for goal action',
      },
      weight: {
        type: ['number', 'null'],
        description: 'Weight in kg for log_weight action',
      },
      entry_id: {
        type: ['string', 'null'],
        description: 'Entry ID for delete action',
      },
    },
    required: [
      'action',
      'entries',
      'date',
      'meal_type',
      'limit',
      'daily_target',
      'calculate_from_stats',
      'weight',
      'entry_id',
    ],
    additionalProperties: false,
  };

  const TOOL_DESCRIPTION = `Food and calorie tracking.

ACTIONS: log, list, summary, goal, log_weight, delete

KEY RULES:
- log response includes dailySummary with daily totals — NEVER call summary after log
- name = pure food name, no quantities ("Americano", not "Americano 200ml")
- When user gives kcal/100g, use calories_per_100g (with portion in g/kg) — tool computes total automatically
- If status="ambiguous", resolve via chooseItemId — do NOT create a new item for a different portion
- log supports entries array for multiple items in one call
- date parameter supports: "today", "yesterday", "tomorrow", or YYYY-MM-DD`;

  const caloriesTool: PluginTool = {
    name: 'calories',
    description: TOOL_DESCRIPTION,
    tags: ['food', 'calories', 'weight', 'nutrition', 'diet', 'health', 'tracking'],
    rawParameterSchema: CALORIES_RAW_SCHEMA,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: log, list, summary, goal, log_weight, delete',
        required: true,
        enum: ['log', 'list', 'summary', 'goal', 'log_weight', 'delete'],
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
    ],
    validate: (args) => {
      const a = args as Record<string, unknown>;
      if (!a['action'] || typeof a['action'] !== 'string') {
        return { success: false, error: 'action: required' };
      }
      const validActions = ['log', 'list', 'summary', 'goal', 'log_weight', 'delete'];
      if (!validActions.includes(a['action'])) {
        return { success: false, error: `action: must be one of [${validActions.join(', ')}]` };
      }

      // Early validation for log action - catch Gemini string-entries bug here
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

      return { success: true, data: a };
    },
    execute: async (
      args,
      context?: PluginToolContext
    ): Promise<LogResult | ListResult | SummaryResult | GoalResult | DeleteResult> => {
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

          return logFood({ entries }, recipientId, effectiveDate);
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

        default:
          return { success: false, error: `Unknown action: ${action}` } as DeleteResult;
      }
    },
  };

  return caloriesTool;
}

export { getCurrentFoodDate };
