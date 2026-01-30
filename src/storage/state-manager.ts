import { createHash } from 'node:crypto';
import type { Logger } from '../types/index.js';
import type { Storage } from './storage.js';
import type { JSONStorage } from './json-storage.js';
import type { PersistableState, PersistableNeuronWeights } from './persistable-state.js';
import {
  PERSISTABLE_STATE_VERSION,
  createEmptyPersistableState,
  serializeState,
} from './persistable-state.js';
import type { Agent } from '../core/agent.js';
import type { UserModel } from '../models/user-model.js';
/**
 * State manager configuration.
 */
export interface StateManagerConfig {
  /** Storage key for state */
  stateKey?: string;
  /** Auto-save interval in ms (default: 5 minutes, 0 to disable) */
  autoSaveInterval?: number;
}

const DEFAULT_CONFIG: Required<StateManagerConfig> = {
  stateKey: 'state',
  autoSaveInterval: 2 * 60 * 1000, // 2 minutes
};

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
  private readonly storage: Storage & Partial<Pick<JSONStorage, 'loadWithFallback'>>;
  private readonly logger: Logger;
  private readonly config: Required<StateManagerConfig>;

  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;

  /** Hash of last saved state (for change detection) */
  private lastSavedHash: string | null = null;

  // References to components for state collection
  private agent: Agent | null = null;
  private userModel: UserModel | null = null;
  private neuronWeights: PersistableNeuronWeights | null = null;

  constructor(storage: Storage, logger: Logger, config: Partial<StateManagerConfig> = {}) {
    this.storage = storage;
    this.logger = logger.child({ component: 'state-manager' });
    this.config = { ...DEFAULT_CONFIG, ...config };
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

  /**
   * Start auto-save timer.
   * Checks for state changes on each interval and saves if changed.
   */
  startAutoSave(): void {
    if (this.config.autoSaveInterval <= 0) {
      this.logger.debug('Auto-save disabled');
      return;
    }

    this.autoSaveTimer = setInterval(() => {
      void this.saveIfChanged().catch((err: unknown) => {
        this.logger.error({ error: err }, 'Auto-save failed');
      });
    }, this.config.autoSaveInterval);

    this.logger.info({ intervalMs: this.config.autoSaveInterval }, 'Auto-save started');
  }

  /**
   * Stop auto-save timer.
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
      this.logger.debug('Auto-save stopped');
    }
  }

  /**
   * Compute hash of serialized state for change detection.
   */
  private computeHash(serialized: string): string {
    return createHash('sha256').update(serialized).digest('hex');
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

  /**
   * Save current state to storage if it has changed.
   * Compares hash of current state with last saved state.
   * Returns true if saved, false if skipped (no changes).
   */
  async saveIfChanged(): Promise<boolean> {
    const state = this.collectState();
    const serialized = serializeState(state);
    const hash = this.computeHash(serialized);

    if (hash === this.lastSavedHash) {
      this.logger.debug('State unchanged, skipping save');
      return false;
    }

    await this.storage.save(this.config.stateKey, JSON.parse(serialized));
    this.lastSavedHash = hash;
    this.logger.debug({ savedAt: state.savedAt }, 'State saved');
    return true;
  }

  /**
   * Force save current state to storage (always writes).
   */
  async save(): Promise<void> {
    const state = this.collectState();
    const serialized = serializeState(state);

    await this.storage.save(this.config.stateKey, JSON.parse(serialized));
    this.lastSavedHash = this.computeHash(serialized);
    this.logger.debug({ savedAt: state.savedAt }, 'State saved');
  }

  /**
   * Load state from storage.
   * Returns null if no saved state exists.
   */
  async load(): Promise<PersistableState | null> {
    try {
      // Try loadWithFallback if available (JSONStorage)
      let data: unknown = null;

      if (
        'loadWithFallback' in this.storage &&
        typeof this.storage.loadWithFallback === 'function'
      ) {
        data = await this.storage.loadWithFallback(this.config.stateKey);
      } else {
        data = await this.storage.load(this.config.stateKey);
      }

      if (!data) {
        this.logger.info('No saved state found, starting fresh');
        return null;
      }

      // Cast and migrate
      const state = data as PersistableState;
      const migrated = this.migrateState(state);

      this.logger.info({ version: migrated.version, savedAt: migrated.savedAt }, 'State loaded');

      return migrated;
    } catch (error) {
      this.logger.error({ error }, 'Failed to load state');
      return null;
    }
  }

  /**
   * Migrate state from older versions.
   */
  private migrateState(state: PersistableState): PersistableState {
    // Currently at version 1, no migrations needed yet
    if (state.version === PERSISTABLE_STATE_VERSION) {
      return state;
    }

    this.logger.info({ from: state.version, to: PERSISTABLE_STATE_VERSION }, 'Migrating state');

    // Future migrations go here
    // if (state.version < 2) { ... migrate to v2 ... }

    state.version = PERSISTABLE_STATE_VERSION;
    return state;
  }

  /**
   * Shutdown - save state and cleanup.
   */
  async shutdown(): Promise<void> {
    this.stopAutoSave();

    if (this.agent) {
      this.logger.info('Saving state before shutdown...');
      await this.save();
    }

    this.logger.info('State manager shutdown complete');
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
