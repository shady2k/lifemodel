/**
 * Calories Deficit Neuron
 *
 * Monitors calorie deficit throughout the day and emits signals when
 * the deficit becomes significant. Follows Weber-Fechner change detection
 * like other neurons.
 *
 * Key behaviors:
 * - Reads food entries directly from plugin storage (no core changes)
 * - Skips during sleep hours (alertness < 0.3)
 * - Uses sleep-aware day boundary (2 AM = still "yesterday")
 * - Stays dormant if no calorie goal is set
 * - Pressure increases as day progresses and tapers after 8 PM
 */

import type { Signal, SignalSource, SignalType, SignalMetrics } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import type { StoragePrimitive } from '../../types/plugin.js';
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { detectChange, type ChangeDetectorConfig } from '../../layers/autonomic/change-detector.js';
import { Priority } from '../../types/priority.js';
import { DateTime } from 'luxon';
import type { FoodEntry } from './calories-types.js';
import { CALORIES_STORAGE_KEYS } from './calories-types.js';
import { getCurrentFoodDate } from './calories-tool.js';

const NEURON_STATE_KEY = 'calories_deficit_neuron_state';

interface PersistedNeuronState {
  lastEmittedAt: string | null; // ISO string
  previousValue: number | null;
  lastComputedDate: string | null; // YYYY-MM-DD
}

/**
 * Configuration for calories deficit neuron.
 */
export interface CaloriesDeficitNeuronConfig {
  /** Change detection config */
  changeConfig: ChangeDetectorConfig;

  /** Minimum interval between emissions (ms) - 2 hours to avoid nagging */
  refractoryPeriodMs: number;

  /** Threshold for moderate deficit signal (0.5 = 50% deficit) */
  moderateDeficitThreshold: number;

  /** Threshold for high priority signal (0.8 = 80% deficit) */
  highDeficitThreshold: number;

  /** Hour after which to start tapering pressure (eating window closing) */
  taperStartHour: number;

  /** Hour after which neuron becomes dormant (too late to eat) */
  dormantHour: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_CALORIES_DEFICIT_CONFIG: CaloriesDeficitNeuronConfig = {
  changeConfig: {
    baseThreshold: 0.1, // 10% relative change
    minAbsoluteChange: 0.05, // At least 5% absolute
    maxThreshold: 0.3,
    alertnessInfluence: 0.3,
  },
  refractoryPeriodMs: 2 * 60 * 60 * 1000, // 2 hours
  moderateDeficitThreshold: 0.5,
  highDeficitThreshold: 0.8,
  taperStartHour: 20, // 8 PM
  dormantHour: 23, // 11 PM
};

/**
 * User patterns interface for sleep-aware calculations.
 */
interface UserPatterns {
  wakeHour?: number;
  sleepHour?: number;
}

/**
 * Function type for getting user timezone.
 */
type GetTimezoneFunc = () => string;

/**
 * Function type for getting user patterns.
 */
type GetUserPatternsFunc = () => UserPatterns | null;

/**
 * Function type for getting calorie goal.
 */
type GetCalorieGoalFunc = () => Promise<number | null>;

/**
 * Get the current local hour in user's timezone.
 */
function getLocalHour(timezone: string): number {
  return DateTime.now().setZone(timezone).hour;
}

/**
 * Calories Deficit Neuron implementation.
 *
 * Unlike other neurons that read from AgentState, this neuron reads
 * directly from plugin storage to compute deficit on-the-fly.
 */
export class CaloriesDeficitNeuron extends BaseNeuron {
  readonly id = 'calories-deficit';
  readonly signalType: SignalType = 'plugin_event';
  readonly source: SignalSource = 'plugin.calories';
  readonly description = 'Monitors calorie deficit throughout the day';

  private readonly config: CaloriesDeficitNeuronConfig;
  private readonly storage: StoragePrimitive;
  private readonly getTimezone: GetTimezoneFunc;
  private readonly getUserPatterns: GetUserPatternsFunc;
  private readonly getCalorieGoal: GetCalorieGoalFunc;

