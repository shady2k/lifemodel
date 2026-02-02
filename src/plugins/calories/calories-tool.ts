/**
 * Calories Plugin Tool
 *
 * Unified tool for tracking food intake, calories, and body weight.
 * Actions: log, list, summary, goal, update, delete
 */

import type { PluginPrimitives, PluginTool, PluginToolContext } from '../../types/plugin.js';
import type {
  FoodEntry,
  CustomDish,
  WeightEntry,
  DailySummary,
  MealType,
  ActivityLevel,
  CaloriesToolResult,
  GoalValidation,
} from './calories-types.js';
import {
  CALORIES_STORAGE_KEYS,
  generateId,
  validateCalories,
  validateWeight,
  calculateAge,
  calculateBMR,
  calculateTDEE,
  calculateCalorieTarget,
} from './calories-types.js';
import { DateTime } from 'luxon';

/**
 * Get the user's timezone by recipientId.
 */
type GetTimezoneFunc = (recipientId: string) => string;

/**
 * Get user patterns (wake/sleep hours) by recipientId.
 */
type GetUserPatternsFunc = (
  recipientId: string
) => { wakeHour?: number; sleepHour?: number } | null;

/**
 * Get user model data for TDEE calculation.
 */
interface UserModelData {
  weight_kg?: number;
  height_cm?: number;
  birthday?: string;
  gender?: string;
  activity_level?: ActivityLevel;
  calorie_goal?: number;
  target_weight_kg?: number;
}

type GetUserModelFunc = (recipientId: string) => Promise<UserModelData | null>;

/**
 * Schema definitions for error responses.
 */
const SCHEMA_LOG_FOOD = {
  action: { type: 'string', required: true, enum: ['log'] },
  entry_type: { type: 'string', required: true, enum: ['food'] },
  description: { type: 'string', required: true, description: 'What was eaten' },
  calories: { type: 'number', required: true, description: 'Calorie estimate (0-10000)' },
  estimate_confidence: {
    type: 'number',
    required: false,
    description: 'Confidence in estimate (0-1). 0.9+=common food, 0.7=uncertain, <0.5=ask user',
  },
  is_user_override: {
    type: 'boolean',
    required: false,
    description: 'True if user provided exact calories',
  },
  meal_type: {
    type: 'string',
    required: false,
    enum: ['breakfast', 'lunch', 'dinner', 'snack'],
  },
  date: { type: 'string', required: false, description: 'YYYY-MM-DD for retroactive logging' },
};

const SCHEMA_LOG_WEIGHT = {
  action: { type: 'string', required: true, enum: ['log'] },
  entry_type: { type: 'string', required: true, enum: ['weight'] },
  weight: { type: 'number', required: true, description: 'Weight in kg (20-500)' },
};

const SCHEMA_LIST = {
  action: { type: 'string', required: true, enum: ['list'] },
  entry_type: { type: 'string', required: true, enum: ['food', 'weight'] },
  date: { type: 'string', required: false, description: 'YYYY-MM-DD for food (default: today)' },
  limit: { type: 'number', required: false, default: 10 },
};

const SCHEMA_SUMMARY = {
  action: { type: 'string', required: true, enum: ['summary'] },
  date: { type: 'string', required: false, description: 'YYYY-MM-DD (default: today)' },
};

const SCHEMA_GOAL = {
  action: { type: 'string', required: true, enum: ['goal'] },
  daily_target: { type: 'number', required: false, description: 'Manual daily calorie goal' },
  calculate_from_stats: {
    type: 'boolean',
    required: false,
    description: 'Calculate TDEE from user stats',
  },
};

const SCHEMA_UPDATE = {
  action: { type: 'string', required: true, enum: ['update'] },
  entry_id: { type: 'string', required: true, description: 'Entry ID to update (food_xxx)' },
  description: { type: 'string', required: false },
  calories: { type: 'number', required: false },
};

