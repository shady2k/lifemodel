/**
 * Calories Anomaly Neuron
 *
 * Learns the user's eating pattern over 7-14 days and only signals when
 * today is significantly below their own historical norm. At most one
 * signal per day. Normal days = complete silence.
 *
 * Algorithm:
 * 1. Baseline: Compute cumulative calories-by-hour (wake-relative) from past 14 days
 * 2. Check timing: Only check after 60% of waking hours elapsed
 * 3. Floor guard: Skip if expectedByNow < 200 kcal (protects OMAD/late eaters)
 * 4. Anomaly score: max(calorieDeviation, mealDeviation)
 * 5. Threshold: Fire if anomalyScore > 0.4 (40% below expected pace)
 * 6. Once per day: After emitting, no more signals that day
 */

import type { Signal, SignalSource, SignalType, SignalMetrics } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import type { StoragePrimitive } from '../../types/plugin.js';
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { Priority } from '../../types/priority.js';
import { DateTime } from 'luxon';
import type { FoodEntry, FoodItem } from './calories-types.js';
import { CALORIES_STORAGE_KEYS, resolveEntryCalories } from './calories-types.js';

const NEURON_STATE_KEY = 'calories_anomaly_neuron_state';
const BASELINE_CACHE_KEY = 'calories_anomaly_baseline';

/** Minimum days of history needed before anomaly detection activates */
const MIN_BASELINE_DAYS = 3;
/** Maximum days to look back for baseline */
const MAX_BASELINE_DAYS = 14;
/** Anomaly threshold - fire if > 40% below expected */
const ANOMALY_THRESHOLD = 0.4;
/** Minimum expected calories before checking (floor guard) */
const MIN_EXPECTED_CALORIES = 200;
/** Waking hours progress threshold before checking (60%) */
const MIN_DAY_PROGRESS = 0.6;

/** Persisted state for once-per-day emission */
interface PersistedAnomalyState {
  lastEmittedDate: string | null; // YYYY-MM-DD
}

/** Cached baseline for a specific date */
interface CachedBaseline {
  date: string; // The date this baseline was computed for
  hour: number; // Wake-relative hour when computed
  data: Record<number, HourlyBaseline>;
}

/** Baseline statistics per wake-relative hour */
interface HourlyBaseline {
  /** Cumulative calories by this hour */
  calories: {
    median: number;
    q1: number; // 25th percentile
    q3: number; // 75th percentile
  };
  /** Cumulative meal count by this hour */
  meals: {
    median: number;
    q1: number;
    q3: number;
  };
  /** Number of days used for baseline */
  baselineDays: number;
}

/**
 * Configuration for calories anomaly neuron.
 */
export interface CaloriesAnomalyNeuronConfig {
  /** Anomaly threshold (0.4 = 40% below expected) */
  anomalyThreshold: number;

  /** Minimum days of history before activating */
  minBaselineDays: number;

  /** Maximum days to look back for baseline */
  maxBaselineDays: number;

  /** Minimum expected calories before checking (floor guard) */
  minExpectedCalories: number;