  constructor(
    logger: Logger,
    config: Partial<CaloriesDeficitNeuronConfig>,
    storage: StoragePrimitive,
    getTimezone: GetTimezoneFunc,
    getUserPatterns: GetUserPatternsFunc,
    getCalorieGoal: GetCalorieGoalFunc
  ) {
    super(logger);
    this.config = { ...DEFAULT_CALORIES_DEFICIT_CONFIG, ...config };
    this.storage = storage;
    this.getTimezone = getTimezone;
    this.getUserPatterns = getUserPatterns;
    this.getCalorieGoal = getCalorieGoal;
  }

  /**
   * Check state and emit signal if deficit changed significantly.
   *
   * Note: This method is synchronous per the interface, but we need async
   * storage access. We handle this by caching the last computed value
   * and triggering an async update. The actual signal emission happens
   * on subsequent ticks after the async computation completes.
   */
  check(_state: AgentState, alertness: number, correlationId: string): Signal | undefined {
    // Skip during sleep hours (Energy Conservation principle)
    if (alertness < 0.3) {
      return undefined;
    }

    const tz = this.getTimezone();
    const localHour = getLocalHour(tz);

    // Dormant after eating window closes
    if (localHour >= this.config.dormantHour) {
      return undefined;
    }

    // Trigger async deficit computation (result available next tick)
    // Note: computeDeficitAsync has internal try/catch, but we add .catch() here
    // to prevent unhandled rejection if the method itself throws synchronously
    this.computeDeficitAsync(correlationId).catch((err: unknown) => {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Unexpected error in deficit computation'
      );
    });

    // Return cached signal if we have one pending
    return this.pendingSignal;
  }

  private pendingSignal: Signal | undefined;

  /**
   * Async computation of deficit - stores result for next tick.
   */
  private async computeDeficitAsync(correlationId: string): Promise<void> {
    try {
      const goal = await this.getCalorieGoal();

      // No goal set = neuron stays dormant
      if (!goal) {
        this.pendingSignal = undefined;
        return;
      }

      const tz = this.getTimezone();
      const userPatterns = this.getUserPatterns();
      const today = getCurrentFoodDate(tz, userPatterns);
      const localHour = getLocalHour(tz);

      // Read today's entries directly from storage
      const entries = await this.storage.get<FoodEntry[]>(
        `${CALORIES_STORAGE_KEYS.foodPrefix}${today}`
      );
      const consumed = (entries ?? []).reduce((sum, e) => sum + e.calories, 0);

      // Compute deficit (0 = goal met, 1 = nothing eaten)
      const deficit = Math.max(0, goal - consumed) / goal;

      // Factor in time of day (pressure increases as day progresses)
      // Taper down after taperStartHour (eating window typically closed)
      let dayProgress: number;
      if (localHour < this.config.taperStartHour) {
        dayProgress = Math.min(1, localHour / this.config.taperStartHour);
      } else {
        // Taper down from 1 to 0.5 between taperStartHour and dormantHour
        const hoursAfterTaper = localHour - this.config.taperStartHour;
        const taperWindow = this.config.dormantHour - this.config.taperStartHour;
        dayProgress = Math.max(0.5, 1 - (hoursAfterTaper / taperWindow) * 0.5);
      }

      const pressure = deficit * dayProgress;

      // Store for logging
      const currentValue = pressure;

      // First tick - try to restore persisted state from before restart
      if (this.previousValue === undefined) {
        const persisted = await this.loadPersistedState();
        if (persisted?.lastComputedDate === today && persisted.previousValue != null) {
          // Same day with valid previous value — restore and fall through to normal change detection
          this.previousValue = persisted.previousValue;
          this.lastEmittedAt = persisted.lastEmittedAt
            ? new Date(persisted.lastEmittedAt)
            : undefined;
        } else {
          // Fresh day or no persisted state — original first-tick behavior
          this.updatePrevious(currentValue);
          if (currentValue >= this.config.moderateDeficitThreshold && localHour >= 14) {
            this.pendingSignal = this.createSignal(
              currentValue,
              deficit,
              consumed,
              goal,
              correlationId
            );
          } else {
            this.pendingSignal = undefined;
          }
          this.persistState(today).catch((err: unknown) => {
            this.logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              'Failed to persist neuron state'
            );
          });
          return;
        }
      }

      // At this point previousValue is guaranteed to be set (either from prior tick or restored)
      const prevValue = this.previousValue;

      // Check refractory period
      if (this.isInRefractoryPeriod(this.config.refractoryPeriodMs)) {
        this.pendingSignal = undefined;
        return;
      }

      // Use Weber-Fechner change detection
      const changeResult = detectChange(
        currentValue,
        prevValue,
        0.5, // Use neutral alertness for change detection
        this.config.changeConfig
      );

      // Check for threshold crossings
      const crossedModerate =
        (prevValue < this.config.moderateDeficitThreshold &&
          currentValue >= this.config.moderateDeficitThreshold) ||
        (prevValue >= this.config.moderateDeficitThreshold &&
          currentValue < this.config.moderateDeficitThreshold);

      const crossedHigh =
        (prevValue < this.config.highDeficitThreshold &&
          currentValue >= this.config.highDeficitThreshold) ||
        (prevValue >= this.config.highDeficitThreshold &&
          currentValue < this.config.highDeficitThreshold);

      // Only emit after 2 PM and if deficit is significant
      const shouldEmit =
        localHour >= 14 &&
        currentValue >= this.config.moderateDeficitThreshold &&
        (changeResult.isSignificant || crossedModerate || crossedHigh);

      if (!shouldEmit) {
        this.updatePrevious(currentValue);
        this.persistState(today).catch((err: unknown) => {
          this.logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            'Failed to persist neuron state'
          );
        });
        this.pendingSignal = undefined;
        return;
      }