const SCHEMA_DELETE = {
  action: { type: 'string', required: true, enum: ['delete'] },
  entry_id: { type: 'string', required: true, description: 'Entry ID to delete' },
};

/**
 * Get the current "food day" based on user's sleep patterns.
 *
 * Uses the midpoint of the sleep period as the day boundary cutoff.
 * Example: sleepHour=2, wakeHour=8 → cutoff=5 AM
 * - 3 AM → before cutoff → yesterday
 * - 6 AM → after cutoff → today
 */
function getCurrentFoodDate(
  timezone: string,
  userPatterns: { wakeHour?: number; sleepHour?: number } | null
): string {
  const now = DateTime.now().setZone(timezone);
  const hour = now.hour;

  // Default: sleep at 23 (11 PM), wake at 7 AM
  const sleepHour = userPatterns?.sleepHour ?? 23;
  const wakeHour = userPatterns?.wakeHour ?? 7;

  // Calculate midpoint of sleep period as day boundary cutoff
  let cutoff: number;
  if (sleepHour < wakeHour) {
    // Sleep doesn't cross midnight (e.g., 2 AM to 8 AM)
    cutoff = Math.floor((sleepHour + wakeHour) / 2);
  } else {
    // Sleep crosses midnight (e.g., 23 to 7)
    // Normalize wake to next day, find midpoint, wrap back
    const wakeNormalized = wakeHour + 24;
    const midpoint = (sleepHour + wakeNormalized) / 2;
    cutoff = Math.floor(midpoint % 24);
  }

  // Between midnight and cutoff = still "yesterday"
  if (hour < cutoff) {
    return now.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  }

  return now.toFormat('yyyy-MM-dd');
}

/**
 * Normalize a description for fuzzy matching.
 */
