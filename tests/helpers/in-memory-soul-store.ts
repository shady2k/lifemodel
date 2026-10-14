import type { SoulStateStore, StoredSoulState } from '../../src/storage/soul-provider.js';

export function createInMemorySoulStore(): SoulStateStore {
  let stored: StoredSoulState | null = null;
  return {
    load: async () => stored,
    save: async (expectedVersion, document) => {
      if (stored?.version !== (expectedVersion ?? undefined)) {
        if (expectedVersion !== null || stored !== null) throw new Error('stale soul version');
      }
      const version = (stored?.version ?? 0) + 1;
      stored = { version, document };
      return version;
    },
  };
}
