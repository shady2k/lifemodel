/**
 * Metrics interface.
 *
 * Abstract interface for metrics collection.
 * MVP uses NoOpMetrics, later can be swapped for Prometheus.
 */

/**
 * Labels for metrics (key-value pairs).
 */
export type MetricLabels = Record<string, string>;

/**
 * Metrics interface.
 */
export interface Metrics {
  /**
   * Set a gauge value (can go up or down).
   * Example: agent_energy, queue_size
   */
  gauge(name: string, value: number, labels?: MetricLabels): void;

  /**
   * Increment a counter (only goes up).
   * Example: events_processed_total, messages_sent_total
   */
  counter(name: string, labels?: MetricLabels, increment?: number): void;

  /**
   * Record a histogram observation.
   * Example: llm_request_duration_ms, event_processing_time_ms
   */
  histogram(name: string, value: number, labels?: MetricLabels): void;
}
