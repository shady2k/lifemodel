/**
 * Storage Primitive Tests
 *
 * Tests for the plugin storage primitive with namespace isolation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createStoragePrimitive,
  type StoragePrimitiveImpl,
} from '../../../src/core/storage-primitive.js';
import type { Storage } from '../../../src/storage/storage.js';

describe('StoragePrimitive', () => {
  let mockStorage: Storage;
  let storagePrimitive: StoragePrimitiveImpl;
  const pluginId = 'test.plugin';
  const mockLogger = {
    child: vi.fn(() => mockLogger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    level: 'debug',
  } as unknown as import('../../../src/types/logger.js').Logger;

  beforeEach(() => {
    const data: Record<string, unknown> = {};

    mockStorage = {
      load: vi.fn(async (key: string) => data[key] ?? null),
      save: vi.fn(async (key: string, value: unknown) => {
        data[key] = value;
      }),
      delete: vi.fn(async (key: string) => {
        const existed = key in data;
        delete data[key];
        return existed;
      }),
      exists: vi.fn(async (key: string) => key in data),
      keys: vi.fn(async (pattern?: string) => {
        const allKeys = Object.keys(data);
        if (!pattern) return allKeys;
        const prefix = pattern.replace('*', '');
        return allKeys.filter((k) => k.startsWith(prefix));
      }),
    };

    storagePrimitive = createStoragePrimitive(mockStorage, pluginId, mockLogger);
  });

  describe('namespace isolation', () => {
    it('should prefix keys with plugin namespace', async () => {
      await storagePrimitive.set('myKey', { value: 123 });

      expect(mockStorage.save).toHaveBeenCalledWith(
        `plugin:${pluginId}:myKey`,
        { value: 123 }
      );
    });

    it('should load with namespaced key', async () => {
      await mockStorage.save(`plugin:${pluginId}:myKey`, { value: 456 });

      const result = await storagePrimitive.get<{ value: number }>('myKey');

      expect(result).toEqual({ value: 456 });
    });

    it('should strip namespace from key listing', async () => {
      await mockStorage.save(`plugin:${pluginId}:key1`, 'a');
      await mockStorage.save(`plugin:${pluginId}:key2`, 'b');
      await mockStorage.save('other:key3', 'c'); // Different namespace

      const keys = await storagePrimitive.keys();

      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).not.toContain('key3');
    });
  });

  describe('CRUD operations', () => {
    it('should set and get values', async () => {
      await storagePrimitive.set('test', { foo: 'bar' });
      const result = await storagePrimitive.get<{ foo: string }>('test');

      expect(result).toEqual({ foo: 'bar' });
    });

    it('should return null for non-existent keys', async () => {
      const result = await storagePrimitive.get('nonexistent');

      expect(result).toBeNull();
    });

    it('should delete keys', async () => {
      await storagePrimitive.set('toDelete', 'value');
      const deleted = await storagePrimitive.delete('toDelete');
      const result = await storagePrimitive.get('toDelete');

      expect(deleted).toBe(true);
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent key', async () => {
      const deleted = await storagePrimitive.delete('nonexistent');

      expect(deleted).toBe(false);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await storagePrimitive.set('users/1', { id: 1, name: 'Alice', createdAt: '2024-01-01' });
      await storagePrimitive.set('users/2', { id: 2, name: 'Bob', createdAt: '2024-01-02' });
      await storagePrimitive.set('users/3', { id: 3, name: 'Charlie', createdAt: '2024-01-03' });
      await storagePrimitive.set('settings/theme', { dark: true });
    });

    it('should query by prefix', async () => {
      const results = await storagePrimitive.query<{ id: number; name: string }>({
        prefix: 'users/',
      });

      expect(results).toHaveLength(3);
    });

    it('should respect limit', async () => {
      const results = await storagePrimitive.query<{ id: number }>({
        prefix: 'users/',
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    it('should apply filter', async () => {
      const results = await storagePrimitive.query<{ id: number; name: string }>({
        prefix: 'users/',
        filter: (v) => (v as { id: number }).id > 1,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.id > 1)).toBe(true);
    });
  });

  describe('clear', () => {
    it('should clear all plugin data', async () => {
      await storagePrimitive.set('key1', 'value1');
      await storagePrimitive.set('key2', 'value2');

      await storagePrimitive.clear();

      const keys = await storagePrimitive.keys();
      expect(keys).toHaveLength(0);
    });
  });
});
