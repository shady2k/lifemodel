/**
 * Calories Plugin Types
 *
 * Type definitions for food entries, custom dishes, weight tracking,
 * and calorie management.
 */

import { z } from 'zod';

/**
 * Source of calorie information.
 */
export type CalorieSource = 'llm_estimate' | 'user_override' | 'custom_dish';

/**
 * Meal type for food entries.
 */
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/**
 * Activity level for TDEE calculation.
 */
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

/**
 * Activity level multipliers for TDEE calculation.
 */
export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/**
 * Validation bounds for numeric values.
 */
export const VALIDATION_BOUNDS = {
  calories: { min: 0, max: 10000 },
  weight: { min: 20, max: 500 },
  height: { min: 50, max: 300 },
  age: { min: 1, max: 150 },
} as const;

/**
 * A logged food entry.
 */
export interface FoodEntry {
  /** Unique entry ID (food_xxx) */
  id: string;

  /** Description of what was eaten */
  description: string;

  /** Calorie count */
  calories: number;

  /** How calories were determined */
  source: CalorieSource;

  /** Reference to custom dish if used */
  customDishId?: string | undefined;

  /** When the food was eaten (ISO timestamp UTC) */
  eatenAt: string;

  /** When the entry was logged (ISO timestamp UTC) */
  loggedAt: string;

  /** Opaque recipient identifier */
  recipientId: string;

  /** Meal category */
  mealType?: MealType | undefined;
}

/**
 * A user-defined custom dish for quick logging.
 */
export interface CustomDish {
  /** Unique dish ID (dish_xxx) */
  id: string;

  /** Dish name */
  name: string;

  /** Calories per serving */
  caloriesPerServing: number;

  /** Serving size description */
  servingSize?: string | undefined;

  /** Keywords for fuzzy matching */
  keywords?: string[] | undefined;

  /** When the dish was created (ISO timestamp UTC) */
  createdAt: string;

  /** When the dish was last updated (ISO timestamp UTC) */
  updatedAt: string;

  /** Opaque recipient identifier */
  recipientId: string;
}

/**
 * A weight measurement entry.
 */
export interface WeightEntry {
  /** Unique entry ID (weight_xxx) */
  id: string;

  /** Weight in kg */
  weight: number;

  /** When the measurement was taken (ISO timestamp UTC) */
  measuredAt: string;

  /** When the entry was logged (ISO timestamp UTC) */
  loggedAt: string;

  /** Opaque recipient identifier */
  recipientId: string;
}

/**
 * Daily calorie summary.
 */
export interface DailySummary {
  /** Date in YYYY-MM-DD format */
  date: string;

  /** Total calories consumed */
  totalCalories: number;

  /** Calorie goal for the day */
  goal: number | null;

  /** Remaining calories (goal - consumed) */
  remaining: number | null;

  /** Number of entries logged */
  entryCount: number;

  /** Breakdown by meal type */
  byMealType: Partial<Record<MealType, number>>;

  /** When the summary was computed (ISO timestamp UTC) */
  computedAt: string;
}

/**
 * Storage keys used by the calories plugin.
 */
export const CALORIES_STORAGE_KEYS = {
  /** Food entries for a specific date (calories:food:YYYY-MM-DD) */
  foodPrefix: 'food:',

  /** Custom dishes array */
  dishes: 'dishes',

  /** Weight history array */
  weights: 'weights',

  /** Daily summary cache prefix */
  summaryPrefix: 'summary:',
} as const;

/**
 * Event kinds emitted by the calories plugin.
 */
export const CALORIES_EVENT_KINDS = {
  /** Weight check-in reminder */
  WEIGHT_CHECKIN: 'calories:weight_checkin',
} as const;

/**
 * Plugin ID for the calories plugin.
 */
export const CALORIES_PLUGIN_ID = 'calories';

/**
 * Zod schema for weight check-in event validation.
 */
export const weightCheckinSchema = z.object({
  kind: z.literal('plugin_event'),
  eventKind: z.literal(CALORIES_EVENT_KINDS.WEIGHT_CHECKIN),
  pluginId: z.literal(CALORIES_PLUGIN_ID),
  fireId: z.string().optional(),
  payload: z.object({
    recipientId: z.string(),
  }),
});

/**
 * Weight check-in event data.
 */
export type WeightCheckinData = z.infer<typeof weightCheckinSchema>['payload'];

