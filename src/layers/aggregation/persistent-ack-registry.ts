/** Snapshot-backed acknowledgement registry. */
import type { Logger } from '../../types/logger.js';
import {
  SignalAckRegistry,
  type PersistedAckRegistryState,
  type AckRegistryConfig,
} from './ack-registry.js';

/** The core snapshot is the only durable writer for acknowledgement state. */
export class PersistentAckRegistry extends SignalAckRegistry {
  private loaded = false;

  constructor(logger: Logger, _storage?: unknown, config?: AckRegistryConfig) {
    super(logger, config);
  }

  load(state?: PersistedAckRegistryState | null): Promise<void> {
    if (this.loaded) throw new Error('AckRegistry snapshot already loaded');
    if (state) this.import(state);
    this.loaded = true;
    return Promise.resolve();
  }

  exportSnapshot(): PersistedAckRegistryState {
    return this.export();
  }
}
