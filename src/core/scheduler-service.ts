/**
 * Scheduler Service
 *
 * Runs on each CoreLoop tick to check all plugin schedules
 * and fire due events with idempotency guarantees.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '../types/logger.js';
import type { Signal, PluginEventData } from '../types/signal.js';
import type { SchedulerPrimitiveImpl } from './scheduler-primitive.js';

/**
 * Callback type for pushing signals into the pipeline.
 */
export type SignalPushCallback = (signal: Signal) => void;

/**
 * Callback type for notifying plugins of events.
 */
export type PluginEventCallback = (
  pluginId: string,
  eventKind: string,
  payload: Record<string, unknown>
) => Promise<void>;

/**
 * Scheduler service configuration.
 */
export interface SchedulerServiceConfig {
  /** Maximum schedules to fire per tick (default: 10) */
  maxFiresPerTick: number;
}

const DEFAULT_CONFIG: SchedulerServiceConfig = {
  maxFiresPerTick: 10,
};

/**
 * Scheduler service - manages all plugin schedulers.
 */
export class SchedulerService {
  private readonly logger: Logger;
  private readonly config: SchedulerServiceConfig;
  private readonly schedulers = new Map<string, SchedulerPrimitiveImpl>();
  private signalCallback: SignalPushCallback | null = null;
  private pluginEventCallback: PluginEventCallback | null = null;

  constructor(logger: Logger, config: Partial<SchedulerServiceConfig> = {}) {
    this.logger = logger.child({ component: 'scheduler-service' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the callback for pushing signals into the pipeline.
   */
  setSignalCallback(callback: SignalPushCallback): void {
    this.signalCallback = callback;
  }

  /**
   * Set the callback for notifying plugins of their events.
   */
  setPluginEventCallback(callback: PluginEventCallback): void {
    this.pluginEventCallback = callback;
  }

  /**
   * Register a scheduler primitive for a plugin.
   */
  registerScheduler(pluginId: string, scheduler: SchedulerPrimitiveImpl): void {
    if (this.schedulers.has(pluginId)) {
      this.logger.warn({ pluginId }, 'Scheduler already registered, replacing');
    }
    this.schedulers.set(pluginId, scheduler);
    this.logger.debug({ pluginId }, 'Scheduler registered');
  }

  /**
   * Unregister a scheduler for a plugin.
   */
  unregisterScheduler(pluginId: string): boolean {
    const removed = this.schedulers.delete(pluginId);
    if (removed) {
      this.logger.debug({ pluginId }, 'Scheduler unregistered');
    }
    return removed;
  }

  /**
   * Get a scheduler by plugin ID.
   */
  getScheduler(pluginId: string): SchedulerPrimitiveImpl | undefined {
    return this.schedulers.get(pluginId);
  }

  /**
   * Tick - check all schedulers for due events.
   * Called by CoreLoop on each tick.
   */
  async tick(): Promise<void> {
    if (!this.signalCallback) {
      return; // No callback set, skip
    }

    const now = new Date();
    let totalFired = 0;

    for (const [pluginId, scheduler] of this.schedulers) {
      if (totalFired >= this.config.maxFiresPerTick) {
        this.logger.debug(
          { maxFires: this.config.maxFiresPerTick },
          'Max fires per tick reached, deferring remaining'
        );
        break;
      }

      try {
        const dueSchedules = await scheduler.checkDueSchedules(now);

        for (const { entry, fireId } of dueSchedules) {
          if (totalFired >= this.config.maxFiresPerTick) {
            break;
          }

          // IMPORTANT: Record fireId BEFORE emitting for at-most-once semantics
          // If we crash after this but before signal delivery, event is lost (not duplicated)
          await scheduler.markFired(entry.id, fireId, now);

          // Get event kind from data
          const rawKind = entry.data['kind'];
          const eventKind = typeof rawKind === 'string' ? rawKind : `${pluginId}:scheduled`;

          // Notify plugin of its event (for internal state updates)
          if (this.pluginEventCallback) {
            try {
              await this.pluginEventCallback(pluginId, eventKind, entry.data);
            } catch (error) {
              this.logger.error(
                {
                  pluginId,
                  eventKind,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Plugin event callback failed'
              );
            }
          }

          // Create and emit signal to wake cognition
          const signal = this.createPluginEventSignal(pluginId, entry.data, fireId);
          this.signalCallback(signal);

          totalFired++;

          this.logger.debug(
            {
              pluginId,
              scheduleId: entry.id,
              fireId,
              dataKeys: Object.keys(entry.data),
            },
            'Schedule fired'
          );
        }
      } catch (error) {
        this.logger.error(
          { pluginId, error: error instanceof Error ? error.message : String(error) },
          'Error checking scheduler'
        );
      }
    }

    if (totalFired > 0) {
      this.logger.trace({ totalFired }, 'Scheduler tick complete');
    }
  }

  /**
   * Create a plugin_event signal.
   */
  private createPluginEventSignal(
    pluginId: string,
    data: Record<string, unknown>,
    fireId: string
  ): Signal {
    const rawKind = data['kind'];
    const eventKind = typeof rawKind === 'string' ? rawKind : `${pluginId}:scheduled`;
    const now = new Date();

    const signalData: PluginEventData = {
      kind: 'plugin_event',
      eventKind,
      pluginId,
      fireId,
      payload: data,
    };

    return {
      id: randomUUID(),
      type: 'plugin_event',
      source: 'plugin.scheduler',
      timestamp: now,
      priority: 2, // Normal priority
      metrics: { value: 1, confidence: 1 },
      data: signalData,
      expiresAt: new Date(now.getTime() + 60_000), // 1 minute TTL
    };
  }

  /**
   * Get all registered plugin IDs.
   */
  getRegisteredPlugins(): string[] {
    return Array.from(this.schedulers.keys());
  }

  /**
   * Get total schedule count across all plugins.
   */
  getTotalScheduleCount(): number {
    let total = 0;
    for (const scheduler of this.schedulers.values()) {
      const schedules = scheduler.getSchedules();
      // Handle both sync and async implementations
      if (Array.isArray(schedules)) {
        total += schedules.length;
      }
    }
    return total;
  }
}

/**
 * Create a scheduler service.
 */
export function createSchedulerService(
  logger: Logger,
  config?: Partial<SchedulerServiceConfig>
): SchedulerService {
  return new SchedulerService(logger, config);
}
