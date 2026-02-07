/**
 * Calories Plugin Types
 *
 * Clean architecture: FoodItem (catalog) + FoodEntry (log)
 */

import { z } from 'zod';

// ============================================================================
// Core Types
// ============================================================================

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type MeasurementKind = 'weight' | 'volume' | 'count' | 'serving';

export type Unit =
  | 'g'
  | 'kg'
  | 'ml'
  | 'l'
  | 'item'
  | 'slice'
  | 'cup'
  | 'tbsp'
  | 'tsp'
  | 'serving'
  | 'custom';

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

// ============================================================================
// Food Catalog (FoodItem)
// ============================================================================

/**
 * Nutritional basis for a food item.
 * Example: { caloriesPer: 59, perQuantity: 100, perUnit: 'g' } = 59 cal per 100g
 */
export interface NutrientBasis {
  caloriesPer: number;
  perQuantity: number;
  perUnit: Unit;
}

/**
 * Named portion definition for convenience.
 * Example: { name: 'cup', quantity: 240, unit: 'ml' }
 */
export interface PortionDefinition {
  name: string;
  quantity: number;
  unit: Unit;
}

/**
 * Catalog entry for a food item.
 * Stable, reusable across log entries.
 */
export interface FoodItem {
  id: string;
  canonicalName: string;
  aliases?: string[];
  measurementKind: MeasurementKind;
  basis: NutrientBasis;
  portionDefs?: PortionDefinition[];
  metadata?: {
    brand?: string;
    tags?: string[];
  };
  createdAt: string;
  updatedAt: string;
  recipientId: string;
}

// ============================================================================
// Food Log (FoodEntry)
// ============================================================================

/**
 * Portion specification for a log entry.
 */
export interface Portion {
  quantity: number;
  unit: Unit;
}

/**
 * A logged food entry, referencing a FoodItem.
 */
export interface FoodEntry {
  id: string;
  itemId: string;
  calories: number;
  portion: Portion;
  mealType?: MealType;
  timestamp: string;
  recipientId: string;
  note?: string;
}

// ============================================================================
// Weight Tracking
// ============================================================================

export interface WeightEntry {
  id: string;
  weight: number;
  measuredAt: string;
  recipientId: string;
}

// ============================================================================
// Tool API: Log Input/Output
// ============================================================================

/**
 * Single entry in a bulk log request.
 */
export interface LogInputEntry {
  name: string;
  portion?: Portion;
  calories_estimate?: number;
  /** kcal per 100g — used with weight portion to compute calories */
  calories_per_100g?: number;
  meal_type?: MealType;
  timestamp?: string;
  /** Explicit item selection to resolve ambiguity */
  chooseItemId?: string;
}

export interface LogInput {
  entries: LogInputEntry[];
}

export type LogResultItem =
  | {
      status: 'matched';
      entryId: string;
      itemId: string;
      canonicalName: string;
      calories: number;
      portion: Portion;
    }
  | {
      status: 'created';
      entryId: string;
      itemId: string;
      canonicalName: string;
      calories: number;
      portion: Portion;
    }
  | {
      status: 'ambiguous';
      originalName: string;
      candidates: {
        itemId: string;
        canonicalName: string;
        score: number;
      }[];
      suggestedPortion?: Portion;
    };

export interface DailySummary {
  totalCalories: number;
  goal: number | null;
  remaining: number | null;
}

export interface LogResult {
  success: boolean;
  results: LogResultItem[];
  dailySummary?: DailySummary;
}

// ============================================================================
// Tool API: Other Actions
// ============================================================================

export interface ListInput {
  date?: string;
  meal_type?: MealType;
  limit?: number;
}

export interface ListResult {
  success: boolean;
  date: string;
  entries: FoodEntry[];
  items: Record<string, FoodItem>; // itemId → FoodItem for display
}

export interface SummaryEntryInfo {
  entryId: string;
  name: string;
  calories: number;
  mealType?: MealType;
}

export interface SummaryResult {
  success: boolean;
  date: string;
  totalCalories: number;
  goal: number | null;
  remaining: number | null;
  entryCount: number;
  byMealType: Partial<Record<MealType, number>>;
  entries: SummaryEntryInfo[];
}