  /** Waking hours progress threshold before checking */
  minDayProgress: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_CALORIES_ANOMALY_CONFIG: CaloriesAnomalyNeuronConfig = {
  anomalyThreshold: ANOMALY_THRESHOLD,
  minBaselineDays: MIN_BASELINE_DAYS,
  maxBaselineDays: MAX_BASELINE_DAYS,
  minExpectedCalories: MIN_EXPECTED_CALORIES,
  minDayProgress: MIN_DAY_PROGRESS,
};

/** User patterns interface for wake-relative calculations */
interface UserPatterns {
  wakeHour?: number;
  sleepHour?: number;
}

type GetTimezoneFunc = () => string;
type GetUserPatternsFunc = () => UserPatterns | null;
type GetCalorieGoalFunc = () => Promise<number | null>;

/**
 * Compute median of sorted array.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Compute percentile (0-100) of sorted array.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] as number;
  return (
    (sorted[lower] as number) +
    ((sorted[upper] as number) - (sorted[lower] as number)) * (index - lower)
  );
}

/**
 * Get wake-relative hour (hours since wake time).
 * Falls back to wall clock hour if no wake pattern available.
 */
function getWakeRelativeHour(wallClockHour: number, patterns: UserPatterns | null): number {
  if (!patterns?.wakeHour) {
    return wallClockHour;
  }
  const wakeHour = patterns.wakeHour;
  let hoursSinceWake = wallClockHour - wakeHour;
  if (hoursSinceWake < 0) {
    hoursSinceWake += 24; // Handle overnight
  }
  return hoursSinceWake;
}

/**
 * Get total waking hours based on user patterns.
 * Defaults to 16 hours if no pattern available.
 */
function getWakingHours(patterns: UserPatterns | null): number {
  if (!patterns?.wakeHour || !patterns.sleepHour) {
    return 16;
  }
  let duration = patterns.sleepHour - patterns.wakeHour;
  if (duration <= 0) {
    duration += 24;
  }
  return duration;
}

/**
 * Get the current local hour in user's timezone.
 */
function getLocalHour(timezone: string): number {
  return DateTime.now().setZone(timezone).hour;
}

/**
 * Extract hour from timestamp in specified timezone.
 */
function getHourFromTimestamp(timestamp: string, timezone: string): number {
  return DateTime.fromISO(timestamp).setZone(timezone).hour;
}

/**
 * Count distinct mealTypes in entries.
 * Fallback: entries without mealType count as one generic meal per 2-hour window.
 */
function countMeals(entries: FoodEntry[], timezone: string): number {
  const mealTypes = new Set<string>();
  const fallbackWindows = new Set<number>();

  for (const entry of entries) {
    if (entry.mealType) {
      mealTypes.add(entry.mealType);
    } else {
      // Fallback: bucket by 2-hour window
      const hour = getHourFromTimestamp(entry.timestamp, timezone);
      const window = Math.floor(hour / 2);
      fallbackWindows.add(window);
    }
  }

  return mealTypes.size + fallbackWindows.size;
}

/**
 * Calories Anomaly Neuron implementation.
 *
 * Uses anomaly detection instead of change detection to avoid
 * nagging on normal days.
 */
export class CaloriesAnomalyNeuron extends BaseNeuron {
  readonly id = 'calories-anomaly';
  readonly signalType: SignalType = 'plugin_event';
  readonly source: SignalSource = 'plugin.calories';
  readonly description = 'Signals when calorie intake is anomalously low vs user pattern';

  private readonly config: CaloriesAnomalyNeuronConfig;
  private readonly storage: StoragePrimitive;
  private readonly recipientId: string;
  private readonly getTimezone: GetTimezoneFunc;
  private readonly getUserPatterns: GetUserPatternsFunc;
  private readonly getCalorieGoal: GetCalorieGoalFunc;

  // Async guards
  private computeInFlight = false;
  private pendingSignal: Signal | undefined;

  constructor(
    logger: Logger,
    config: Partial<CaloriesAnomalyNeuronConfig>,
    storage: StoragePrimitive,
    recipientId: string,
    getTimezone: GetTimezoneFunc,
    getUserPatterns: GetUserPatternsFunc,
    getCalorieGoal: GetCalorieGoalFunc
  ) {
    super(logger);
    this.config = { ...DEFAULT_CALORIES_ANOMALY_CONFIG, ...config };
    this.storage = storage;
    this.recipientId = recipientId;
    this.getTimezone = getTimezone;
    this.getUserPatterns = getUserPatterns;
    this.getCalorieGoal = getCalorieGoal;
  }

  /**
   * Check state and emit signal if anomaly detected.
   *
   * Uses computeInFlight guard to prevent duplicate async computations,
   * and consume-once pattern for pendingSignal.
   */
  check(_state: AgentState, alertness: number, correlationId: string): Signal | undefined {
    // Skip during sleep hours (Energy Conservation principle)
    if (alertness < 0.3) {
      return undefined;
    }

    // Consume-once: return and clear any pending signal
    const signal = this.pendingSignal;
    if (signal) {
      this.pendingSignal = undefined;
      return signal;
    }

    // Skip if computation already in flight
    if (this.computeInFlight) {
      return undefined;
    }

    // Trigger async anomaly computation
    this.computeInFlight = true;
    this.computeAnomalyAsync(correlationId)
      .catch((err: unknown) => {
        this.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Unexpected error in anomaly computation'
        );
      })
      .finally(() => {
        this.computeInFlight = false;
      });

    return undefined;
  }

