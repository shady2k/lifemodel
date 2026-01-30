/**
 * Time Neuron Plugin
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
import type { NeuronPluginV2 } from '../../types/plugin.js';
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
    night: [number, number];
    morning: [number, number];
    afternoon: [number, number];
    evening: [number, number];
  };
}

/**
 * Default configuration.
 */
export const DEFAULT_TIME_CONFIG: TimeNeuronConfig = {
  timeOfDayRanges: {
    night: [22, 7],
    morning: [7, 12],
    afternoon: [12, 17],
    evening: [17, 22],
  },
};

/**
 * Time Neuron implementation.
 */
export class TimeNeuron extends BaseNeuron {
  readonly id = 'time-neuron';
  readonly signalType: SignalType = 'tick';
  readonly source: SignalSource = 'neuron.time';
  readonly description = 'Monitors time passage and transitions';

  private readonly config: TimeNeuronConfig;
  private lastHour: number | undefined;
  private lastTimeOfDay: TimeOfDay | undefined;

  constructor(logger: Logger, config: Partial<TimeNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_TIME_CONFIG, ...config };
  }

  check(_state: AgentState, _alertness: number, correlationId: string): Signal | undefined {
    const signals = this.checkAll(correlationId);
    return (
      signals.find((s) => s.type === 'hour_changed') ??
      signals.find((s) => s.type === 'time_of_day') ??
      signals.find((s) => s.type === 'tick')
    );
  }

  checkAll(correlationId: string): Signal[] {
    const now = new Date();
    const currentHour = now.getHours();
    const currentTimeOfDay = this.getTimeOfDay(currentHour);
    const signals: Signal[] = [];

    signals.push(this.createTickSignal(currentHour, currentTimeOfDay, correlationId));

    if (this.lastHour !== undefined && this.lastHour !== currentHour) {
      signals.push(
        this.createHourChangedSignal(currentHour, this.lastHour, currentTimeOfDay, correlationId)
      );
      this.logger.debug({ previousHour: this.lastHour, currentHour }, 'Hour changed');
    }

    if (this.lastTimeOfDay !== undefined && this.lastTimeOfDay !== currentTimeOfDay) {
      signals.push(
        this.createTimeOfDaySignal(currentTimeOfDay, this.lastTimeOfDay, currentHour, correlationId)
      );
      this.logger.debug(
        { previous: this.lastTimeOfDay, current: currentTimeOfDay },
        'Time of day changed'
      );
    }

    this.lastHour = currentHour;
    this.lastTimeOfDay = currentTimeOfDay;

    return signals;
  }

  getTimeOfDay(hour: number): TimeOfDay {
    const { night, morning, afternoon, evening } = this.config.timeOfDayRanges;

    if (night[0] > night[1]) {
      if (hour >= night[0] || hour < night[1]) return 'night';
    } else {
      if (hour >= night[0] && hour < night[1]) return 'night';
    }

    if (hour >= morning[0] && hour < morning[1]) return 'morning';
    if (hour >= afternoon[0] && hour < afternoon[1]) return 'afternoon';
    if (hour >= evening[0] && hour < evening[1]) return 'evening';

    return 'night';
  }

  private createTickSignal(hour: number, timeOfDay: TimeOfDay, correlationId: string): Signal {
    const data: TimeData = { kind: 'time', hour, timeOfDay };

    return createSignal(
      'tick',
      this.source,
      { value: hour / 24, confidence: 1.0 },
      { priority: Priority.LOW, correlationId, data }
    );
  }

  private createHourChangedSignal(
    hour: number,
    previousHour: number,
    timeOfDay: TimeOfDay,
    correlationId: string
  ): Signal {
    const data: TimeData = { kind: 'time', hour, timeOfDay, previousHour };

    return createSignal(
      'hour_changed',
      this.source,
      { value: hour / 24, previousValue: previousHour / 24, confidence: 1.0 },
      { priority: Priority.NORMAL, correlationId, data }
    );
  }

  private createTimeOfDaySignal(
    timeOfDay: TimeOfDay,
    previousTimeOfDay: TimeOfDay,
    hour: number,
    correlationId: string
  ): Signal {
    const data: TimeData = { kind: 'time', hour, timeOfDay, previousTimeOfDay };
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
      { priority, correlationId, data }
    );
  }

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

/**
 * Time neuron plugin.
 */
const plugin: NeuronPluginV2 = {
  manifest: {
    manifestVersion: 2,
    id: 'time-neuron',
    name: 'Time Neuron',
    version: '1.0.0',
    description: 'Monitors time passage and transitions',
    provides: [{ type: 'neuron', id: 'time-neuron' }],
    requires: [],
  },
  lifecycle: {
    activate: () => {
      // Neuron plugins don't need activation - neuron is created via factory
    },
  },
  neuron: {
    create: (logger: Logger, config?: unknown) =>
      new TimeNeuron(logger, config as Partial<TimeNeuronConfig>),
    defaultConfig: DEFAULT_TIME_CONFIG,
  },
};

export default plugin;
