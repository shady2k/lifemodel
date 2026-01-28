/**
 * System Health Monitor
 *
 * Monitors Node.js event loop lag and CPU usage to detect system stress.
 * Like the body's stress response system - when overwhelmed, we reduce
 * processing to survive.
 *
 * Stress levels trigger graceful degradation:
 * - normal: All layers active
 * - elevated: Disable SMART layer (no expensive LLM)
 * - high: Disable COGNITION too (no LLM at all)
 * - critical: Only AUTONOMIC runs (vital signs only)
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { Logger } from '../types/logger.js';

/**
 * Stress levels for the system.
 */
export type StressLevel = 'normal' | 'elevated' | 'high' | 'critical';

/**
 * Current system health snapshot.
 */
export interface SystemHealth {
  /** Event loop lag in milliseconds (p99) */
  eventLoopLagMs: number;

  /** CPU usage percentage (0-100) */
  cpuPercent: number;

  /** Current stress level */
  stressLevel: StressLevel;

  /** Which layers should be active at this stress level */
  activeLayers: {
    autonomic: boolean;
    aggregation: boolean;
    cognition: boolean;
    smart: boolean;
  };

  /** Time spent at current stress level (ms) */
  stressDurationMs: number;
}

/**
 * Configuration for stress thresholds.
 */
export interface SystemHealthConfig {
  /** Event loop lag thresholds (ms) */
  eventLoopLag: {
    elevated: number; // Above this → elevated stress
    high: number; // Above this → high stress
    critical: number; // Above this → critical stress
  };

  /** CPU usage thresholds (percentage 0-100) */
  cpuUsage: {
    elevated: number;
    high: number;
    critical: number;
  };

  /** How long to stay in recovery before dropping stress level (ms) */
  recoveryDelayMs: number;

  /** Event loop monitor resolution (ms) */
  monitorResolutionMs: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: SystemHealthConfig = {
  eventLoopLag: {
    elevated: 100, // 100ms lag → elevated
    high: 250, // 250ms lag → high
    critical: 500, // 500ms lag → critical
  },
  cpuUsage: {
    elevated: 70, // 70% CPU → elevated
    high: 85, // 85% CPU → high
    critical: 95, // 95% CPU → critical
  },
  recoveryDelayMs: 5000, // Stay recovered for 5s before dropping level
  monitorResolutionMs: 20,
};

/**
 * Layer configuration per stress level.
 */
const STRESS_LEVEL_LAYERS: Record<StressLevel, SystemHealth['activeLayers']> = {
  normal: {
    autonomic: true,
    aggregation: true,
    cognition: true,
    smart: true,
  },
  elevated: {
    autonomic: true,
    aggregation: true,
    cognition: true,
    smart: false, // Disable expensive LLM
  },
  high: {
    autonomic: true,
    aggregation: true,
    cognition: false, // Disable all LLM
    smart: false,
  },
  critical: {
    autonomic: true,
    aggregation: false, // Only vital monitoring
    cognition: false,
    smart: false,
  },
};

/**
 * System Health Monitor implementation.
 */
export class SystemHealthMonitor {
  private readonly config: SystemHealthConfig;
  private readonly logger: Logger;

  private eventLoopMonitor: IntervalHistogram | null = null;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuTime: number = Date.now();

  private currentStressLevel: StressLevel = 'normal';
  private stressLevelChangedAt: number = Date.now();
  private lastHealthyAt: number = Date.now();

  private running = false;