      const signal = this.createSignal(currentValue, deficit, consumed, goal, correlationId);

      this.logger.debug(
        {
          previous: prevValue.toFixed(2),
          current: currentValue.toFixed(2),
          deficit: deficit.toFixed(2),
          consumed,
          goal,
          localHour,
          crossedModerate,
          crossedHigh,
        },
        'Calorie deficit change detected'
      );

      this.updatePrevious(currentValue);
      this.recordEmission();
      this.persistState(today).catch((err: unknown) => {
        this.logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Failed to persist neuron state'
        );
      });
      this.pendingSignal = signal;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to compute calorie deficit'
      );
      this.pendingSignal = undefined;
    }
  }

  private async loadPersistedState(): Promise<PersistedNeuronState | null> {
    try {
      const raw = await this.storage.get<PersistedNeuronState>(NEURON_STATE_KEY);
      if (
        raw &&
        typeof raw === 'object' &&
        'lastComputedDate' in raw &&
        'previousValue' in raw &&
        'lastEmittedAt' in raw
      ) {
        return raw;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to load persisted neuron state'
      );
      return null;
    }
  }

  private async persistState(today: string): Promise<void> {
    await this.storage.set(NEURON_STATE_KEY, {
      lastEmittedAt: this.lastEmittedAt?.toISOString() ?? null,
      previousValue: this.previousValue ?? null,
      lastComputedDate: today,
    } satisfies PersistedNeuronState);
  }

  private createSignal(
    pressure: number,
    deficit: number,
    consumed: number,
    goal: number,
    correlationId: string
  ): Signal {
    const priority = pressure >= this.config.highDeficitThreshold ? Priority.HIGH : Priority.NORMAL;

    const metrics: SignalMetrics = {
      value: pressure,
      rateOfChange: this.previousValue !== undefined ? pressure - this.previousValue : 0,
      confidence: 1.0,
      deficit,
      consumed,
      goal,
      isModerate: pressure >= this.config.moderateDeficitThreshold ? 1 : 0,
      isHigh: pressure >= this.config.highDeficitThreshold ? 1 : 0,
    };

    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    return createSignal(this.signalType, this.source, metrics, {
      priority,
      correlationId,
      data: {
        kind: 'plugin_event',
        eventKind: 'calories:deficit',
        pluginId: 'calories',
        payload: {
          pressure,
          deficit,
          consumed,
          goal,
          remaining: goal - consumed,
        },
      },
    });
  }
}

/**
 * Create a calories deficit neuron.
 */
export function createCaloriesDeficitNeuron(
  logger: Logger,
  config: Partial<CaloriesDeficitNeuronConfig>,
  storage: StoragePrimitive,
  getTimezone: GetTimezoneFunc,
  getUserPatterns: GetUserPatternsFunc,
  getCalorieGoal: GetCalorieGoalFunc
): CaloriesDeficitNeuron {
  return new CaloriesDeficitNeuron(
    logger,
    config,
    storage,
    getTimezone,
    getUserPatterns,
    getCalorieGoal
  );
}
