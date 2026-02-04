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
  LogResult,
  LogResultItem,
  ListResult,
  SummaryResult,
  GoalResult,
  DeleteResult,
  Unit,
} from './calories-types.js';
import {
  CALORIES_STORAGE_KEYS,
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
  // Core Logic
  // ============================================================================

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

        const calories = entry.calories_estimate ?? calculatePortionCalories(chosenItem, portion);
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
        const calories =
          entry.calories_estimate ?? calculatePortionCalories(decision.item, portion);
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
        const calories = entry.calories_estimate ?? 0;
        if (calories === 0) {
          // Can't create without calorie estimate
          results.push({
            status: 'ambiguous',
            originalName: entry.name,
            candidates: [],
            suggestedPortion: portion,
          });
          continue;
        }

        const newItem: FoodItem = {
          id: generateId('item'),
          canonicalName: parsed.canonicalName,
          measurementKind: inferMeasurementKind(portion.unit),
          basis: {
            caloriesPer: calories,
            perQuantity: portion.quantity,
            perUnit: portion.unit,
          },
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

    return { success: true, results };
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

  const TOOL_DESCRIPTION = `Отслеживание еды и калорий.

ДЕЙСТВИЯ:
- log: Записать еду (поддерживает массив entries для нескольких позиций)
- list: Показать записи за день
- summary: Итоги дня (калории, цель, остаток)
- goal: Установить цель калорий
- log_weight: Записать вес
- delete: Удалить запись

LOG - формат entries:
  entries: [
    { name: "Американо", portion: { quantity: 200, unit: "ml" }, calories_estimate: 5, meal_type: "breakfast" },
    { name: "Йогурт Teos Греческий 2%", portion: { quantity: 140, unit: "g" }, calories_estimate: 94 }
  ]

ПРАВИЛА:
1. В name указывай ТОЛЬКО название без количества: "Американо", не "Американо 200мл"
2. Количество и единицы в portion: { quantity: 200, unit: "ml" }
3. Единицы: g, kg, ml, l, item, slice, cup, serving
4. Если status="ambiguous", выбери нужный вариант через chooseItemId
5. НЕ создавай новый продукт только из-за другой порции

ПРИМЕР:
Пользователь: "запиши американо и йогурт на завтрак"
Ответ: log с entries=[{name:"Американо", portion:{quantity:200,unit:"ml"}, meal_type:"breakfast"}, ...]`;

  const caloriesTool: PluginTool = {
    name: 'calories',
    description: TOOL_DESCRIPTION,
    tags: ['food', 'calories', 'weight', 'nutrition', 'diet', 'health', 'tracking'],
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
          'Array of food entries for log action. Each: {name, portion?: {quantity, unit}, calories_estimate?, meal_type?, chooseItemId?}',
        required: false,
      },
      {
        name: 'date',
        type: 'string',
        description: 'Date YYYY-MM-DD (default: today based on sleep patterns)',
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
        typeof dateArg === 'string' ? dateArg : getCurrentFoodDate(timezone, userPatterns);

      switch (action) {
        case 'log': {
          const entries = args['entries'] as LogInput['entries'] | undefined;
          if (!entries || !Array.isArray(entries) || entries.length === 0) {
            return {
              success: false,
              error: 'entries array required for log action',
            } as DeleteResult;
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