  constructor(logger: Logger, config: Partial<SystemHealthConfig> = {}) {
    this.logger = logger.child({ component: 'system-health' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start monitoring system health.
   */
  start(): void {
    if (this.running) return;

    this.eventLoopMonitor = monitorEventLoopDelay({
      resolution: this.config.monitorResolutionMs,
    });
    this.eventLoopMonitor.enable();

    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();

    this.running = true;
    this.logger.info('System health monitor started');
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (!this.running) return;

    if (this.eventLoopMonitor) {
      this.eventLoopMonitor.disable();
      this.eventLoopMonitor = null;
    }

    this.running = false;
    this.logger.info('System health monitor stopped');
  }

  /**
   * Get current system health snapshot.
   */
  getHealth(): SystemHealth {
    const eventLoopLagMs = this.getEventLoopLag();
    const cpuPercent = this.getCpuPercent();

    // Calculate stress level from metrics
    const measuredLevel = this.calculateStressLevel(eventLoopLagMs, cpuPercent);

    // Apply hysteresis - don't drop stress level immediately
    const newStressLevel = this.applyHysteresis(measuredLevel);

    // Track stress level changes
    if (newStressLevel !== this.currentStressLevel) {
      this.logger.warn(
        {
          from: this.currentStressLevel,
          to: newStressLevel,
          eventLoopLagMs: eventLoopLagMs.toFixed(1),
          cpuPercent: cpuPercent.toFixed(1),
        },
        `Stress level changed: ${this.currentStressLevel} → ${newStressLevel}`
      );
      this.currentStressLevel = newStressLevel;
      this.stressLevelChangedAt = Date.now();
    }

    return {
      eventLoopLagMs,
      cpuPercent,
      stressLevel: this.currentStressLevel,
      activeLayers: STRESS_LEVEL_LAYERS[this.currentStressLevel],
      stressDurationMs: Date.now() - this.stressLevelChangedAt,
    };
  }

  /**
   * Get event loop lag (p99 percentile in ms).
   */
  private getEventLoopLag(): number {
    if (!this.eventLoopMonitor) return 0;

    // percentile returns nanoseconds, convert to ms
    const lagNs = this.eventLoopMonitor.percentile(99);
    return lagNs / 1_000_000;
  }

  /**
   * Get CPU usage percentage.
   */
  private getCpuPercent(): number {
    const now = Date.now();
    const currentUsage = process.cpuUsage(this.lastCpuUsage ?? undefined);

    const elapsedMs = now - this.lastCpuTime;
    if (elapsedMs === 0) return 0;

    // CPU usage is in microseconds
    const totalCpuUs = currentUsage.user + currentUsage.system;
    const elapsedUs = elapsedMs * 1000;

    // Update for next call
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = now;

    // Calculate percentage (can exceed 100% on multi-core, cap at 100)
    const percent = (totalCpuUs / elapsedUs) * 100;
    return Math.min(percent, 100);
  }

  /**
   * Calculate stress level from metrics.
   */
  private calculateStressLevel(eventLoopLagMs: number, cpuPercent: number): StressLevel {
    const { eventLoopLag, cpuUsage } = this.config;

    // Use the higher stress level from either metric
    if (eventLoopLagMs >= eventLoopLag.critical || cpuPercent >= cpuUsage.critical) {
      return 'critical';
    }

    if (eventLoopLagMs >= eventLoopLag.high || cpuPercent >= cpuUsage.high) {
      return 'high';
    }

    if (eventLoopLagMs >= eventLoopLag.elevated || cpuPercent >= cpuUsage.elevated) {
      return 'elevated';
    }

    return 'normal';
  }

  /**
   * Apply hysteresis to prevent oscillation.
   *
   * Stress level can increase immediately but only decreases
   * after staying at a lower level for recoveryDelayMs.
   */
  private applyHysteresis(measuredLevel: StressLevel): StressLevel {
    const levelOrder: StressLevel[] = ['normal', 'elevated', 'high', 'critical'];
    const currentIndex = levelOrder.indexOf(this.currentStressLevel);
    const measuredIndex = levelOrder.indexOf(measuredLevel);

    // Increasing stress → apply immediately
    if (measuredIndex > currentIndex) {
      this.lastHealthyAt = Date.now();
      return measuredLevel;
    }

    // Decreasing stress → require recovery delay
    if (measuredIndex < currentIndex) {
      const timeSinceHealthy = Date.now() - this.lastHealthyAt;

      if (timeSinceHealthy >= this.config.recoveryDelayMs) {
        // Recovered enough, drop one level at a time
        const lowerLevel = levelOrder[currentIndex - 1];
        // Safe: currentIndex > measuredIndex >= 0, so currentIndex >= 1
        if (lowerLevel !== undefined) {
          return lowerLevel;
        }
      }

      // Not recovered long enough, stay at current level
      return this.currentStressLevel;
    }

    // Same level
    if (measuredLevel === 'normal') {
      this.lastHealthyAt = Date.now();
    }
    return this.currentStressLevel;
  }

  /**
   * Check if a specific layer should be active.
   */
  isLayerActive(layer: keyof SystemHealth['activeLayers']): boolean {
    return STRESS_LEVEL_LAYERS[this.currentStressLevel][layer];
  }

  /**
   * Get current stress level.
   */
  getStressLevel(): StressLevel {
    return this.currentStressLevel;
  }

  /**
   * Force a stress level (for testing).
   */
  forceStressLevel(level: StressLevel): void {
    this.currentStressLevel = level;
    this.stressLevelChangedAt = Date.now();
    this.logger.warn({ level }, 'Stress level forced (testing)');
  }

  /**
   * Reset to normal state.
   */
  reset(): void {
    this.currentStressLevel = 'normal';
    this.stressLevelChangedAt = Date.now();
    this.lastHealthyAt = Date.now();

    if (this.eventLoopMonitor) {
      this.eventLoopMonitor.reset();
    }

    this.logger.debug('System health monitor reset');
  }
}

/**
 * Create a system health monitor.
 */
export function createSystemHealthMonitor(
  logger: Logger,
  config?: Partial<SystemHealthConfig>
): SystemHealthMonitor {
  return new SystemHealthMonitor(logger, config);
}
