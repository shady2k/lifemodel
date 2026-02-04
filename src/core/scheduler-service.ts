/**
 * Scheduler Service
 *
 * Runs on each CoreLoop tick to check all plugin schedules
 * and fire due events with idempotency guarantees.
 *
 * Dynamic Registration:
 * - Supports pausing plugins (scheduler won't fire while paused)
 * - Supports queued unregistration (applied at tick boundary)
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '../types/logger.js';
import type { Signal, PluginEventData } from '../types/signal.js';
import type { SchedulerPrimitiveImpl } from './scheduler-primitive.js';
import { withTraceContext, createTraceContext } from './trace-context.js';

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
 *
 * Supports dynamic plugin management:
 * - pausePlugin/resumePlugin: Immediately prevent/allow scheduler firing
 * - queueUnregister: Queue scheduler removal for tick boundary
 * - applyPendingChanges: Apply queued changes (called at tick start)
 */
export class SchedulerService {
  private readonly logger: Logger;
  private readonly config: SchedulerServiceConfig;
  private readonly schedulers = new Map<string, SchedulerPrimitiveImpl>();
  private signalCallback: SignalPushCallback | null = null;
  private pluginEventCallback: PluginEventCallback | null = null;

  /** Plugins that are paused (scheduler won't fire for these) */
  private readonly pausedPlugins = new Set<string>();

  /** Pending unregistrations (applied at tick boundary) */
  private pendingUnregistrations: string[] = [];

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
   * Clears any pending unregistration to prevent stale removal after restart.
   */
  registerScheduler(pluginId: string, scheduler: SchedulerPrimitiveImpl): void {
    if (this.schedulers.has(pluginId)) {
      this.logger.warn({ pluginId }, 'Scheduler already registered, replacing');
    }
    // Clear any pending unregistration to prevent stale removal after restart
    this.clearPendingUnregister(pluginId);
    this.schedulers.set(pluginId, scheduler);
    this.logger.debug({ pluginId }, 'Scheduler registered');
  }

  /**
   * Unregister a scheduler for a plugin immediately.
   * Use queueUnregister() for tick-boundary safe removal.
   */
  unregisterScheduler(pluginId: string): boolean {
    const removed = this.schedulers.delete(pluginId);
    // Also remove from paused set if present
    this.pausedPlugins.delete(pluginId);
    if (removed) {
      this.logger.debug({ pluginId }, 'Scheduler unregistered');
    }
    return removed;
  }

  /**
   * Queue a scheduler for unregistration at tick boundary.
   * Safer than unregisterScheduler() during tick processing.
   *
   * Note: If registerScheduler() is called for the same pluginId before
   * applyPendingChanges(), the pending unregistration is cleared to prevent
   * accidentally removing the new scheduler.
   */
  queueUnregister(pluginId: string): void {
    if (!this.pendingUnregistrations.includes(pluginId)) {
      this.pendingUnregistrations.push(pluginId);
      this.logger.debug({ pluginId }, 'Scheduler queued for unregistration');
    }
  }

  /**
   * Clear pending unregistration for a plugin.
   * Called when a new scheduler is registered to prevent stale removal after restart.
   */
  clearPendingUnregister(pluginId: string): void {
    const idx = this.pendingUnregistrations.indexOf(pluginId);
    if (idx !== -1) {
      this.pendingUnregistrations.splice(idx, 1);
      this.logger.debug({ pluginId }, 'Pending unregistration cleared');
    }
  }

  /**
   * Mark a plugin as paused (scheduler won't fire).
   * Takes effect immediately - safe to call during tick.
   */
  pausePlugin(pluginId: string): void {
    this.pausedPlugins.add(pluginId);
    this.logger.debug({ pluginId }, 'Plugin scheduler paused');
  }

  /**
   * Mark a plugin as resumed (scheduler can fire again).
   * Takes effect immediately.
   */
  resumePlugin(pluginId: string): void {
    this.pausedPlugins.delete(pluginId);
    this.logger.debug({ pluginId }, 'Plugin scheduler resumed');
  }

  /**
   * Check if a plugin's scheduler is paused.
   */
  isPluginPaused(pluginId: string): boolean {
    return this.pausedPlugins.has(pluginId);
  }

  /**
   * Apply pending changes at tick boundary.
   * Called by CoreLoop at START of each tick.
   */
  applyPendingChanges(): void {
    for (const pluginId of this.pendingUnregistrations) {
      try {
        this.unregisterScheduler(pluginId);
      } catch (error) {
        // Log and continue - don't block other unregistrations
        this.logger.error(
          { pluginId, error: error instanceof Error ? error.message : String(error) },
          'Failed to unregister scheduler'
        );
      }
    }
    this.pendingUnregistrations = [];
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
   *
   * Note: applyPendingChanges() is called by CoreLoop before tick(),
   * so any queued unregistrations are processed first.
   */
  async tick(): Promise<void> {
    if (!this.signalCallback) {
      return; // No callback set, skip
    }

    const now = new Date();
    let totalFired = 0;

    for (const [pluginId, scheduler] of this.schedulers) {
      // Skip paused plugins
      if (this.pausedPlugins.has(pluginId)) {
        continue;
      }

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

          const correlationId = entry.id;
          const signal = this.createPluginEventSignal(pluginId, entry.data, fireId, correlationId);

          // Wrap schedule firing with trace context (signal.id as root)
          await withTraceContext(
            createTraceContext(signal.id, { correlationId, spanId: `fire_${fireId}` }),
            async () => {
              // IMPORTANT: Record fireId BEFORE emitting for at-most-once semantics
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
              if (this.signalCallback) {
                this.signalCallback(signal);
              }

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
    fireId: string,
    scheduleId?: string
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

    const signal: Signal = {
      id: randomUUID(),
      type: 'plugin_event',
      source: 'plugin.scheduler',
      timestamp: now,
      priority: 2, // Normal priority
      metrics: { value: 1, confidence: 1 },
      data: signalData,
      expiresAt: new Date(now.getTime() + 60_000), // 1 minute TTL
    };
    if (scheduleId !== undefined) {
      signal.correlationId = scheduleId;
    }
    return signal;
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
