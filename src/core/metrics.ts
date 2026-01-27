import type { MetricLabels, Metrics } from '../types/index.js';

/**
 * No-op metrics implementation.
 *
 * Does nothing - used as placeholder until Prometheus is implemented.
 * All methods are no-ops that return immediately.
 */
export class NoOpMetrics implements Metrics {
  gauge(_name: string, _value: number, _labels?: MetricLabels): void {
    // No-op
  }

  counter(_name: string, _labels?: MetricLabels, _increment?: number): void {
    // No-op
  }

  histogram(_name: string, _value: number, _labels?: MetricLabels): void {
    // No-op
  }
}

/**
 * Create a no-op metrics instance.
 */
export function createMetrics(): Metrics {
  return new NoOpMetrics();
}
