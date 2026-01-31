/**
 * Signal Filter Registry - manages signal transformation filters.
 *
 * Filters are distinct from neurons:
 * - Neurons GENERATE signals from internal state changes
 * - Filters TRANSFORM/CLASSIFY incoming signals
 *
 * Biological analogy:
 * - Neurons = internal sensory neurons (monitor state, fire on change)
 * - Filters = signal processing circuits (transform before routing)
 *
 * Plugins register filters during activation. Core provides:
 * - FilterRegistry infrastructure
 * - FilterContext with UserModel for accessing user preferences
 */

import type { Signal, SignalType } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import type { Interests } from '../../types/user/interests.js';

// ============================================================
// Filter User Model Interface
// ============================================================

/**
 * Minimal interface for what filters need from UserModel.
 *
 * This allows filters to access user interests without coupling
 * filter-registry to the full UserModel implementation.
 */
export interface FilterUserModel {
  /** Get user's interest configuration (topic weights, urgency). */
  getInterests(): Interests | null;
}

// ============================================================
// Filter Context
// ============================================================

/**
 * Context passed to filters during processing.
 *
 * Provides filters with access to agent state and user preferences.
 */
export interface FilterContext {
  /** Current agent state */
  state: AgentState;

  /** Current alertness level (0-1) */
  alertness: number;

  /** Tick correlation ID for signal bundling */
  correlationId: string;

  /**
   * User model for accessing interests and preferences.
   * Null if user model is not configured.
   */
  userModel: FilterUserModel | null;
}

// ============================================================
// Signal Filter Interface
// ============================================================

/**
 * Signal filter - transforms or classifies incoming signals.
 *
 * Filters can:
 * - Pass signals through unchanged
 * - Filter out signals (return empty array)
 * - Transform signals into new types
 * - Split one signal into multiple classified signals
 */
export interface SignalFilter {
  /** Unique filter identifier */
  readonly id: string;

  /** Human-readable description */
  readonly description: string;

  /**
   * Which signal types this filter handles.
   * Filter will only be called for signals matching these types.
   */
  readonly handles: SignalType[];

  /**
   * Process signals and return transformed/classified results.
   *
   * @param signals Incoming signals matching `handles` types
   * @param context Filter context with state and userModel
   * @returns Transformed signals (can be empty, same, or more than input)
   */
  process(signals: Signal[], context: FilterContext): Signal[];
}

// ============================================================
// Filter Registry
// ============================================================

/**
 * Registry for signal filters.
 *
 * Manages filter registration and provides ordered processing.
 */
export class FilterRegistry {
  private readonly filters = new Map<string, SignalFilter>();
  private readonly logger: Logger;

  /** Cached filter order (invalidated on registration) */
  private filterOrder: SignalFilter[] = [];
  private orderDirty = true;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'filter-registry' });
  }

  /**
   * Register a signal filter.
   *
   * @param filter The filter to register
   * @param priority Optional priority (lower = runs first, default 100)
   */
  register(filter: SignalFilter, priority = 100): void {
    if (this.filters.has(filter.id)) {
      this.logger.warn({ filterId: filter.id }, 'Replacing existing filter');
    }

    this.filters.set(filter.id, filter);
    this.orderDirty = true;

    this.logger.info(
      {
        filterId: filter.id,
        handles: filter.handles,
        priority,
      },
      'Signal filter registered'
    );
  }

  /**
   * Unregister a filter.
   */
  unregister(id: string): boolean {
    const removed = this.filters.delete(id);
    if (removed) {
      this.orderDirty = true;
      this.logger.info({ filterId: id }, 'Signal filter unregistered');
    }
    return removed;
  }

  /**
   * Get all registered filters in processing order.
   */
  getAll(): SignalFilter[] {
    if (this.orderDirty) {
      this.filterOrder = Array.from(this.filters.values());
      this.orderDirty = false;
    }
    return this.filterOrder;
  }

  /**
   * Get a filter by ID.
   */
  get(id: string): SignalFilter | undefined {
    return this.filters.get(id);
  }

  /**
   * Get filters that handle a specific signal type.
   */
  getForType(type: SignalType): SignalFilter[] {
    return this.getAll().filter((f) => f.handles.includes(type));
  }

  /**
   * Get registry size.
   */
  size(): number {
    return this.filters.size;
  }

  /**
   * Process signals through all relevant filters.
   *
   * For each signal type, finds matching filters and runs them.
   * Filters run sequentially - output of one becomes input to next.
   *
   * @param signals Incoming signals to process
   * @param context Filter context
   * @returns Processed signals
   */
  process(signals: Signal[], context: FilterContext): Signal[] {
    if (signals.length === 0 || this.filters.size === 0) {
      return signals;
    }

    let result = [...signals];

    for (const filter of this.getAll()) {
      // Find signals this filter handles
      const matching = result.filter((s) => filter.handles.includes(s.type));

      if (matching.length === 0) {
        continue;
      }

      try {
        // Remove matching signals from result
        const nonMatching = result.filter((s) => !filter.handles.includes(s.type));

        // Process matching signals
        const processed = filter.process(matching, context);

        // Combine: non-matching + processed
        result = [...nonMatching, ...processed];

        this.logger.trace(
          {
            filterId: filter.id,
            inputCount: matching.length,
            outputCount: processed.length,
          },
          'Filter processed signals'
        );
      } catch (error) {
        this.logger.error(
          {
            filterId: filter.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Filter processing failed, skipping'
        );
        // On error, keep original matching signals
      }
    }

    return result;
  }
}

/**
 * Create a filter registry.
 */
export function createFilterRegistry(logger: Logger): FilterRegistry {
  return new FilterRegistry(logger);
}
