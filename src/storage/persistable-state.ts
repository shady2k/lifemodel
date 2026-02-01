import type { AgentState, SleepState } from '../types/agent/state.js';
import type { User } from '../types/user/user.js';

/**
 * Rule state that needs to be persisted.
 * Only the dynamic parts - not the condition/action functions.
 */
export interface PersistableRuleState {
  /** Rule ID */
  id: string;
  /** Current weight (may have changed from learning) */
  weight: number;
  /** Times this rule has been used */
  useCount: number;
  /** Last time the rule was used */
  lastUsed: string | null;
}

/**
 * Neuron weights that can be persisted and restored.
 */
export interface PersistableNeuronWeights {
  /** Weights for contact pressure neuron */
  contactPressure: Record<string, number>;
  /** Weights for alertness neuron */
  alertness: Record<string, number>;
}

/**
 * Complete persistable state snapshot.
 *
 * This is what gets saved to disk and restored on startup.
 * Contains all state that should survive restarts.
 */
export interface PersistableState {
  /** Schema version for migrations */
  version: number;

  /** Timestamp when state was saved */
  savedAt: string;

  /** Agent state */
  agent: {
    state: AgentState;
    sleepState: SleepState;
  };

  /** User model state (null if no primary user) */
  user: User | null;

  /** Rule states (weights, use counts) */
  rules: PersistableRuleState[];

  /** Neuron weights for learning */
  neuronWeights: PersistableNeuronWeights;
}

/**
 * Current schema version.
 * Increment when making breaking changes to PersistableState.
 */
export const PERSISTABLE_STATE_VERSION = 1;

/**
 * Create an empty persistable state with defaults.
 */
export function createEmptyPersistableState(): PersistableState {
  return {
    version: PERSISTABLE_STATE_VERSION,
    savedAt: new Date().toISOString(),
    agent: {
      state: {
        energy: 0.8,
        socialDebt: 0.0,
        taskPressure: 0.0,
        curiosity: 0.5,
        acquaintancePressure: 0.0,
        acquaintancePending: false,
        thoughtPressure: 0.0,
        pendingThoughtCount: 0,
        lastTickAt: new Date(),
        tickInterval: 30_000,
      },
      sleepState: {
        mode: 'normal',
        disturbance: 0.0,
        disturbanceDecay: 0.95,
        wakeThreshold: 0.5,
      },
    },
    user: null,
    rules: [],
    neuronWeights: {
      contactPressure: {
        socialDebt: 0.4,
        taskPressure: 0.2,
        curiosity: 0.1,
        userAvailability: 0.3,
      },
      alertness: {
        energy: 0.4,
        recentActivity: 0.3,
        timeOfDay: 0.3,
      },
    },
  };
}

/**
 * Serialize state for persistence.
 * Handles Date objects and other non-JSON-safe values.
 */
export function serializeState(state: PersistableState): string {
  return JSON.stringify(
    state,
    (_key, value: unknown) => {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
    },
    2
  );
}

/**
 * Deserialize state from storage.
 * Handles Date restoration and migrations for missing fields.
 */
export function deserializeState(json: string): PersistableState {
  // Parse as unknown first to handle migrations for legacy data
  const rawState = JSON.parse(json, (key: string, value: unknown) => {
    // Convert ISO date strings back to Date objects for specific fields
    if (
      key === 'lastTickAt' ||
      key === 'lastMentioned' ||
      key === 'lastSignalAt' ||
      key === 'updatedAt'
    ) {
      if (typeof value === 'string') {
        return new Date(value);
      }
    }
    return value;
  }) as Record<string, unknown>;

  // Cast to state type - no migrations, clean slate
  return rawState as unknown as PersistableState;
}