export interface GoalInput {
  daily_target?: number;
  calculate_from_stats?: boolean;
}

export interface GoalResult {
  success: boolean;
  goal?: {
    daily: number;
    source: 'manual' | 'calculated';
    tdee?: number;
  };
  error?: string;
  missingStats?: string[];
}

export interface DeleteInput {
  entry_id: string;
}

export interface DeleteResult {
  success: boolean;
  entryId?: string;
  error?: string;
}

// ============================================================================
// Matching Types
// ============================================================================

export interface NormalizedNameResult {
  canonicalName: string;
  defaultPortion?: Portion;
  normalizedKey: string;
  removedTokens: string[];
}

// ============================================================================
// Storage Keys
// ============================================================================

export const CALORIES_STORAGE_KEYS = {
  items: 'items',
  foodPrefix: 'food:',
  weights: 'weights',
} as const;

// ============================================================================
// Events
// ============================================================================

export const CALORIES_EVENT_KINDS = {
  WEIGHT_CHECKIN: 'calories:weight_checkin',
} as const;

export const CALORIES_PLUGIN_ID = 'calories';

export const weightCheckinSchema = z.object({
  recipientId: z.string(),
});

// ============================================================================
// Constants
// ============================================================================

export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const VALIDATION_BOUNDS = {
  calories: { min: 0, max: 10000 },
  weight: { min: 20, max: 500 },
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

export function generateId(prefix: 'item' | 'food' | 'weight'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function validateCalories(value: number): { valid: boolean; error?: string } {
  if (!Number.isFinite(value)) {
    return { valid: false, error: 'Calories must be a number' };
  }
  const min = VALIDATION_BOUNDS.calories.min;
  const max = VALIDATION_BOUNDS.calories.max;
  if (value < min || value > max) {
    return {
      valid: false,
      error: `Calories must be between ${String(min)} and ${String(max)}`,
    };
  }
  return { valid: true };
}

export function validateWeight(value: number): { valid: boolean; error?: string } {
  if (!Number.isFinite(value)) {
    return { valid: false, error: 'Weight must be a number' };
  }
  const min = VALIDATION_BOUNDS.weight.min;
  const max = VALIDATION_BOUNDS.weight.max;
  if (value < min || value > max) {
    return {
      valid: false,
      error: `Weight must be between ${String(min)} and ${String(max)}`,
    };
  }
  return { valid: true };
}

export function calculateAge(birthdayIso: string): number {
  const birth = new Date(birthdayIso);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
}

export function calculateBMR(
  weightKg: number,
  heightCm: number,
  ageYears: number,
  isMale: boolean
): number {
  // Mifflin-St Jeor equation
  const sexFactor = isMale ? 5 : -161;
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + sexFactor;
}

export function calculateTDEE(bmr: number, activity: ActivityLevel): number {
  return Math.round(bmr * ACTIVITY_MULTIPLIERS[activity]);
}

/**
 * Calculate calories for a portion based on FoodItem basis.
 */
export function calculatePortionCalories(item: FoodItem, portion: Portion): number {
  const { basis } = item;

  // Same unit - simple ratio
  if (portion.unit === basis.perUnit) {
    return Math.round((portion.quantity / basis.perQuantity) * basis.caloriesPer);
  }

  // Unit conversion (basic)
  const conversions: Record<string, Record<string, number>> = {
    g: { kg: 1000 },
    kg: { g: 0.001 },
    ml: { l: 1000 },
    l: { ml: 0.001 },
  };

  const factor = conversions[basis.perUnit]?.[portion.unit];
  if (factor) {
    const normalizedQuantity = portion.quantity * factor;
    return Math.round((normalizedQuantity / basis.perQuantity) * basis.caloriesPer);
  }

  // Check portion definitions
  if (item.portionDefs) {
    const portionDef = item.portionDefs.find(
      (p) => p.unit === portion.unit || p.name === portion.unit
    );
    if (portionDef?.unit === basis.perUnit) {
      const totalInBasisUnit = portion.quantity * portionDef.quantity;
      return Math.round((totalInBasisUnit / basis.perQuantity) * basis.caloriesPer);
    }
  }

  // Fallback: use LLM estimate if provided, or basis calories
  return basis.caloriesPer;
}
