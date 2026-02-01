import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeferredStorage } from '../../../src/storage/deferred-storage.js';
import type { Storage } from '../../../src/storage/storage.js';
import type { Logger } from '../../../src/types/index.js';

// Mock logger
const createMockLogger = (): Logger => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
    level: 'debug',
  } as unknown as Logger;
  return mockLogger;
};

// Mock underlying storage
const createMockStorage = (): Storage & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return {
    data,
    load: vi.fn(async (key: string) => data.get(key) ?? null),
    save: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      const existed = data.has(key);
      data.delete(key);
      return existed;
    }),
    exists: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
  };
};

describe('DeferredStorage', () => {
  let mockStorage: ReturnType<typeof createMockStorage>;
  let mockLogger: Logger;
  let deferredStorage: DeferredStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockLogger = createMockLogger();
    deferredStorage = new DeferredStorage(mockStorage, mockLogger, {
      flushIntervalMs: 100, // Short interval for tests
      logFlush: false,
    });
  });

  afterEach(async () => {
    await deferredStorage.shutdown();
  });

  describe('save and load', () => {
    it('should cache saves without immediately writing to underlying storage', async () => {
      await deferredStorage.save('key1', { value: 'test' });

      // Underlying storage should NOT have been called yet
      expect(mockStorage.save).not.toHaveBeenCalled();

      // But we should be able to read it back from cache
      const result = await deferredStorage.load('key1');
      expect(result).toEqual({ value: 'test' });
    });

    it('should load from underlying storage on first access', async () => {
      // Pre-populate underlying storage
      mockStorage.data.set('existing', { value: 'from-disk' });

      const result = await deferredStorage.load('existing');

      expect(result).toEqual({ value: 'from-disk' });
      expect(mockStorage.load).toHaveBeenCalledWith('existing');
    });

    it('should use cached value on subsequent loads', async () => {
      mockStorage.data.set('cached', { value: 'original' });

      // First load - from underlying
      await deferredStorage.load('cached');
      expect(mockStorage.load).toHaveBeenCalledTimes(1);

      // Second load - from cache
      await deferredStorage.load('cached');
      expect(mockStorage.load).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('flush', () => {
    it('should write dirty entries to underlying storage', async () => {
      await deferredStorage.save('key1', { value: 'test1' });
      await deferredStorage.save('key2', { value: 'test2' });

      await deferredStorage.flush();

      expect(mockStorage.save).toHaveBeenCalledTimes(2);
      expect(mockStorage.save).toHaveBeenCalledWith('key1', { value: 'test1' });
      expect(mockStorage.save).toHaveBeenCalledWith('key2', { value: 'test2' });
    });

    it('should not write clean entries on subsequent flushes', async () => {
      await deferredStorage.save('key1', { value: 'test1' });
      await deferredStorage.flush();

      expect(mockStorage.save).toHaveBeenCalledTimes(1);

      // Flush again - no new writes
      await deferredStorage.flush();
      expect(mockStorage.save).toHaveBeenCalledTimes(1);
    });

    it('should skip flush if no dirty entries', async () => {
      await deferredStorage.flush();
      expect(mockStorage.save).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should mark key as deleted without immediate write', async () => {
      mockStorage.data.set('toDelete', { value: 'exists' });

      const result = await deferredStorage.delete('toDelete');

      expect(result).toBe(true);
      expect(mockStorage.delete).not.toHaveBeenCalled();

      // Should return null after deletion
      expect(await deferredStorage.load('toDelete')).toBeNull();
    });

    it('should delete from underlying storage on flush', async () => {
      mockStorage.data.set('toDelete', { value: 'exists' });

      await deferredStorage.delete('toDelete');
      await deferredStorage.flush();

      expect(mockStorage.delete).toHaveBeenCalledWith('toDelete');
    });
  });

  describe('exists', () => {
    it('should return false for deleted keys', async () => {
      mockStorage.data.set('key', { value: 'exists' });

      await deferredStorage.delete('key');

      expect(await deferredStorage.exists('key')).toBe(false);
    });

    it('should return true for cached keys', async () => {
      await deferredStorage.save('newKey', { value: 'new' });

      expect(await deferredStorage.exists('newKey')).toBe(true);
    });
  });

  describe('concurrent writes', () => {
    it('should handle concurrent saves to same key without race condition', async () => {
      // Simulate concurrent writes - the race condition that caused the original bug
      const promises = [
        deferredStorage.save('sameKey', { value: 1 }),
        deferredStorage.save('sameKey', { value: 2 }),
        deferredStorage.save('sameKey', { value: 3 }),
      ];

      await Promise.all(promises);

      // Last write wins (all in cache, no disk race)
      const result = await deferredStorage.load('sameKey');
      expect(result).toEqual({ value: 3 });

      // Only one write to disk after flush
      await deferredStorage.flush();
      expect(mockStorage.save).toHaveBeenCalledTimes(1);
      expect(mockStorage.save).toHaveBeenCalledWith('sameKey', { value: 3 });
    });
  });

  describe('getDirtyCount', () => {
    it('should track dirty entries', async () => {
      expect(deferredStorage.getDirtyCount()).toBe(0);

      await deferredStorage.save('key1', { value: 1 });
      expect(deferredStorage.getDirtyCount()).toBe(1);

      await deferredStorage.save('key2', { value: 2 });
      expect(deferredStorage.getDirtyCount()).toBe(2);

      await deferredStorage.flush();
      expect(deferredStorage.getDirtyCount()).toBe(0);
    });

    it('should include pending deletes in dirty count', async () => {
      mockStorage.data.set('toDelete', { value: 'x' });

      await deferredStorage.delete('toDelete');

      expect(deferredStorage.getDirtyCount()).toBe(1);
    });
  });

  describe('auto-flush', () => {
    it('should periodically flush dirty entries', async () => {
      deferredStorage.startAutoFlush();

      await deferredStorage.save('autoKey', { value: 'auto' });

      // Wait for auto-flush (interval is 100ms)
      await new Promise((r) => setTimeout(r, 150));

      expect(mockStorage.save).toHaveBeenCalledWith('autoKey', { value: 'auto' });
    });
  });

  describe('shutdown', () => {
    it('should flush all pending changes', async () => {
      await deferredStorage.save('shutdownKey', { value: 'flush-me' });

      await deferredStorage.shutdown();

      expect(mockStorage.save).toHaveBeenCalledWith('shutdownKey', { value: 'flush-me' });
    });
  });
});