  /**
   * Async computation of anomaly - stores result for next tick.
   */
  private async computeAnomalyAsync(correlationId: string): Promise<void> {
    try {
      const goal = await this.getCalorieGoal();

      // No goal set = neuron stays dormant
      if (!goal) {
        this.logger.debug({ reason: 'no_goal' }, 'Anomaly check: skipping');
        return;
      }

      const tz = this.getTimezone();
      const patterns = this.getUserPatterns();
      const localHour = getLocalHour(tz);

      // Compute wake-relative hour
      const wakeRelativeHour = getWakeRelativeHour(localHour, patterns);
      const wakingHours = getWakingHours(patterns);
      const dayProgress = wakeRelativeHour / wakingHours;

      this.logger.debug(
        {
          goal,
          tz,
          localHour,
          wakeRelativeHour,
          wakingHours,
          dayProgress: dayProgress.toFixed(2),
          minDayProgress: this.config.minDayProgress,
        },
        'Anomaly check: computed time values'
      );

      // Check timing: only check after minDayProgress of waking hours
      if (dayProgress < this.config.minDayProgress) {
        this.logger.debug(
          { reason: 'too_early', dayProgress: dayProgress.toFixed(2) },
          'Anomaly check: skipping'
        );
        return;
      }

      // Check once-per-day guard
      const state = await this.loadPersistedState();
      const today = DateTime.now().setZone(tz).toISODate();
      if (!today) return;

      if (state?.lastEmittedDate === today) {
        // Already emitted today, no more signals
        this.logger.debug(
          { reason: 'already_emitted', lastEmittedDate: state.lastEmittedDate },
          'Anomaly check: skipping'
        );
        return;
      }

      // Load items map once (shared with baseline computation)
      const itemsMap = await this.loadItemsMap();

      // Load baseline
      const baseline = await this.computeBaseline(tz, patterns, today, itemsMap);
      if (!baseline) {
        // Not enough history - silent
        this.logger.debug({ reason: 'no_baseline' }, 'Anomaly check: skipping');
        return;
      }

      // Get current hour's expected values
      const hourKey = Math.floor(wakeRelativeHour);
      const hourData = baseline[hourKey];
      this.logger.debug(
        {
          hourKey,
          hasHourData: !!hourData,
          availableHours: Object.keys(baseline)
            .map(Number)
            .sort((a, b) => a - b),
        },
        'Anomaly check: baseline lookup'
      );
      if (!hourData) {
        return;
      }

      // Floor guard: skip if expected calories too low
      if (hourData.calories.median < this.config.minExpectedCalories) {
        return;
      }

      // Read today's entries up to current hour (for symmetry with baseline's
      // cumulative-to-hour data). Filter out future pre-logged entries.
      const allTodayEntries = await this.loadDayEntries(today);
      const todayEntries = allTodayEntries.filter((e) => {
        const entryHour = getHourFromTimestamp(e.timestamp, tz);
        const wakeHour = getWakeRelativeHour(entryHour, patterns);
        return wakeHour <= wakeRelativeHour;
      });

      // Compute today's cumulative calories and meals
      let todayCalories = 0;
      for (const entry of todayEntries) {
        const item = itemsMap.get(entry.dishId);
        if (item) {
          todayCalories += resolveEntryCalories(entry, item);
        }
      }
      const todayMeals = countMeals(todayEntries, tz);

      // Compute anomaly scores
      const calorieDeviation = Math.max(
        0,
        (hourData.calories.median - todayCalories) / hourData.calories.median
      );
      const mealDeviation = Math.max(
        0,
        (hourData.meals.median - todayMeals) / Math.max(1, hourData.meals.median)
      );

      const anomalyScore = Math.max(calorieDeviation, mealDeviation);

      // Check threshold
      if (anomalyScore <= this.config.anomalyThreshold) {
        return;
      }

      // Determine anomaly type
      let anomalyType: 'low_intake' | 'missing_meals' | 'both';
      if (
        calorieDeviation > this.config.anomalyThreshold &&
        mealDeviation > this.config.anomalyThreshold
      ) {
        anomalyType = 'both';
      } else if (mealDeviation > calorieDeviation) {
        anomalyType = 'missing_meals';
      } else {
        anomalyType = 'low_intake';
      }

      this.logger.debug(
        {
          anomalyScore: anomalyScore.toFixed(2),
          anomalyType,
          todayCalories,
          expectedCalories: hourData.calories.median,
          todayMeals,
          expectedMeals: hourData.meals.median,
          hourOfDay: localHour,
          wakeRelativeHour,
          dayProgress: dayProgress.toFixed(2),
          baselineDays: hourData.baselineDays,
        },
        'Calorie anomaly detected'
      );

      // Create signal
      const signal = this.createSignal(
        anomalyType,
        todayCalories,
        hourData.calories.median,
        hourData.calories.q1,
        hourData.calories.q3,
        todayMeals,
        hourData.meals.median,
        goal,
        localHour,
        hourData.baselineDays,
        correlationId
      );

      // Record emission and persist state
      await this.persistState(today);

      this.pendingSignal = signal;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to compute calorie anomaly'
      );
    }
  }

  /**
   * Compute baseline from past N days.
   * Returns a map of wake-relative hour -> baseline data.
   */
  private async computeBaseline(
    timezone: string,
    patterns: UserPatterns | null,
    today: string,
    itemsMap: Map<string, FoodItem>
  ): Promise<Record<number, HourlyBaseline> | null> {
    // Try to load cached baseline (baseline is from past days only, won't change intra-day)
    const cached = await this.loadCachedBaseline();
    if (cached?.date === today) {
      return cached.data;
    }

    // Collect data from past days
    const todayDate = DateTime.fromISO(today, { zone: timezone });
    const hourlyData = new Map<number, { calories: number[]; meals: number[] }>();

    let validDays = 0;
    for (
      let i = 1;
      i <= this.config.maxBaselineDays && validDays < this.config.maxBaselineDays;
      i++
    ) {
      const date = todayDate.minus({ days: i });
      const dateStr = date.toISODate();
      if (!dateStr) continue;

      // loadDayEntries already filters by recipientId
      const entries = await this.loadDayEntries(dateStr);

      // Skip zero-entry days
      if (entries.length === 0) continue;

      validDays++;

      // Group entries by wake-relative hour and compute cumulative stats
      let cumulativeCalories = 0;
      const entriesByHour = new Map<number, FoodEntry[]>();

      for (const entry of entries) {
        const entryHour = getHourFromTimestamp(entry.timestamp, timezone);
        const wakeHour = getWakeRelativeHour(entryHour, patterns);
        const hourKey = Math.floor(wakeHour);

        let bucket = entriesByHour.get(hourKey);
        if (!bucket) {
          bucket = [];
          entriesByHour.set(hourKey, bucket);
        }
        bucket.push(entry);
      }

      // Sort hours and accumulate, then forward-fill to all intermediate hours.
      // This ensures every valid day contributes a cumulative sample at every hour
      // in its range, preventing hours with variable meal times from being dropped
      // by the minBaselineDays filter.
      const sortedHours = [...entriesByHour.keys()].sort((a, b) => a - b);
      const seenMeals = new Set<string>();
      const mealWindows = new Set<number>();

      if (sortedHours.length > 0) {
        const firstHour = sortedHours[0] as number;
        const maxEntryHour = sortedHours[sortedHours.length - 1] as number;
        let nextEntryIdx = 0;

        for (let h = firstHour; h <= maxEntryHour; h++) {
          // Process entries at this hour if any
          const nextHour = sortedHours[nextEntryIdx];
          if (nextHour !== undefined && nextHour === h) {
            const hourEntries = entriesByHour.get(h) ?? [];
            for (const entry of hourEntries) {
              const item = itemsMap.get(entry.dishId);
              if (item) {
                cumulativeCalories += resolveEntryCalories(entry, item);
              }
              if (entry.mealType) {
                seenMeals.add(entry.mealType);
              } else {
                const window = Math.floor(h / 2);
                mealWindows.add(window);
              }
            }
            nextEntryIdx++;
          }

          const mealCount = seenMeals.size + mealWindows.size;

          // Store cumulative data (forward-filled from last entry hour)
          let hourBucket = hourlyData.get(h);
          if (!hourBucket) {
            hourBucket = { calories: [], meals: [] };
            hourlyData.set(h, hourBucket);
          }
          hourBucket.calories.push(cumulativeCalories);
          hourBucket.meals.push(mealCount);
        }
      }
    }

    // Check minimum days
    if (validDays < this.config.minBaselineDays) {
      return null;
    }

    // Compute median/IQR for each hour, then fill gaps
    // by carrying forward values to subsequent hours
    const result: Record<number, HourlyBaseline> = {};

    // First, compute stats for hours with data
    const hourlyStats = new Map<number, HourlyBaseline>();
    for (const [hour, data] of hourlyData) {
      if (data.calories.length < this.config.minBaselineDays) continue;

      hourlyStats.set(hour, {
        calories: {
          median: median(data.calories),
          q1: percentile(data.calories, 25),
          q3: percentile(data.calories, 75),
        },
        meals: {
          median: median(data.meals),
          q1: percentile(data.meals, 25),
          q3: percentile(data.meals, 75),
        },
        baselineDays: data.calories.length,
      });
    }

    // Find max hour with data
    const maxHour = Math.max(...hourlyStats.keys(), 0);

    // Fill gaps: for each hour 0 to maxHour, use the most recent data
    let lastStats: HourlyBaseline | undefined;
    for (let h = 0; h <= maxHour; h++) {
      const stats = hourlyStats.get(h);
      if (stats) {
        lastStats = stats;
        result[h] = stats;
      } else if (lastStats) {
        // Carry forward the last known cumulative stats
        result[h] = lastStats;
      }
    }

    // Cache the result
    await this.cacheBaseline(today, result);

    return result;
  }

  /**
   * Load entries for a specific day.
   */
  private async loadDayEntries(date: string): Promise<FoodEntry[]> {
    const entries = await this.storage.get<FoodEntry[]>(
      `${CALORIES_STORAGE_KEYS.foodPrefix}${date}`
    );
    // Filter by recipient
    return (entries ?? []).filter((e) => e.recipientId === this.recipientId);
  }

  /**
   * Load items catalog and return as map.
   */
  private async loadItemsMap(): Promise<Map<string, FoodItem>> {
    const items = await this.storage.get<FoodItem[]>(CALORIES_STORAGE_KEYS.items);
    const map = new Map<string, FoodItem>();
    for (const item of items ?? []) {
      map.set(item.id, item);
    }
    return map;
  }

  private async loadPersistedState(): Promise<PersistedAnomalyState | null> {
    try {
      const raw = await this.storage.get<PersistedAnomalyState>(NEURON_STATE_KEY);
      if (raw && typeof raw === 'object' && 'lastEmittedDate' in raw) {
        return raw;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to load persisted anomaly state'
      );
      return null;
    }
  }

  private async persistState(today: string): Promise<void> {
    await this.storage.set(NEURON_STATE_KEY, {
      lastEmittedDate: today,
    } satisfies PersistedAnomalyState);
  }

  private async loadCachedBaseline(): Promise<CachedBaseline | null> {
    try {
      const raw = await this.storage.get<CachedBaseline>(BASELINE_CACHE_KEY);
      if (raw && typeof raw === 'object' && 'date' in raw && 'data' in raw) {
        return raw;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async cacheBaseline(today: string, data: Record<number, HourlyBaseline>): Promise<void> {
    const tz = this.getTimezone();
    const patterns = this.getUserPatterns();
    const localHour = getLocalHour(tz);
    const wakeRelativeHour = getWakeRelativeHour(localHour, patterns);

    await this.storage.set(BASELINE_CACHE_KEY, {
      date: today,
      hour: wakeRelativeHour,
      data,
    } satisfies CachedBaseline);
  }

  private createSignal(
    anomalyType: 'low_intake' | 'missing_meals' | 'both',
    consumed: number,
    expectedByNow: number,
    normalLow: number,
    normalHigh: number,
    mealCount: number,
    expectedMeals: number,
    goal: number,
    hourOfDay: number,
    baselineDays: number,
    correlationId: string
  ): Signal {
    const metrics: SignalMetrics = {
      value: consumed,
      confidence: 1.0,
    };

    return createSignal(this.signalType, this.source, metrics, {
      priority: Priority.NORMAL,
      correlationId,
      data: {
        kind: 'plugin_event',
        eventKind: 'calories:anomaly',
        pluginId: 'calories',
        payload: {
          anomalyType,
          consumed,
          expectedByNow,
          normalRange: { low: normalLow, high: normalHigh },
          mealCount,
          expectedMeals,
          goal,
          hourOfDay,
          baselineDays,
        },
      },
    });
  }
}

/**
 * Create a calories anomaly neuron.
 */
export function createCaloriesAnomalyNeuron(
  logger: Logger,
  config: Partial<CaloriesAnomalyNeuronConfig>,
  storage: StoragePrimitive,
  recipientId: string,
  getTimezone: GetTimezoneFunc,
  getUserPatterns: GetUserPatternsFunc,
  getCalorieGoal: GetCalorieGoalFunc
): CaloriesAnomalyNeuron {
  return new CaloriesAnomalyNeuron(
    logger,
    config,
    storage,
    recipientId,
    getTimezone,
    getUserPatterns,
    getCalorieGoal
  );
}
