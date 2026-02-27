/**
 * System Health Monitor
 *
 * Monitors 3 metrics to detect system stress:
 * - Event loop utilization (ELU): primary JS thread saturation signal
 * - Event loop lag (p99): catches blocking stalls and GC pauses
 * - CPU usage (EMA-smoothed): catches sustained overall process load
 *
 * Like the body's stress response system - when overwhelmed, we reduce
 * processing to survive.
 *
 * Stress levels trigger graceful degradation:
 * - normal: All layers active
 * - elevated: Disable SMART layer (no expensive LLM)
 * - high: Disable COGNITION too (no LLM at all)
 * - critical: Only AUTONOMIC runs (vital signs only)
 *
 * CPU usage is smoothed with a slow EMA (alpha=0.1, ~7-tick half-life) so
 * short I/O bursts (TLS decryption during LLM calls) don't trigger stress,
 * while sustained CPU pressure over ~30+ seconds still escalates correctly.
 * ELU and lag provide immediate detection of JS thread saturation.
 */

import {
  monitorEventLoopDelay,
  performance,
  type IntervalHistogram,
  type EventLoopUtilization,
} from 'node:perf_hooks';
import type { Logger } from '../types/logger.js';

/**
 * Stress levels for the system.
 */
export type StressLevel = 'normal' | 'elevated' | 'high' | 'critical';

/**
 * Current system health snapshot.
 */
export interface SystemHealth {
  /** Event loop lag in milliseconds (p99, windowed per tick) */
  eventLoopLagMs: number;

  /** CPU usage percentage (0-100, EMA-smoothed) */
  cpuPercent: number;

  /** Event loop utilization (0.0-1.0, per-tick delta) */
  eventLoopUtilization: number;

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

