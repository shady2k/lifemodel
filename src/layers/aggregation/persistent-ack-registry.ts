/**
 * Persistent Acknowledgment Registry
 *
 * Wrapper for SignalAckRegistry that adds persistence via DeferredStorage.
 * Automatically saves state changes and restores on startup.
 *
 * This follows the wrapper pattern used by PersistentRecipientRegistry:
 * - Base class contains all business logic
 * - Wrapper extends base and overrides onMutate() for persistence
 * - DeferredStorage provides batching to avoid excessive I/O
 */

import type { DeferredStorage } from '../../storage/deferred-storage.js';
import type { Logger } from '../../types/logger.js';
import {
  SignalAckRegistry,
  type PersistedAckRegistryState,
  type AckRegistryConfig,
} from './ack-registry.js';

const STORAGE_KEY = 'ack-registry';

/**
 * Persistent wrapper for SignalAckRegistry.
 * Handles auto-save on state changes via mutation hook.
 *
 * Uses debounced saves (500ms) to batch rapid mutations while
 * ensuring state is persisted quickly. DeferredStorage adds
 * additional 30s batching for disk I/O efficiency.
 */
export class PersistentAckRegistry extends SignalAckRegistry {
  private readonly storage: DeferredStorage;
  private saveTimeout: NodeJS.Timeout | null = null;
  private dirty = false;
  private saving = false;
  private isLoaded = false;
  private readonly saveDebounceMs = 500;

  constructor(logger: Logger, storage: DeferredStorage, config?: AckRegistryConfig) {
    super(logger, config);
    this.storage = storage;
  }

  /**
   * Load persisted state from storage.
   * Must be called before first use.
   *
   * @returns Promise that resolves when load is complete
   */
  async load(): Promise<void> {
    if (this.isLoaded) {
      this.logger.warn('load() called multiple times, ignoring');
      return;
    }

    try {
      const data = (await this.storage.load(STORAGE_KEY)) as PersistedAckRegistryState | null;
      if (data) {
        this.import(data);
        this.logger.debug(
          { ackCount: this.acks.size, savedAt: data.savedAt },
          'AckRegistry state restored'
        );
      } else {
        this.logger.debug('No existing AckRegistry state found, starting fresh');
      }
    } catch (error) {
      this.logger.warn({ error }, 'Failed to load AckRegistry state, starting fresh');
    }

    this.isLoaded = true;
  }

  /**
   * Override mutation hook to trigger debounced save.
   * Uses setTimeout with 500ms debounce (resets on each mutation).
   */
  protected override onMutate(): void {
    this.dirty = true;

    // Clear existing timeout and reschedule (true debounce)
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      void this.save();
    }, this.saveDebounceMs);
  }

  /**
   * Persist current state to storage.
   * DeferredStorage handles additional batching, so this is safe to call frequently.
   * Reschedules save if new mutations occur during an in-flight save.
   */
  private async save(): Promise<void> {
    if (!this.dirty || this.saving) {
      return;
    }

    this.saving = true;
    this.dirty = false;

    try {
      const state = this.export();
      await this.storage.save(STORAGE_KEY, state);
      this.logger.debug({ ackCount: state.acks.length }, 'AckRegistry state saved');
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to save AckRegistry state'
      );
      // Mark dirty again to retry on next save
      this.dirty = true;
    } finally {
      this.saving = false;
      // If new mutations occurred during save, reschedule immediately
      if (this.dirty && !this.saveTimeout) {
        this.saveTimeout = setTimeout(() => {
          this.saveTimeout = null;
          void this.save();
        }, this.saveDebounceMs);
      }
    }
  }

  /**
   * Flush any pending saves (call before shutdown).
   * Ensures all pending state changes are written to storage.
   *
   * @returns Promise that resolves when flush is complete
   */
  async flush(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.save();
  }
}
