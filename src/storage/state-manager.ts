import type { Logger } from '../types/index.js';
import type { Storage } from './storage.js';
import type { PersistableState, PersistableNeuronWeights } from './persistable-state.js';
import { PERSISTABLE_STATE_VERSION, createEmptyPersistableState } from './persistable-state.js';
import type { Agent } from '../core/agent.js';
import type { UserModel } from '../models/user-model.js';
/**
 * State manager configuration.
 */
export interface StateManagerConfig {
  /** Storage key for state */
  stateKey?: string;
}

/**
 * StateManager - coordinates persistence of application state.
 *
 * Responsibilities:
 * - Save state on demand and auto-save periodically
 * - Load state on startup
 * - Handle shutdown gracefully
 * - Migrate state between versions
 */
export class StateManager {
  private readonly logger: Logger;

  private snapshotState: PersistableState | null = null;

  // References to components for state collection
  private agent: Agent | null = null;
  private userModel: UserModel | null = null;
  private neuronWeights: PersistableNeuronWeights | null = null;

  constructor(_storage: Storage, logger: Logger, _config: Partial<StateManagerConfig> = {}) {
    this.logger = logger.child({ component: 'state-manager' });
  }

  /**
   * Register components for state collection.
   */
  registerComponents(components: {
    agent?: Agent;
    userModel?: UserModel;
    neuronWeights?: PersistableNeuronWeights;
  }): void {
    if (components.agent) this.agent = components.agent;
    if (components.userModel) this.userModel = components.userModel;
    if (components.neuronWeights) this.neuronWeights = components.neuronWeights;
  }

  /** State is written only by the core's per-tick snapshot commit. */
  startAutoSave(): void {
    // No timer or file writer: the snapshot commit is the sole state home.
  }

  stopAutoSave(): void {
    // Kept as the shutdown lifecycle hook; there is no background writer.
  }

  setSnapshotState(state: PersistableState | null): void {
    this.snapshotState = state;
  }

  /**
   * Collect current state from all components.
   */
  collectState(): PersistableState {
    const now = new Date();
    const state: PersistableState = {
      version: PERSISTABLE_STATE_VERSION,
      savedAt: now.toISOString(),
      agent: {
        state: this.agent?.getState() ?? createEmptyPersistableState().agent.state,
        sleepState: this.agent?.getSleepState() ?? createEmptyPersistableState().agent.sleepState,
      },
      user: this.userModel?.getUser() ?? null,
      rules: [],
      neuronWeights: this.neuronWeights ?? createEmptyPersistableState().neuronWeights,
    };

    return state;
  }

  /** Export the current application state for the atomic tick snapshot. */
  exportSnapshot(): PersistableState {
    return this.collectState();
  }

  /** Load a state envelope supplied by Valkey before components are constructed. */
  load(): Promise<PersistableState | null> {
    if (!this.snapshotState) {
      this.logger.info('No saved state found, starting fresh');
      return Promise.resolve(null);
    }
    const migrated = this.migrateState(this.snapshotState);
    if (migrated.agent?.state?.lastTickAt && !(migrated.agent.state.lastTickAt instanceof Date)) {
      migrated.agent.state.lastTickAt = new Date(
        migrated.agent.state.lastTickAt as unknown as string
      );
    }
    this.logger.info(
      { version: migrated.version, savedAt: migrated.savedAt },
      'State loaded from snapshot'
    );
    return Promise.resolve(migrated);
  }

  /**
   * Migrate state from older versions.
   */
  private migrateState(state: PersistableState): PersistableState {
    if (state.version === PERSISTABLE_STATE_VERSION) {
      return state;
    }

    this.logger.info({ from: state.version, to: PERSISTABLE_STATE_VERSION }, 'Migrating state');

    if (state.version < 2) {
      // v1→v2: Collapse 4 alertness modes to binary
      const mode = state.agent?.sleepState?.mode as string | undefined;
      if (state.agent?.sleepState) {
        if (mode === 'sleep' || mode === 'sleeping') {
          state.agent.sleepState.mode = 'sleeping';
        } else {
          state.agent.sleepState.mode = 'awake';
        }
      }
      // Remove phantom tickInterval
      if (state.agent?.state) {
        const agentState = state.agent.state as unknown as Record<string, unknown>;
        delete agentState['tickInterval'];
      }
    }

    state.version = PERSISTABLE_STATE_VERSION;
    return state;
  }

  /** Shutdown hook; tick commits have already made state durable. */
  shutdown(): Promise<void> {
    this.stopAutoSave();
    this.logger.info('State manager shutdown complete');
    return Promise.resolve();
  }
}

/**
 * Factory function for creating a state manager.
 */
export function createStateManager(
  storage: Storage,
  logger: Logger,
  config?: Partial<StateManagerConfig>
): StateManager {
  return new StateManager(storage, logger, config);
}
