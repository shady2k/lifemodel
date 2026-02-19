import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { JSONStorage, migrateToHierarchical } from '../../../src/storage/json-storage.js';
import type { Logger } from '../../../src/types/index.js';

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

describe('JSONStorage — hierarchical keys', () => {
  let basePath: string;
  let storage: JSONStorage;
  let logger: Logger;

  beforeEach(async () => {
    basePath = join(tmpdir(), `json-storage-test-${randomUUID()}`);
    await mkdir(basePath, { recursive: true });
    logger = createMockLogger();
    storage = new JSONStorage({ basePath, logger, createBackup: false });
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  // --- Key validation ---

  describe('key validation', () => {
    it('rejects keys containing ..', async () => {
      await expect(storage.save('foo:..:..:etc:passwd', { x: 1 })).rejects.toThrow("contains '..'");
    });

    it('rejects keys with leading /', async () => {
      await expect(storage.save('/etc/passwd', { x: 1 })).rejects.toThrow('starts with path separator');
    });

    it('rejects keys with backslash', async () => {
      await expect(storage.save('foo\\bar', { x: 1 })).rejects.toThrow('contains backslash');
    });

    it('rejects keys with control characters', async () => {
      await expect(storage.save('foo\x00bar', { x: 1 })).rejects.toThrow('contains control characters');
    });
  });

  // --- Hierarchical path mapping ---

  describe('hierarchical path mapping', () => {
    it('maps colon-delimited key to nested directory path', async () => {
      await storage.save('plugin:calories:food:2026-02-19', { calories: 500 });

      const filePath = join(basePath, 'plugin', 'calories', 'food', '2026-02-19.json');
      const content = await readFile(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual({ calories: 500 });
    });

    it('keeps keys without colons in the root directory', async () => {
      await storage.save('memory', { entries: [] });

      const filePath = join(basePath, 'memory.json');
      const content = await readFile(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual({ entries: [] });
    });
  });

  // --- Save creates nested dirs ---

  describe('save', () => {
    it('creates nested directories as needed', async () => {
      await storage.save('a:b:c:d', { deep: true });

      const dirStat = await stat(join(basePath, 'a', 'b', 'c'));
      expect(dirStat.isDirectory()).toBe(true);
    });
  });

  // --- Load from nested path ---

  describe('load', () => {
    it('round-trips save then load for nested keys', async () => {
      const data = { name: 'test', items: [1, 2, 3] };
      await storage.save('plugin:news:state:src_123', data);

      const loaded = await storage.load('plugin:news:state:src_123');
      expect(loaded).toEqual(data);
    });

    it('returns null for non-existent nested key', async () => {
      const loaded = await storage.load('plugin:nonexistent:key');
      expect(loaded).toBeNull();
    });
  });

  // --- Keys returns colon-delimited ---

  describe('keys', () => {
    it('returns colon-delimited keys for nested files', async () => {
      await storage.save('memory', { entries: [] });
      await storage.save('plugin:calories:food:2026-02-19', { cal: 500 });
      await storage.save('plugin:calories:items', { items: [] });
      await storage.save('plugin:news:sources', { sources: [] });

      const keys = await storage.keys();
      expect(keys.sort()).toEqual([
        'memory',
        'plugin:calories:food:2026-02-19',
        'plugin:calories:items',
        'plugin:news:sources',
      ]);
    });

    it('excludes backup and tmp files', async () => {
      // Create a backup and tmp file manually
      await mkdir(join(basePath, 'plugin', 'calories'), { recursive: true });
      await writeFile(join(basePath, 'plugin', 'calories', 'items.json'), '{}');
      await writeFile(join(basePath, 'plugin', 'calories', 'items.backup.json'), '{}');
      await writeFile(join(basePath, 'plugin', 'calories', 'items.tmp.json'), '{}');

      const keys = await storage.keys();
      expect(keys).toEqual(['plugin:calories:items']);
    });

    it('returns empty array when basePath does not exist', async () => {
      const missingStorage = new JSONStorage({
        basePath: join(basePath, 'nonexistent'),
        logger,
      });
      const keys = await missingStorage.keys();
      expect(keys).toEqual([]);
    });
  });

  // --- Pattern matching ---

  describe('pattern matching', () => {
    it('filters keys by glob-style pattern', async () => {
      await storage.save('plugin:calories:food:2026-02-19', { c: 1 });
      await storage.save('plugin:calories:items', { c: 2 });
      await storage.save('plugin:news:sources', { c: 3 });

      const keys = await storage.keys('plugin:calories:*');
      expect(keys.sort()).toEqual([
        'plugin:calories:food:2026-02-19',
        'plugin:calories:items',
      ]);
    });
  });

  // --- Delete cleans up empty dirs ---

  describe('delete', () => {
    it('removes file and cleans up empty parent directories', async () => {
      await storage.save('plugin:calories:food:2026-02-19', { c: 1 });

      const deleted = await storage.delete('plugin:calories:food:2026-02-19');
      expect(deleted).toBe(true);

      // The nested dirs should be cleaned up
      await expect(stat(join(basePath, 'plugin', 'calories', 'food'))).rejects.toThrow();
      await expect(stat(join(basePath, 'plugin', 'calories'))).rejects.toThrow();
      await expect(stat(join(basePath, 'plugin'))).rejects.toThrow();
    });

    it('stops cleanup at non-empty parent directory', async () => {
      await storage.save('plugin:calories:food:2026-02-19', { c: 1 });
      await storage.save('plugin:calories:items', { c: 2 });

      await storage.delete('plugin:calories:food:2026-02-19');

      // plugin/calories/ should still exist because items.json is there
      const dirStat = await stat(join(basePath, 'plugin', 'calories'));
      expect(dirStat.isDirectory()).toBe(true);

      // But food/ subdir should be gone
      await expect(stat(join(basePath, 'plugin', 'calories', 'food'))).rejects.toThrow();
    });

    it('never removes basePath itself', async () => {
      await storage.save('solo', { x: 1 });
      await storage.delete('solo');

      const dirStat = await stat(basePath);
      expect(dirStat.isDirectory()).toBe(true);
    });

    it('returns false for non-existent key', async () => {
      const deleted = await storage.delete('nonexistent:key');
      expect(deleted).toBe(false);
    });
  });

  // --- Backup/tmp paths land in same directory ---

  describe('backup and temp paths', () => {
    it('creates backup in same directory as primary file', async () => {
      const storageWithBackup = new JSONStorage({ basePath, logger, createBackup: true });

      await storageWithBackup.save('plugin:calories:items', { v: 1 });
      await storageWithBackup.save('plugin:calories:items', { v: 2 });

      const backupPath = join(basePath, 'plugin', 'calories', 'items.backup.json');
      const content = await readFile(backupPath, 'utf-8');
      expect(JSON.parse(content)).toEqual({ v: 1 });
    });
  });

  // --- exists ---

  describe('exists', () => {
    it('returns true for existing nested key', async () => {
      await storage.save('a:b:c', { x: 1 });
      expect(await storage.exists('a:b:c')).toBe(true);
    });

    it('returns false for non-existing nested key', async () => {
      expect(await storage.exists('a:b:c')).toBe(false);
    });
  });
});

describe('migrateToHierarchical', () => {
  let basePath: string;
  let logger: Logger;

  beforeEach(async () => {
    basePath = join(tmpdir(), `json-migration-test-${randomUUID()}`);
    await mkdir(basePath, { recursive: true });
    logger = createMockLogger();
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  it('moves flat colon-files to nested directory structure', async () => {
    // Create flat files
    await writeFile(join(basePath, 'plugin:calories:food:2026-02-19.json'), '{"cal":500}');
    await writeFile(join(basePath, 'plugin:news:sources.json'), '{"src":[]}');

    await migrateToHierarchical(basePath, '.json', logger);

    // Flat files should be gone
    const remaining = await readdir(basePath);
    expect(remaining.filter((f) => f.includes(':'))).toEqual([]);

    // Nested files should exist
    const content1 = await readFile(
      join(basePath, 'plugin', 'calories', 'food', '2026-02-19.json'),
      'utf-8'
    );
    expect(JSON.parse(content1)).toEqual({ cal: 500 });

    const content2 = await readFile(join(basePath, 'plugin', 'news', 'sources.json'), 'utf-8');
    expect(JSON.parse(content2)).toEqual({ src: [] });
  });

  it('also migrates .backup.json files', async () => {
    await writeFile(join(basePath, 'plugin:calories:items.backup.json'), '{"v":1}');

    await migrateToHierarchical(basePath, '.json', logger);

    const content = await readFile(
      join(basePath, 'plugin', 'calories', 'items.backup.json'),
      'utf-8'
    );
    expect(JSON.parse(content)).toEqual({ v: 1 });
  });

  it('skips collision when target exists with different size', async () => {
    // Create both flat and nested
    await writeFile(join(basePath, 'plugin:items.json'), '{"flat":true,"extra":"data"}');
    await mkdir(join(basePath, 'plugin'), { recursive: true });
    await writeFile(join(basePath, 'plugin', 'items.json'), '{"nested":true}');

    await migrateToHierarchical(basePath, '.json', logger);

    // Flat file should still exist (skipped)
    const flatContent = await readFile(join(basePath, 'plugin:items.json'), 'utf-8');
    expect(flatContent).toContain('flat');

    // Nested file should be unchanged
    const nestedContent = await readFile(join(basePath, 'plugin', 'items.json'), 'utf-8');
    expect(nestedContent).toContain('nested');

    // Warning logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'plugin:items.json' }),
      expect.stringContaining('collision')
    );
  });

  it('removes flat file when collision has identical size', async () => {
    const content = '{"same":true}';
    await writeFile(join(basePath, 'plugin:items.json'), content);
    await mkdir(join(basePath, 'plugin'), { recursive: true });
    await writeFile(join(basePath, 'plugin', 'items.json'), content);

    await migrateToHierarchical(basePath, '.json', logger);

    // Flat file should be gone
    await expect(stat(join(basePath, 'plugin:items.json'))).rejects.toThrow();

    // Nested file should still exist
    const nestedContent = await readFile(join(basePath, 'plugin', 'items.json'), 'utf-8');
    expect(nestedContent).toBe(content);
  });

  it('is idempotent — running twice causes no errors', async () => {
    await writeFile(join(basePath, 'plugin:calories:items.json'), '{"v":1}');

    await migrateToHierarchical(basePath, '.json', logger);
    await migrateToHierarchical(basePath, '.json', logger);

    const content = await readFile(
      join(basePath, 'plugin', 'calories', 'items.json'),
      'utf-8'
    );
    expect(JSON.parse(content)).toEqual({ v: 1 });
  });

  it('is a no-op when directory is already hierarchical', async () => {
    await mkdir(join(basePath, 'plugin', 'calories'), { recursive: true });
    await writeFile(join(basePath, 'plugin', 'calories', 'items.json'), '{"v":1}');
    await writeFile(join(basePath, 'memory.json'), '{}');

    await migrateToHierarchical(basePath, '.json', logger);

    // No log output since nothing migrated
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('handles non-existent basePath gracefully', async () => {
    const missingPath = join(basePath, 'does-not-exist');
    await migrateToHierarchical(missingPath, '.json', logger);
    // No error thrown
  });

  it('leaves non-colon files in place', async () => {
    await writeFile(join(basePath, 'memory.json'), '{}');
    await writeFile(join(basePath, 'plugin:items.json'), '{"v":1}');

    await migrateToHierarchical(basePath, '.json', logger);

    // memory.json stays in root
    const rootFiles = await readdir(basePath);
    expect(rootFiles).toContain('memory.json');
  });
});
