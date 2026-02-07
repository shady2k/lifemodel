/**
 * Motor Cortex State Manager
 *
 * Manages persistence of Motor Cortex runs using DeferredStorage.
 * All runs are stored in a single object under the 'motor-runs' key.
 */

import type { Logger } from '../../types/index.js';
import type { Storage } from '../../storage/storage.js';
import type { MotorRun, RunStatus } from './motor-protocol.js';

/**
 * Storage key for motor runs.
 */
const MOTOR_RUNS_KEY = 'motor-runs';

/**
 * Stored runs structure.
 */
interface StoredRuns {
  runs: MotorRun[];
}

/**
 * Empty stored runs structure.
 */
const EMPTY_STORED: StoredRuns = {
  runs: [],
};

/**
 * Motor Cortex State Manager.
 *
 * CRUD operations for MotorRun persistence.
 * Uses DeferredStorage with explicit flush after critical transitions.
 */
export class MotorStateManager {
  private readonly storage: Storage;
  private readonly logger: Logger;

  constructor(storage: Storage, logger: Logger) {
    this.storage = storage;
    this.logger = logger.child({ component: 'motor-state' });
  }

  /**
   * Create a new run and persist to storage.
   */
  async createRun(run: MotorRun): Promise<void> {
    const stored = await this.loadStored();
    stored.runs.push(run);
    await this.storage.save(MOTOR_RUNS_KEY, stored);
    await this.flush();
    this.logger.debug({ runId: run.id, task: run.task }, 'Motor run created');
  }

  /**
   * Update an existing run and persist to storage.
   */
  async updateRun(run: MotorRun): Promise<void> {
    const stored = await this.loadStored();
    const index = stored.runs.findIndex((r) => r.id === run.id);

    if (index === -1) {
      throw new Error(`Run not found: ${run.id}`);
    }

    stored.runs[index] = run;
    await this.storage.save(MOTOR_RUNS_KEY, stored);
    await this.flush();
    this.logger.trace({ runId: run.id, status: run.status }, 'Motor run updated');
  }

  /**
   * Get a run by ID.
   */
  async getRun(runId: string): Promise<MotorRun | null> {
    const stored = await this.loadStored();
    return stored.runs.find((r) => r.id === runId) ?? null;
  }

  /**
   * List runs with optional filtering.
   */
  async listRuns(filter?: { status?: RunStatus }): Promise<MotorRun[]> {
    const stored = await this.loadStored();
    let runs = stored.runs;

    if (filter?.status) {
      runs = runs.filter((r) => r.status === filter.status);
    }

    // Sort by startedAt descending (newest first)
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Get the currently active run (running or created).
   * Only one run can be active at a time (mutex).
   */
  async getActiveRun(): Promise<MotorRun | null> {
    const stored = await this.loadStored();
    return (
      stored.runs.find(
        (r) => r.status === 'running' || r.status === 'created' || r.status === 'awaiting_input'
      ) ?? null
    );
  }

  /**
   * Explicit flush for critical state transitions.
   */
  private async flush(): Promise<void> {
    // Check if storage has flush method (DeferredStorage)
    if ('flush' in this.storage && typeof this.storage.flush === 'function') {
      await (this.storage.flush as () => Promise<void>)();
    }
  }

  /**
   * Load stored runs from storage.
   */
  private async loadStored(): Promise<StoredRuns> {
    const data = await this.storage.load(MOTOR_RUNS_KEY);
    if (!data) {
      return { ...EMPTY_STORED };
    }

    // Validate structure
    const stored = data as StoredRuns;
    if (!Array.isArray(stored.runs)) {
      this.logger.warn('Invalid stored runs structure, resetting');
      return { ...EMPTY_STORED };
    }

    return stored;
  }
}

/**
 * Factory function for creating a MotorStateManager.
 */
export function createMotorStateManager(storage: Storage, logger: Logger): MotorStateManager {
  return new MotorStateManager(storage, logger);
}
