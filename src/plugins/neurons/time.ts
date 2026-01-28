/**
 * Time Neuron
 *
 * Monitors time-based changes and emits signals for:
 * - Regular tick (heartbeat)
 * - Hour changes
 * - Time of day transitions (morning, afternoon, evening, night)
 *
 * Unlike other neurons that monitor state values, this one monitors
 * the passage of time itself.
 */

import type { Signal, SignalSource, SignalType, TimeData } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { Priority } from '../../types/priority.js';

/**
 * Time of day category.
 */
export type TimeOfDay = 'night' | 'morning' | 'afternoon' | 'evening';

/**
 * Configuration for time neuron.
 */
export interface TimeNeuronConfig {
  /** Hour ranges for time of day (inclusive start, exclusive end) */
  timeOfDayRanges: {
    night: [number, number]; // e.g., [22, 7] wraps around midnight
    morning: [number, number]; // e.g., [7, 12]
    afternoon: [number, number]; // e.g., [12, 17]
    evening: [number, number]; // e.g., [17, 22]
  };
}

/**
 * Default configuration.
 */
export const DEFAULT_TIME_CONFIG: TimeNeuronConfig = {
  timeOfDayRanges: {
    night: [22, 7], // 10 PM to 7 AM
    morning: [7, 12], // 7 AM to 12 PM
    afternoon: [12, 17], // 12 PM to 5 PM
    evening: [17, 22], // 5 PM to 10 PM
  },
};

/**
 * Time Neuron implementation.
 */
export class TimeNeuron extends BaseNeuron {
  readonly id = 'time';
  readonly signalType: SignalType = 'tick'; // Primary type, emits others too
  readonly source: SignalSource = 'neuron.time';
  readonly description = 'Monitors time passage and transitions';

  private readonly config: TimeNeuronConfig;
  private lastHour: number | undefined;
  private lastTimeOfDay: TimeOfDay | undefined;

  constructor(logger: Logger, config: Partial<TimeNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_TIME_CONFIG, ...config };
  }

  /**
   * Check returns multiple signals for different time events.
   * Since interface expects single signal, we return the most significant one.
   * Use checkAll() to get all time signals.
   */
  check(_state: AgentState, _alertness: number, correlationId: string): Signal | undefined {
    const signals = this.checkAll(correlationId);
    // Return most significant signal (hour_changed > time_of_day > tick)
    return (
      signals.find((s) => s.type === 'hour_changed') ??
      signals.find((s) => s.type === 'time_of_day') ??
      signals.find((s) => s.type === 'tick')
    );
  }

  /**
   * Check and return all time-related signals.
   */
  checkAll(correlationId: string): Signal[] {
    const now = new Date();
    const currentHour = now.getHours();
    const currentTimeOfDay = this.getTimeOfDay(currentHour);
    const signals: Signal[] = [];

    // Always emit tick signal
    signals.push(this.createTickSignal(currentHour, currentTimeOfDay, correlationId));

    // Check for hour change
    if (this.lastHour !== undefined && this.lastHour !== currentHour) {
      signals.push(
        this.createHourChangedSignal(currentHour, this.lastHour, currentTimeOfDay, correlationId)
      );
      this.logger.debug({ previousHour: this.lastHour, currentHour }, 'Hour changed');
    }

    // Check for time of day transition
    if (this.lastTimeOfDay !== undefined && this.lastTimeOfDay !== currentTimeOfDay) {
      signals.push(
        this.createTimeOfDaySignal(currentTimeOfDay, this.lastTimeOfDay, currentHour, correlationId)
      );
      this.logger.debug(
        { previous: this.lastTimeOfDay, current: currentTimeOfDay },
        'Time of day changed'
      );
    }

    // Update tracked values
    this.lastHour = currentHour;
    this.lastTimeOfDay = currentTimeOfDay;

    return signals;
  }

  /**
   * Get time of day for a given hour.
   */
  getTimeOfDay(hour: number): TimeOfDay {
    const { night, morning, afternoon, evening } = this.config.timeOfDayRanges;

    // Night wraps around midnight
    if (night[0] > night[1]) {
      // e.g., [22, 7] means 22-23 and 0-6
      if (hour >= night[0] || hour < night[1]) return 'night';
    } else {
      if (hour >= night[0] && hour < night[1]) return 'night';
    }

    if (hour >= morning[0] && hour < morning[1]) return 'morning';
    if (hour >= afternoon[0] && hour < afternoon[1]) return 'afternoon';
    if (hour >= evening[0] && hour < evening[1]) return 'evening';

    // Fallback (shouldn't happen with proper config)
    return 'night';
  }

  private createTickSignal(hour: number, timeOfDay: TimeOfDay, correlationId: string): Signal {
    const data: TimeData = {
      kind: 'time',
      hour,
      timeOfDay,
    };

    return createSignal(
      'tick',
      this.source,
      {
        value: hour / 24, // Normalize hour to 0-1
        confidence: 1.0,
      },
      {
        priority: Priority.LOW, // Tick is low priority
        correlationId,
        data,
      }
    );
  }

  private createHourChangedSignal(
    hour: number,
    previousHour: number,
    timeOfDay: TimeOfDay,
    correlationId: string
  ): Signal {
    const data: TimeData = {
      kind: 'time',
      hour,
      timeOfDay,
      previousHour,
    };

    return createSignal(
      'hour_changed',
      this.source,
      {
        value: hour / 24,
        previousValue: previousHour / 24,
        confidence: 1.0,
      },
      {
        priority: Priority.NORMAL,
        correlationId,
        data,
      }
    );
  }

  private createTimeOfDaySignal(
    timeOfDay: TimeOfDay,
    previousTimeOfDay: TimeOfDay,
    hour: number,
    correlationId: string
  ): Signal {
    const data: TimeData = {
      kind: 'time',
      hour,
      timeOfDay,
      previousTimeOfDay,
    };

    // Night transition is more significant (affects availability)
    const priority =
      timeOfDay === 'night' || previousTimeOfDay === 'night' ? Priority.NORMAL : Priority.LOW;

    return createSignal(
      'time_of_day',
      this.source,
      {
        value: this.timeOfDayToValue(timeOfDay),
        previousValue: this.timeOfDayToValue(previousTimeOfDay),
        confidence: 1.0,
      },
      {
        priority,
        correlationId,
        data,
      }
    );
  }

  /**
   * Convert time of day to numeric value for metrics.
   */
  private timeOfDayToValue(tod: TimeOfDay): number {
    switch (tod) {
      case 'night':
        return 0;
      case 'morning':
        return 0.25;
      case 'afternoon':
        return 0.5;
      case 'evening':
        return 0.75;
    }
  }

  reset(): void {
    super.reset();
    this.lastHour = undefined;
    this.lastTimeOfDay = undefined;
  }
}

/**
 * Create a time neuron.
 */
export function createTimeNeuron(logger: Logger, config?: Partial<TimeNeuronConfig>): TimeNeuron {
  return new TimeNeuron(logger, config);
}
