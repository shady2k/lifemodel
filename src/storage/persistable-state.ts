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
    if (key === 'lastTickAt' || key === 'lastMentioned' || key === 'lastSignalAt') {
      if (typeof value === 'string') {
        return new Date(value);
      }
    }
    return value;
  }) as Record<string, unknown>;

  // Cast to state type, then apply migrations
  const state = rawState as unknown as PersistableState;

  // Type-safe access to potentially missing fields via raw object
  const user = rawState['user'] as Record<string, unknown> | null;
  const agent = rawState['agent'] as Record<string, unknown> | undefined;
  const agentState = agent?.['state'] as Record<string, unknown> | undefined;
  const userPrefs = user?.['preferences'] as Record<string, unknown> | undefined;

  // Migration: add nameKnown to user if missing (for data from before this field existed)
  if (user && user['nameKnown'] === undefined && state.user) {
    // Name is "known" if it's not a placeholder like "User" or the ID itself
    state.user.nameKnown =
      state.user.name !== 'User' && state.user.name !== state.user.id && state.user.name.length > 0;
  }

  // Migration: add acquaintancePressure to agent state if missing
  if (agentState && agentState['acquaintancePressure'] === undefined) {
    state.agent.state.acquaintancePressure = 0.0;
  }

  // Migration: add acquaintancePending to agent state if missing
  if (agentState && agentState['acquaintancePending'] === undefined) {
    state.agent.state.acquaintancePending = false;
  }

  // Migration: add language to user preferences if missing
  if (userPrefs && userPrefs['language'] === undefined && state.user) {
    state.user.preferences.language = null;
  }

  // Migration: add gender to user preferences if missing
  if (userPrefs && userPrefs['gender'] === undefined && state.user) {
    state.user.preferences.gender = 'unknown';
  }

  return state;
}