function normalizeDescription(desc: string): string {
  return desc.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Find a matching custom dish by name or keywords.
 */
function findMatchingDish(
  description: string,
  dishes: CustomDish[],
  recipientId: string
): CustomDish | null {
  const normalized = normalizeDescription(description);

  for (const dish of dishes) {
    if (dish.recipientId !== recipientId) continue;

    // Exact name match
    if (normalizeDescription(dish.name) === normalized) {
      return dish;
    }

    // Keyword match
    if (dish.keywords) {
      for (const keyword of dish.keywords) {
        if (normalized.includes(normalizeDescription(keyword))) {
          return dish;
        }
      }
    }
  }

  return null;
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

  /**
   * Get storage key for food entries on a specific date.
   */
  function getFoodKey(date: string): string {
    return `${CALORIES_STORAGE_KEYS.foodPrefix}${date}`;
  }

  /**
   * Load food entries for a specific date.
   */
  async function loadFoodEntries(date: string): Promise<FoodEntry[]> {
    const stored = await storage.get<FoodEntry[]>(getFoodKey(date));
    return stored ?? [];
  }

  /**
   * Save food entries for a specific date.
   */
  async function saveFoodEntries(date: string, entries: FoodEntry[]): Promise<void> {
    await storage.set(getFoodKey(date), entries);
  }

  /**
   * Load all custom dishes.
   */
  async function loadDishes(): Promise<CustomDish[]> {
    const stored = await storage.get<CustomDish[]>(CALORIES_STORAGE_KEYS.dishes);
    return stored ?? [];
  }

  /**
   * Save custom dishes.
   */
  async function saveDishes(dishes: CustomDish[]): Promise<void> {
    await storage.set(CALORIES_STORAGE_KEYS.dishes, dishes);
  }

  /**
   * Load weight entries.
   */
  async function loadWeights(): Promise<WeightEntry[]> {
    const stored = await storage.get<WeightEntry[]>(CALORIES_STORAGE_KEYS.weights);
    return stored ?? [];
  }

  /**
   * Save weight entries.
   */
  async function saveWeights(weights: WeightEntry[]): Promise<void> {
    await storage.set(CALORIES_STORAGE_KEYS.weights, weights);
  }

  /**
   * Log a food entry.
   */
  async function logFood(
    description: string,
    calories: number,
    recipientId: string,
    options: {
      isUserOverride?: boolean;
      estimateConfidence?: number;
      mealType?: MealType;
      date?: string;
    }
  ): Promise<CaloriesToolResult> {
    // Validate calories
    const caloriesValidation = validateCalories(calories);
    if (!caloriesValidation.valid) {
      return {
        success: false,
        action: 'log',
        error: caloriesValidation.error ?? 'Invalid calories value',
        hint: 'Estimate calories based on typical portions. Examples: oatmeal=150, pizza slice=285, banana=105',
        receivedParams: ['description', 'calories'],
        schema: SCHEMA_LOG_FOOD,
      };
    }

    const timezone = getTimezone(recipientId);
    const userPatterns = getUserPatterns(recipientId);
    const effectiveDate = options.date ?? getCurrentFoodDate(timezone, userPatterns);
    const now = new Date().toISOString();

    // Check for matching custom dish
    const dishes = await loadDishes();
    const matchingDish = findMatchingDish(description, dishes, recipientId);

    let source: FoodEntry['source'] = 'llm_estimate';
    let customDishId: string | undefined;
    let customDishCreated: CaloriesToolResult['customDishCreated'];

    if (matchingDish) {
      source = 'custom_dish';
      customDishId = matchingDish.id;
    } else if (options.isUserOverride) {
      source = 'user_override';

      // Auto-create custom dish when user provides explicit calories
      const newDish: CustomDish = {
        id: generateId('dish'),
        name: description,
        caloriesPerServing: calories,
        createdAt: now,
        updatedAt: now,
        recipientId,
      };
      dishes.push(newDish);
      await saveDishes(dishes);

      customDishCreated = {
        id: newDish.id,
        name: newDish.name,
        calories: newDish.caloriesPerServing,
      };

      logger.info({ dishId: newDish.id, name: newDish.name, calories }, 'Custom dish auto-created');
    }

    const entry: FoodEntry = {
      id: generateId('food'),
      description,
      calories,
      source,
      customDishId,
      eatenAt: now,
      loggedAt: now,
      recipientId,
      mealType: options.mealType,
    };

    const entries = await loadFoodEntries(effectiveDate);
    entries.push(entry);
    await saveFoodEntries(effectiveDate, entries);

    logger.info(
      { entryId: entry.id, description, calories, source, date: effectiveDate },
      'Food entry logged'
    );

    const result: CaloriesToolResult = {
      success: true,
      action: 'log',
      entryId: entry.id,
      entry,
    };

    if (customDishCreated) {
      result.customDishCreated = customDishCreated;
    }

    // Add warning for low confidence estimates
    if (options.estimateConfidence !== undefined && options.estimateConfidence < 0.5) {
      result.warning = `Low confidence estimate (${options.estimateConfidence.toFixed(2)}). Consider asking user to confirm.`;
    }

    return result;
  }

  /**
   * Log a weight entry.
   */
  async function logWeight(weight: number, recipientId: string): Promise<CaloriesToolResult> {
    // Validate weight
    const weightValidation = validateWeight(weight);
    if (!weightValidation.valid) {
      return {
        success: false,
        action: 'log',
        error: weightValidation.error ?? 'Invalid weight value',
        receivedParams: ['weight'],
        schema: SCHEMA_LOG_WEIGHT,
      };
    }

    const now = new Date().toISOString();

    const entry: WeightEntry = {
      id: generateId('weight'),
      weight,
      measuredAt: now,
      loggedAt: now,
      recipientId,
    };

    const weights = await loadWeights();
    weights.push(entry);
    await saveWeights(weights);

    logger.info({ entryId: entry.id, weight }, 'Weight entry logged');

    return {
      success: true,
      action: 'log',
      entryId: entry.id,
      entry,
    };
  }

  /**
   * List food entries for a date.
   */
  async function listFood(
    recipientId: string,
    date: string | undefined,
    limit: number
  ): Promise<CaloriesToolResult> {
    const timezone = getTimezone(recipientId);
    const userPatterns = getUserPatterns(recipientId);
    const effectiveDate = date ?? getCurrentFoodDate(timezone, userPatterns);

    const entries = await loadFoodEntries(effectiveDate);
    const filtered = entries
      .filter((e) => e.recipientId === recipientId)
      .sort((a, b) => new Date(b.eatenAt).getTime() - new Date(a.eatenAt).getTime())
      .slice(0, limit);

    return {
      success: true,
      action: 'list',
      entries: filtered,
    };
  }

  /**
   * List weight entries.
   */
  async function listWeights(recipientId: string, limit: number): Promise<CaloriesToolResult> {
    const weights = await loadWeights();
    const filtered = weights
      .filter((e) => e.recipientId === recipientId)
      .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
      .slice(0, limit);

    return {
      success: true,
      action: 'list',
      entries: filtered,
    };
  }

  /**
   * Get daily calorie summary.
   */
  async function getSummary(
    recipientId: string,
    date: string | undefined
  ): Promise<CaloriesToolResult> {
    const timezone = getTimezone(recipientId);
    const userPatterns = getUserPatterns(recipientId);
    const effectiveDate = date ?? getCurrentFoodDate(timezone, userPatterns);

    const entries = await loadFoodEntries(effectiveDate);
    const filtered = entries.filter((e) => e.recipientId === recipientId);

    const totalCalories = filtered.reduce((sum, e) => sum + e.calories, 0);

    const byMealType: Partial<Record<MealType, number>> = {};
    for (const entry of filtered) {
      if (entry.mealType) {
        byMealType[entry.mealType] = (byMealType[entry.mealType] ?? 0) + entry.calories;
      }
    }

    // Get goal from user model
    const userModel = await getUserModel(recipientId);
    const goal = userModel?.calorie_goal ?? null;

    // Build goal validation info when a goal exists
    let goalValidation: GoalValidation | undefined;
    if (goal !== null) {
      const requiredStats = ['weight_kg', 'height_cm', 'birthday', 'gender'] as const;
      const missingStats = requiredStats.filter((stat) => !userModel?.[stat]);

      if (missingStats.length > 0) {
        goalValidation = {
          missingStats,
          hint: `Goal cannot be validated without user stats. DO NOT call calories goal until ALL missing stats are remembered: ${missingStats.join(', ')}`,
        };
      } else if (
        userModel?.birthday &&
        userModel.gender &&
        userModel.weight_kg &&
        userModel.height_cm
      ) {
        // All stats available - calculate TDEE for comparison
        const age = calculateAge(userModel.birthday);
        const isMale = userModel.gender === 'male';
        const bmr = calculateBMR(userModel.weight_kg, userModel.height_cm, age, isMale);
        const tdee = calculateTDEE(bmr, userModel.activity_level ?? 'moderate');
        const deficit = tdee - goal;

        let hint: string;
        if (deficit > 0) {
          const deficitType = deficit < 500 ? 'moderate' : 'aggressive';
          hint = `Goal ${String(goal)} is ${String(deficit)} below TDEE (${deficitType} deficit for weight loss)`;
        } else if (deficit < 0) {
          hint = `Goal ${String(goal)} is ${String(-deficit)} above TDEE (surplus for muscle gain)`;
        } else {
          hint = `Goal ${String(goal)} matches TDEE (maintenance)`;
        }

        goalValidation = {
          calculatedTDEE: Math.round(tdee),
          hint,
        };
      }
    }

    const summary: DailySummary = {
      date: effectiveDate,
      totalCalories,
      goal,
      remaining: goal !== null ? goal - totalCalories : null,
      entryCount: filtered.length,
      byMealType,
      computedAt: new Date().toISOString(),
      ...(goalValidation && { goalValidation }),
    };

    const result: CaloriesToolResult = {
      success: true,
      action: 'summary',
      summary,
    };

    // Signal that user input is needed before goal validation can work
    if (goalValidation?.missingStats && goalValidation.missingStats.length > 0) {
      result.requiresUserInput = true;
      result.userPrompt = `To validate your calorie goal, I need: ${goalValidation.missingStats.join(', ')}`;
    }

    return result;
  }

  /**
   * Set or calculate calorie goal.
   */
  async function setGoal(
    recipientId: string,
    dailyTarget?: number,
    calculateFromStats?: boolean
  ): Promise<CaloriesToolResult> {
    const userModel = await getUserModel(recipientId);

    if (dailyTarget != null) {
      // Manual target validation
      const validation = validateCalories(dailyTarget);
      if (!validation.valid) {
        return {
          success: false,
          action: 'goal',
          error: validation.error ?? 'Invalid calorie goal value',
          schema: SCHEMA_GOAL,
        };
      }

      // Persist the goal to UserModel
      await primitives.services.setUserProperty('calorie_goal', dailyTarget, recipientId);
      logger.info({ dailyTarget, recipientId }, 'Calorie goal persisted to user model');

      return {
        success: true,
        action: 'goal',
        goal: {
          daily: dailyTarget,
          source: 'manual',
        },
      };
    }

    if (calculateFromStats) {
      // Need user stats for TDEE calculation
      if (
        !userModel?.weight_kg ||
        !userModel.height_cm ||
        !userModel.birthday ||
        !userModel.gender
      ) {
        // Build structured field errors for machine-readability
        const fields: { path: string; expected: string; received: string }[] = [];
        if (!userModel?.weight_kg) {
          fields.push({ path: 'user.weight_kg', expected: 'number', received: 'missing' });
        }
        if (!userModel?.height_cm) {
          fields.push({ path: 'user.height_cm', expected: 'number', received: 'missing' });
        }
        if (!userModel?.birthday) {
          fields.push({
            path: 'user.birthday',
            expected: 'string (YYYY-MM-DD)',
            received: 'missing',
          });
        }
        if (!userModel?.gender) {
          fields.push({ path: 'user.gender', expected: '"male" | "female"', received: 'missing' });
        }

        const missingList = fields.map((f) => f.path.replace('user.', '')).join(', ');

        return {
          success: false,
          action: 'goal',
          error: {
            type: 'missing_data',
            message: 'Cannot calculate TDEE - user profile data is missing',
            fields,
            retryable: false, // KEY: Do NOT retry with same params
          },
          hint: {
            notes: [
              'This data must come from the user, not from tool parameters.',
              'Ask the user to provide their stats, then use core.remember to save them.',
            ],
            example: { action: 'goal', daily_target: 2000 },
          },
          requiresUserInput: true,
          userPrompt: `To calculate your calorie goal, I need: ${missingList}.`,
        };
      }

      const age = calculateAge(userModel.birthday);
      const isMale = userModel.gender === 'male';
      const activityLevel = userModel.activity_level ?? 'moderate';

      const bmr = calculateBMR(userModel.weight_kg, userModel.height_cm, age, isMale);
      const tdee = calculateTDEE(bmr, activityLevel);

      let dailyCalories = tdee;
      if (userModel.target_weight_kg && userModel.target_weight_kg !== userModel.weight_kg) {
        dailyCalories = calculateCalorieTarget(
          tdee,
          userModel.weight_kg,
          userModel.target_weight_kg
        );
      }

      return {
        success: true,
        action: 'goal',
        goal: {
          daily: dailyCalories,
          source: 'calculated',
          tdee,
        },
      };
    }

    // Return current goal
    if (userModel?.calorie_goal) {
      return {
        success: true,
        action: 'goal',
        goal: {
          daily: userModel.calorie_goal,
          source: 'manual',
        },
      };
    }

    return {
      success: false,
      action: 'goal',
      error: 'No calorie goal set',
      hint: 'Use daily_target to set a manual goal, or calculate_from_stats to compute from user data.',
      schema: SCHEMA_GOAL,
    };
  }

  /**
   * Update a food entry.
   */
  async function updateEntry(
    entryId: string,
    recipientId: string,
    updates: { description?: string; calories?: number }
  ): Promise<CaloriesToolResult> {
    // Find the entry across all dates
    const keys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);

    for (const key of keys) {
      const entries = await storage.get<FoodEntry[]>(key);
      if (!entries) continue;

      const entryIndex = entries.findIndex((e) => e.id === entryId);
      if (entryIndex === -1) continue;

      const entry = entries[entryIndex];
      if (!entry) continue; // TypeScript guard - entryIndex is valid but TS doesn't know

      // Verify ownership
      if (entry.recipientId !== recipientId) {
        logger.warn(
          { entryId, requestedRecipientId: recipientId, actualRecipientId: entry.recipientId },
          'Attempted to update entry from different recipient'
        );
        return {
          success: false,
          action: 'update',
          error: 'Entry not found',
        };
      }

      // Validate new calories if provided
      if (updates.calories !== undefined) {
        const validation = validateCalories(updates.calories);
        if (!validation.valid) {
          return {
            success: false,
            action: 'update',
            error: validation.error ?? 'Invalid calories value',
            schema: SCHEMA_UPDATE,
          };
        }
        entry.calories = updates.calories;
      }

      if (updates.description !== undefined) {
        entry.description = updates.description;
      }

      entries[entryIndex] = entry;
      await storage.set(key, entries);

      logger.info({ entryId, updates }, 'Food entry updated');

      return {
        success: true,
        action: 'update',
        entryId,
        entry,
      };
    }

    return {
      success: false,
      action: 'update',
      error: 'Entry not found',
    };
  }

  /**
   * Delete an entry (food or weight).
   */
  async function deleteEntry(entryId: string, recipientId: string): Promise<CaloriesToolResult> {
    // Check if it's a food entry
    if (entryId.startsWith('food_')) {
      const keys = await storage.keys(`${CALORIES_STORAGE_KEYS.foodPrefix}*`);

      for (const key of keys) {
        const entries = await storage.get<FoodEntry[]>(key);
        if (!entries) continue;

        const entryIndex = entries.findIndex((e) => e.id === entryId);
        if (entryIndex === -1) continue;

        const entry = entries[entryIndex];
        if (!entry) continue; // TypeScript guard

        // Verify ownership
        if (entry.recipientId !== recipientId) {
          logger.warn(
            { entryId, requestedRecipientId: recipientId, actualRecipientId: entry.recipientId },
            'Attempted to delete entry from different recipient'
          );
          return {
            success: false,
            action: 'delete',
            error: 'Entry not found',
          };
        }

        entries.splice(entryIndex, 1);
        await storage.set(key, entries);

        logger.info({ entryId }, 'Food entry deleted');

        return {
          success: true,
          action: 'delete',
          entryId,
        };
      }
    }

    // Check if it's a weight entry
    if (entryId.startsWith('weight_')) {
      const weights = await loadWeights();
      const entryIndex = weights.findIndex((e) => e.id === entryId);

      const entry = weights[entryIndex];
      if (entryIndex !== -1 && entry) {
        // Verify ownership
        if (entry.recipientId !== recipientId) {
          logger.warn(
            { entryId, requestedRecipientId: recipientId, actualRecipientId: entry.recipientId },
            'Attempted to delete weight entry from different recipient'
          );
          return {
            success: false,
            action: 'delete',
            error: 'Entry not found',
          };
        }

        weights.splice(entryIndex, 1);
        await saveWeights(weights);

        logger.info({ entryId }, 'Weight entry deleted');

        return {
          success: true,
          action: 'delete',
          entryId,
        };
      }
    }

    return {
      success: false,
      action: 'delete',
      error: 'Entry not found',
    };
  }

  const caloriesTool: PluginTool = {
    name: 'calories',
    description: `Track food intake, calories, and body weight.

Actions: log, list, summary, goal, update, delete

LOG: entry_type="food"|"weight". For food: description, calories (you estimate), estimate_confidence (0.9=certain, <0.5=ask user). If user provides calories: is_user_override=true.

GOAL: daily_target=N for manual, OR calculate_from_stats=true for auto (returns what to ask user if stats missing).

SUMMARY/LIST: View intake for date.`,
    tags: ['food', 'calories', 'weight', 'nutrition', 'diet', 'health', 'tracking'],
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "log", "list", "summary", "goal", "update", or "delete"',
        required: true,
        enum: ['log', 'list', 'summary', 'goal', 'update', 'delete'],
      },
      {
        name: 'entry_type',
        type: 'string',
        description: 'Type of entry: "food" or "weight" (for log and list actions)',
        required: false,
        enum: ['food', 'weight'],
      },
      {
        name: 'description',
        type: 'string',
        description: 'Food description (for log food action)',
        required: false,
      },
      {
        name: 'calories',
        type: 'number',
        description: 'Calorie estimate 0-10000 (for log food action)',
        required: false,
      },
      {
        name: 'weight',
        type: 'number',
        description: 'Weight in kg 20-500 (for log weight action)',
        required: false,
      },
      {
        name: 'estimate_confidence',
        type: 'number',
        description:
          'Confidence in calorie estimate (0.0-1.0). 0.9+=common food, 0.7=uncertain, <0.5=ask user',
        required: false,
      },
      {
        name: 'is_user_override',
        type: 'boolean',
        description: 'True if user explicitly provided calorie count',
        required: false,
      },
      {
        name: 'meal_type',
        type: 'string',
        description: 'Meal category: breakfast, lunch, dinner, snack',
        required: false,
        enum: ['breakfast', 'lunch', 'dinner', 'snack'],
      },
      {
        name: 'date',
        type: 'string',
        description: 'Date in YYYY-MM-DD format (for retroactive logging or list)',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Max entries to return (for list, default: 10)',
        required: false,
      },
      {
        name: 'entry_id',
        type: 'string',
        description: 'Entry ID (for update/delete actions)',
        required: false,
      },
      {
        name: 'daily_target',
        type: 'number',
        description: 'Manual daily calorie goal (for goal action)',
        required: false,
      },
      {
        name: 'calculate_from_stats',
        type: 'boolean',
        description: 'Calculate TDEE from user stats (for goal action)',
        required: false,
      },
    ],
    validate: (args) => {
      const a = args as Record<string, unknown>;
      if (!a['action'] || typeof a['action'] !== 'string') {
        return { success: false, error: 'action: required' };
      }
      const validActions = ['log', 'list', 'summary', 'goal', 'update', 'delete'];
      if (!validActions.includes(a['action'])) {
        return { success: false, error: `action: must be one of [${validActions.join(', ')}]` };
      }
      return { success: true, data: a };
    },
    execute: async (args, context?: PluginToolContext): Promise<CaloriesToolResult> => {
      const action = args['action'];
      if (typeof action !== 'string') {
        return {
          success: false,
          action: 'unknown',
          error: 'Missing or invalid action parameter',
          receivedParams: Object.keys(args),
          schema: {
            availableActions: {
              log_food: SCHEMA_LOG_FOOD,
              log_weight: SCHEMA_LOG_WEIGHT,
              list: SCHEMA_LIST,
              summary: SCHEMA_SUMMARY,
              goal: SCHEMA_GOAL,
              update: SCHEMA_UPDATE,
              delete: SCHEMA_DELETE,
            },
          },
        };
      }

      const recipientId = context?.recipientId;
      if (!recipientId) {
        return {
          success: false,
          action,
          error: 'No recipient context available',
        };
      }

      switch (action) {
        case 'log': {
          const entryType = args['entry_type'] as 'food' | 'weight' | undefined;

          if (entryType === 'weight') {
            const weight = args['weight'];
            if (typeof weight !== 'number') {
              return {
                success: false,
                action: 'log',
                error: 'Missing required parameter: weight',
                receivedParams: Object.keys(args),
                schema: SCHEMA_LOG_WEIGHT,
              };
            }
            return logWeight(weight, recipientId);
          }

          // Default to food
          const description = args['description'] as string | undefined;
          const calories = args['calories'] as number | undefined;

          if (!description || calories === undefined) {
            return {
              success: false,
              action: 'log',
              error: 'Missing required parameters for food logging: description, calories',
              hint: 'Estimate calories based on typical portions. Examples: oatmeal=150, pizza slice=285, banana=105',
              receivedParams: Object.keys(args),
              schema: SCHEMA_LOG_FOOD,
            };
          }

          const options: {
            isUserOverride?: boolean;
            estimateConfidence?: number;
            mealType?: MealType;
            date?: string;
          } = {};

          if (args['is_user_override'] !== undefined) {
            options.isUserOverride = args['is_user_override'] as boolean;
          }
          if (args['estimate_confidence'] !== undefined) {
            options.estimateConfidence = args['estimate_confidence'] as number;
          }
          if (args['meal_type'] !== undefined) {
            options.mealType = args['meal_type'] as MealType;
          }
          if (args['date'] !== undefined) {
            options.date = args['date'] as string;
          }

          return logFood(description, calories, recipientId, options);
        }

        case 'list': {
          const entryType = args['entry_type'] as 'food' | 'weight' | undefined;
          const limit = typeof args['limit'] === 'number' ? args['limit'] : 10;

          if (entryType === 'weight') {
            return listWeights(recipientId, limit);
          }

          return listFood(recipientId, args['date'] as string | undefined, limit);
        }

        case 'summary': {
          return getSummary(recipientId, args['date'] as string | undefined);
        }

        case 'goal': {
          return setGoal(
            recipientId,
            args['daily_target'] as number | undefined,
            args['calculate_from_stats'] as boolean | undefined
          );
        }

        case 'update': {
          const entryId = args['entry_id'];
          if (typeof entryId !== 'string' || !entryId) {
            return {
              success: false,
              action: 'update',
              error: 'Missing required parameter: entry_id',
              receivedParams: Object.keys(args),
              schema: SCHEMA_UPDATE,
            };
          }

          const updates: { description?: string; calories?: number } = {};
          if (args['description'] !== undefined) {
            updates.description = args['description'] as string;
          }
          if (args['calories'] !== undefined) {
            updates.calories = args['calories'] as number;
          }

          return updateEntry(entryId, recipientId, updates);
        }

        case 'delete': {
          const entryId = args['entry_id'];
          if (typeof entryId !== 'string' || !entryId) {
            return {
              success: false,
              action: 'delete',
              error: 'Missing required parameter: entry_id',
              receivedParams: Object.keys(args),
              schema: SCHEMA_DELETE,
            };
          }

          return deleteEntry(entryId, recipientId);
        }

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "log", "list", "summary", "goal", "update", or "delete".`,
            receivedParams: Object.keys(args),
            schema: {
              availableActions: {
                log_food: SCHEMA_LOG_FOOD,
                log_weight: SCHEMA_LOG_WEIGHT,
                list: SCHEMA_LIST,
                summary: SCHEMA_SUMMARY,
                goal: SCHEMA_GOAL,
                update: SCHEMA_UPDATE,
                delete: SCHEMA_DELETE,
              },
            },
          };
      }
    },
  };

  return caloriesTool;
}

/**
 * Export helper functions for neuron access.
 */
export { getCurrentFoodDate };