  /** Event loop utilization thresholds (0.0-1.0) */
  elu: {
    elevated: number; // Above this → elevated stress
    high: number; // Above this → high stress
    critical: number; // Above this → critical stress
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
    elevated: 300, // 300ms lag → elevated (normal LLM call setup ~200-300ms)
    high: 500, // 500ms lag → high
    critical: 1000, // 1s lag → critical
  },
  cpuUsage: {
    elevated: 90, // 90% CPU → elevated (ELU now handles JS thread busy)
    high: 95, // 95% CPU → high
    critical: 99, // 99% sustained → critical
  },
  elu: {
    elevated: 0.8, // 80% utilization → elevated
    high: 0.9, // 90% utilization → high
    critical: 0.97, // 97% utilization → critical
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
  private eluBaseline: EventLoopUtilization | null = null;

  private currentStressLevel: StressLevel = 'normal';
  private stressLevelChangedAt: number = Date.now();
  private lastHealthyAt: number = Date.now();
  private startedAt = 0;

  /** Exponential moving average of CPU usage.
   *  Smooths out brief spikes (TLS/embedding inference) so only sustained
   *  CPU pressure contributes to stress. Alpha 0.1 ≈ ~7-tick half-life. */
  private cpuEma = 0;
  private static readonly CPU_EMA_ALPHA = 0.1;

  /** Warmup period after start() during which all readings return 'normal'.
   *  Prevents startup CPU burst from triggering false stress alerts. */
  private static readonly WARMUP_MS = 3000;

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
    this.eluBaseline = performance.eventLoopUtilization();
    this.startedAt = Date.now();

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
    // During warmup, return normal to avoid false stress from startup CPU burst
    if (Date.now() - this.startedAt < SystemHealthMonitor.WARMUP_MS) {
      // Still sample to advance the CPU baseline, but discard the reading
      this.getCpuPercent();
      this.getEventLoopUtilization();
      if (this.eventLoopMonitor) this.eventLoopMonitor.reset();
      return {
        eventLoopLagMs: 0,
        cpuPercent: 0,
        eventLoopUtilization: 0,
        stressLevel: 'normal',
        activeLayers: STRESS_LEVEL_LAYERS.normal,
        stressDurationMs: 0,
      };
    }

    const eventLoopLagMs = this.getEventLoopLag();
    const cpuPercent = this.getCpuPercent();
    const elu = this.getEventLoopUtilization();

    // Update CPU EMA — smooths brief spikes, surfaces sustained load
    this.cpuEma =
      SystemHealthMonitor.CPU_EMA_ALPHA * cpuPercent +
      (1 - SystemHealthMonitor.CPU_EMA_ALPHA) * this.cpuEma;

    // Calculate stress level from all 3 metrics (uses smoothed CPU)
    const { level: measuredLevel, triggers } = this.calculateStressLevel(
      eventLoopLagMs,
      this.cpuEma,
      elu
    );

    // Apply hysteresis - don't drop stress level immediately
    const newStressLevel = this.applyHysteresis(measuredLevel);

    // Track stress level changes
    if (newStressLevel !== this.currentStressLevel) {
      this.logger.warn(
        {
          from: this.currentStressLevel,
          to: newStressLevel,
          trigger: triggers.join('+') || 'recovery',
          eventLoopLagMs: eventLoopLagMs.toFixed(1),
          cpuPercent: cpuPercent.toFixed(1),
          cpuEma: this.cpuEma.toFixed(1),
          elu: elu.toFixed(3),
        },
        `Stress level changed: ${this.currentStressLevel} → ${newStressLevel} [${triggers.join('+') || 'recovery'}]`
      );
      this.currentStressLevel = newStressLevel;
      this.stressLevelChangedAt = Date.now();
    }

    return {
      eventLoopLagMs,
      cpuPercent,
      eventLoopUtilization: elu,
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
    // Reset histogram so each tick measures only the last ~1s window
    this.eventLoopMonitor.reset();
    return lagNs / 1_000_000;
  }

  /**
   * Get event loop utilization (0.0-1.0) as a delta since last call.
   */
  private getEventLoopUtilization(): number {
    if (!this.eluBaseline) return 0;

    const current = performance.eventLoopUtilization(this.eluBaseline);
    this.eluBaseline = performance.eventLoopUtilization();
    return current.utilization;
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
   * Calculate stress level from 3 metrics: max(lagSeverity, cpuSeverity, eluSeverity).
   * Returns overall level plus per-metric breakdown for diagnostics.
   *
   * - ELU: primary JS thread saturation signal (catches tight loops, heavy computation)
   * - Lag: catches blocking stalls and GC pauses
   * - CPU: catches sustained overall process load (including native TLS/libuv threads);
   *   smoothed with slow EMA (alpha=0.1) so short I/O bursts don't trigger stress
   */
  private calculateStressLevel(
    eventLoopLagMs: number,
    smoothedCpu: number,
    elu: number
  ): { level: StressLevel; triggers: string[] } {
    const { eventLoopLag, cpuUsage, elu: eluThresholds } = this.config;

    const levelOrder: StressLevel[] = ['normal', 'elevated', 'high', 'critical'];

    const lagSeverity = this.metricToSeverity(
      eventLoopLagMs,
      eventLoopLag.elevated,
      eventLoopLag.high,
      eventLoopLag.critical
    );
    const cpuSeverity = this.metricToSeverity(
      smoothedCpu,
      cpuUsage.elevated,
      cpuUsage.high,
      cpuUsage.critical
    );
    const eluSeverity = this.metricToSeverity(
      elu,
      eluThresholds.elevated,
      eluThresholds.high,
      eluThresholds.critical
    );

    // Return the worst severity across all 3 metrics
    const maxIndex = Math.max(
      levelOrder.indexOf(lagSeverity),
      levelOrder.indexOf(cpuSeverity),
      levelOrder.indexOf(eluSeverity)
    );
    const level = levelOrder[maxIndex] ?? 'normal';

    // Identify which metrics are at or above the resulting level
    const triggers: string[] = [];
    if (lagSeverity === level && level !== 'normal') triggers.push('lag');
    if (cpuSeverity === level && level !== 'normal') triggers.push('cpu');
    if (eluSeverity === level && level !== 'normal') triggers.push('elu');

    return { level, triggers };
  }

  /**
   * Map a metric value to a stress severity level.
   */
  private metricToSeverity(
    value: number,
    elevated: number,
    high: number,
    critical: number
  ): StressLevel {
    if (value >= critical) return 'critical';
    if (value >= high) return 'high';
    if (value >= elevated) return 'elevated';
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
    this.cpuEma = 0;
    this.eluBaseline = performance.eventLoopUtilization();

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
