import type { MemoryEntry } from '../../src/layers/cognition/tools/registry.js';
import type {
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from '../../src/storage/vector-store.js';

/** In-memory VectorStore test double for unit tests above the persistence boundary. */
export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, MemoryEntry>();
  constructor(private readonly maxEntries = 10000) {}

  async search(options: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const query = options.query.trim().toLowerCase();
    if (
      query.length < 2 &&
      !options.types &&
      !options.recipientId &&
      !options.status &&
      !options.metadata
    )
      return [];
    const terms = query.split(/\s+/).filter(Boolean);
    return [...this.entries.values()]
      .filter((entry) => !options.types || options.types.includes(entry.type))
      .filter(
        (entry) =>
          !options.recipientId || !entry.recipientId || entry.recipientId === options.recipientId
      )
      .filter((entry) => !options.status || !entry.status || entry.status === options.status)
      .filter((entry) => (options.minConfidence ?? 0) <= (entry.confidence ?? 0.5))
      .filter(
        (entry) =>
          !options.metadata ||
          Object.entries(options.metadata).every(([key, value]) => entry.metadata?.[key] === value)
      )
      .map((entry) => ({
        entry,
        score:
          terms.reduce(
            (score, term) => score + (entry.content.toLowerCase().includes(term) ? 1 : 0),
            0
          ) + (entry.confidence ?? 0.5),
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 10));
  }
  async count(options?: { types?: MemoryEntry['type'][] }): Promise<number> {
    return [...this.entries.values()].filter(
      (entry) => !options?.types || options.types.includes(entry.type)
    ).length;
  }
  async save(entry: MemoryEntry): Promise<void> {
    const subject = entry.metadata?.['subject'];
    const attribute = entry.metadata?.['attribute'];
    if (entry.type === 'fact' && subject && attribute) {
      const old = [...this.entries.values()].find(
        (current) =>
          current.type === 'fact' &&
          current.metadata?.['subject'] === subject &&
          current.metadata?.['attribute'] === attribute
      );
      if (old) entry.id = old.id;
    }
    this.entries.set(entry.id, entry);
    this.prune();
  }
  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
  async getById(id: string): Promise<MemoryEntry | undefined> {
    return this.entries.get(id);
  }
  async getAll(): Promise<MemoryEntry[]> {
    return [...this.entries.values()];
  }
  async clear(): Promise<void> {
    this.entries.clear();
  }
  async persist(): Promise<void> {}

  private prune(): void {
    if (this.entries.size <= this.maxEntries) return;
    const maxProtected = Math.max(1, Math.min(10, Math.floor(this.maxEntries / 2)));
    const protectedEntries = [...this.entries.values()]
      .filter((entry) => this.protected(entry))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    while (protectedEntries.length > maxProtected) {
      const expired = protectedEntries.shift();
      if (!expired) break;
      expired.tags = (expired.tags ?? []).filter((tag) => tag !== 'state:unresolved');
      expired.tags.push('state:expired');
    }
    const candidates = [...this.entries.values()]
      .filter((entry) => !this.protected(entry))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    while (this.entries.size > this.maxEntries) {
      const oldest = candidates.shift();
      if (!oldest) break;
      this.entries.delete(oldest.id);
    }
  }
  private protected(entry: MemoryEntry): boolean {
    return (
      entry.type === 'thought' &&
      !!entry.tags?.includes('state:unresolved') &&
      !!entry.tags.includes('soul:reflection')
    );
  }
}
