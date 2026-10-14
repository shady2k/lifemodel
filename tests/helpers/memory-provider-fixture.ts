import type { Logger } from '../../src/types/logger.js';
import { MemoryProviderImpl } from '../../src/storage/memory-provider.js';
import { InMemoryVectorStore } from './in-memory-vector-store.js';

export function createTestMemoryProvider(logger: Logger, maxEntries = 10000): MemoryProviderImpl {
  return new MemoryProviderImpl(logger, { vectorStore: new InMemoryVectorStore(maxEntries) });
}