/**
 * Tool result interface for consistent responses.
 */
export interface CaloriesToolResult {
  success: boolean;
  action: string;
  entryId?: string;
  entry?: FoodEntry | WeightEntry;
  entries?: (FoodEntry | WeightEntry)[];
  summary?: DailySummary;
  customDishCreated?: {
    id: string;
    name: string;
    calories: number;
  };
  goal?: {
    daily: number;
    source: 'manual' | 'calculated';
    tdee?: number;
  };
  warning?: string;
  error?: string;
  hint?: string;
  receivedParams?: string[];
  schema?: Record<string, unknown>;
}

/**
 * Generate a unique ID with prefix.
 */
export function generateId(prefix: 'food' | 'dish' | 'weight'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Validate calories value.
 */
export function validateCalories(calories: number): { valid: boolean; error?: string } {
  if (typeof calories !== 'number' || isNaN(calories)) {
    return { valid: false, error: 'Calories must be a number' };
  }
  if (calories < VALIDATION_BOUNDS.calories.min || calories > VALIDATION_BOUNDS.calories.max) {
    return {
      valid: false,
      error: `Calories must be between ${String(VALIDATION_BOUNDS.calories.min)} and ${String(VALIDATION_BOUNDS.calories.max)}`,
    };
  }
  return { valid: true };
}

/**
 * Validate weight value.
 */
export function validateWeight(weight: number): { valid: boolean; error?: string } {
  if (typeof weight !== 'number' || isNaN(weight)) {
    return { valid: false, error: 'Weight must be a number' };
  }
  if (weight < VALIDATION_BOUNDS.weight.min || weight > VALIDATION_BOUNDS.weight.max) {
    return {
      valid: false,
      error: `Weight must be between ${String(VALIDATION_BOUNDS.weight.min)} and ${String(VALIDATION_BOUNDS.weight.max)} kg`,
    };
  }
  return { valid: true };
}

/**
 * Calculate age from birthday.
 */
export function calculateAge(birthday: string | Date): number {
  const birthDate = typeof birthday === 'string' ? new Date(birthday) : birthday;
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

/**
 * Calculate BMR using Mifflin-St Jeor equation.
 *
 * @param weight Weight in kg
 * @param height Height in cm
 * @param age Age in years
 * @param isMale Whether the person is male
 * @returns BMR in kcal/day
 */
export function calculateBMR(weight: number, height: number, age: number, isMale: boolean): number {
  // Mifflin-St Jeor equation:
  // Male: BMR = 10×weight + 6.25×height - 5×age + 5
  // Female: BMR = 10×weight + 6.25×height - 5×age - 161
  const base = 10 * weight + 6.25 * height - 5 * age;
  return isMale ? base + 5 : base - 161;
}

/**
 * Calculate TDEE from BMR and activity level.
 */
export function calculateTDEE(bmr: number, activityLevel: ActivityLevel): number {
  return Math.round(bmr * ACTIVITY_MULTIPLIERS[activityLevel]);
}

/**
 * Calculate daily calorie target based on weight goal.
 *
 * @param tdee Total daily energy expenditure
 * @param currentWeight Current weight in kg
 * @param targetWeight Target weight in kg
 * @param weeksToGoal Optional weeks to reach goal (default: calculated)
 * @returns Daily calorie target
 */
export function calculateCalorieTarget(
  tdee: number,
  currentWeight: number,
  targetWeight: number,
  weeksToGoal?: number
): number {
  const weightDiff = targetWeight - currentWeight;

  if (Math.abs(weightDiff) < 0.5) {
    // At goal weight, maintain
    return tdee;
  }

  // 7700 kcal ≈ 1kg of fat
  // Safe rate: 0.5-1 kg per week = 500-1000 kcal deficit/surplus per day
  const direction = weightDiff > 0 ? 1 : -1;
  const maxWeeklyChange = 1; // kg
  const weeksNeeded = weeksToGoal ?? Math.ceil(Math.abs(weightDiff) / maxWeeklyChange);

  // Calculate weekly change needed
  const weeklyChange = Math.abs(weightDiff) / weeksNeeded;
  const dailyCalorieAdjustment = (weeklyChange * 7700) / 7;

  // Cap at safe limits (500-1000 kcal per day adjustment)
  const safeAdjustment = Math.min(1000, Math.max(500, dailyCalorieAdjustment));

  return Math.round(tdee + direction * safeAdjustment);
}
