import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  access,
  rename,
  readdir,
  rmdir,
  stat,
} from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import type { Storage } from './storage.js';
import type { Logger } from '../types/logger.js';

/**
 * Configuration for JSONStorage.
 */
export interface JSONStorageConfig {
  /** Base directory for storage files */
  basePath: string;
  /** Create backup before overwriting (default: true) */
  createBackup?: boolean;
  /** File extension (default: '.json') */
  extension?: string;
  /** Logger for warnings/errors (optional) */
  logger?: Logger;
}

/**
 * Validate a storage key to prevent path traversal attacks.
 * Throws on invalid keys.
 */
function validateKey(key: string, basePath: string): void {
  if (key.includes('..')) {
    throw new Error(`Invalid storage key: contains '..': ${key}`);
  }
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new Error(`Invalid storage key: starts with path separator: ${key}`);
  }
  if (key.includes('\\')) {
    throw new Error(`Invalid storage key: contains backslash: ${key}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(key)) {
    throw new Error(`Invalid storage key: contains control characters: ${key}`);
  }
  // Verify resolved path stays under basePath
  const converted = key.replace(/:/g, '/');
  const resolved = resolve(basePath, converted);
  if (!resolved.startsWith(resolve(basePath))) {
    throw new Error(`Invalid storage key: resolves outside base path: ${key}`);
  }
}

/**
 * Convert a colon-delimited key to a filesystem path segment.
 */
function keyToPath(key: string): string {
  return key.replace(/:/g, '/');
}

/**
 * JSON file-based storage implementation.
 *
 * Features:
 * - Atomic writes (temp file + rename)
 * - Optional backup before overwrite
 * - Automatic directory creation
 * - Hierarchical key mapping (`:` → `/` in filesystem)
 */
export class JSONStorage implements Storage {
  private readonly basePath: string;
  private readonly createBackup: boolean;
  private readonly extension: string;
  private readonly logger: Logger | undefined;

  constructor(config: JSONStorageConfig) {
    this.basePath = config.basePath;
    this.createBackup = config.createBackup ?? true;
    this.extension = config.extension ?? '.json';
    this.logger = config.logger;
  }

  /**
   * Get the full path for a key.
   */
  private getPath(key: string): string {
    validateKey(key, this.basePath);
    return join(this.basePath, `${keyToPath(key)}${this.extension}`);
  }

  /**
   * Get the backup path for a key.
   */
  private getBackupPath(key: string): string {
    validateKey(key, this.basePath);
    return join(this.basePath, `${keyToPath(key)}.backup${this.extension}`);
  }

  /**
   * Get the temp path for atomic writes.
   */
  private getTempPath(key: string): string {
    validateKey(key, this.basePath);
    return join(this.basePath, `${keyToPath(key)}.tmp${this.extension}`);
  }

  /**
   * Ensure the base directory exists.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  /**
   * Ensure the parent directory of a file path exists.
   */
  private async ensureParentDir(filePath: string): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
  }

  async load(key: string): Promise<unknown> {
    const path = this.getPath(key);

    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      // Try self-healing for JSON syntax errors
      if (error instanceof SyntaxError) {
        const recovered = await this.tryRecoverCorruptedFile(key, path);
        if (recovered !== null) {
          return recovered;
        }

        // Recovery failed, try backup
        const backup = await this.loadBackup(key);
        if (backup !== null) {
          this.logger?.warn({ key }, 'Loaded from backup after corruption recovery failed');
          return backup;
        }
      }

      throw error;
    }
  }

  /**
   * Try to recover data from a corrupted JSON file.
   * Handles the }{ concatenation pattern from race conditions.
   */
  private async tryRecoverCorruptedFile(key: string, path: string): Promise<unknown> {
    try {
      const content = await readFile(path, 'utf-8');

      // Look for }{ pattern (two JSON objects concatenated)
      const corruptionIdx = content.indexOf('}{');
      if (corruptionIdx === -1) {
        // Try }]{ pattern (array end + new object)
        const arrayCorruptionIdx = content.indexOf(']{');
        if (arrayCorruptionIdx === -1) {
          this.logger?.error({ key }, 'Cannot find corruption pattern for recovery');
          return null;
        }
        // Truncate after the ]
        const truncated = content.slice(0, arrayCorruptionIdx + 1) + '}';
        return await this.parseAndSaveRecovered(key, path, content, truncated);
      }

      // Truncate at }{ keeping the first }
      const truncated = content.slice(0, corruptionIdx + 1);
      return await this.parseAndSaveRecovered(key, path, content, truncated);
    } catch {
      return null;
    }
  }

  /**
   * Parse recovered content and save it back to fix the file.
   */
  private async parseAndSaveRecovered(
    key: string,
    path: string,
    originalContent: string,
    truncatedContent: string
  ): Promise<unknown> {
    try {
      const data = JSON.parse(truncatedContent) as unknown;

      // Save corrupted file for debugging
      const corruptedPath = path + '.corrupted';
      await writeFile(corruptedPath, originalContent, 'utf-8');

      // Save recovered data back to original path (atomic write)
      await this.save(key, data);

      this.logger?.warn(
        {
          key,
          originalSize: originalContent.length,
          recoveredSize: truncatedContent.length,
          bytesLost: originalContent.length - truncatedContent.length,
          corruptedBackup: corruptedPath,
        },
        'Self-healed corrupted JSON file'
      );

      return data;
    } catch {
      this.logger?.error({ key }, 'Failed to parse recovered content');
      return null;
    }
  }

  /**
   * Load from backup file.
   */
  private async loadBackup(key: string): Promise<unknown> {
    const backupPath = this.getBackupPath(key);
    try {
      const content = await readFile(backupPath, 'utf-8');
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  }

  async save(key: string, data: unknown): Promise<void> {
    await this.ensureDir();

    const path = this.getPath(key);
    const tempPath = this.getTempPath(key);
    const backupPath = this.getBackupPath(key);

    // Ensure parent directory exists for nested keys
    await this.ensureParentDir(tempPath);

    // Serialize data
    const content = JSON.stringify(data, null, 2);

    // Write to temp file first (atomic write preparation)
    await writeFile(tempPath, content, 'utf-8');

    // Create backup if file exists and backup is enabled
    if (this.createBackup && (await this.exists(key))) {
      try {
        await rename(path, backupPath);
      } catch {
        // Ignore backup errors - continue with save
      }
    }

    // Atomic rename of temp file to actual path
    await rename(tempPath, path);
  }

  async delete(key: string): Promise<boolean> {
    const path = this.getPath(key);

    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }

    // Clean up empty parent directories up to basePath
    await this.cleanupEmptyDirs(dirname(path));

    return true;
  }

  /**
   * Walk up parent directories, removing empty ones until basePath.
   */
  private async cleanupEmptyDirs(dir: string): Promise<void> {
    const resolvedBase = resolve(this.basePath);
    let current = resolve(dir);

    while (current !== resolvedBase && current.startsWith(resolvedBase)) {
      try {
        await rmdir(current);
        current = dirname(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'ENOENT') {
          break;
        }
        this.logger?.debug({ dir: current, error }, 'Error cleaning up directory');
        break;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    const path = this.getPath(key);

    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async keys(pattern?: string): Promise<string[]> {
    try {
      const files = await readdir(this.basePath, { recursive: true });
      let keys = files
        .filter((f) => f.endsWith(this.extension) && !f.includes('.backup') && !f.includes('.tmp'))
        .map((f) => {
          // Normalize path separators to colons and strip extension
          const withoutExt = f.slice(0, -this.extension.length);
          return withoutExt.replace(/[/\\]/g, ':');
        });

      if (pattern) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        keys = keys.filter((k) => regex.test(k));
      }

      return keys;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Load from backup if primary file is corrupted.
   * Note: load() now includes self-healing, so this is mainly for explicit backup loading.
   */
  async loadWithFallback(key: string): Promise<unknown> {
    try {
      const data = await this.load(key);
      if (data !== null) {
        return data;
      }
    } catch {
      // Primary load failed (including self-healing), try backup
    }

    return this.loadBackup(key);
  }
}

/**
 * Factory function for creating JSON storage.
 */
export function createJSONStorage(
  basePath: string,
  options?: Partial<Omit<JSONStorageConfig, 'basePath'>>
): JSONStorage {
  return new JSONStorage({
    basePath,
    ...options,
  });
}

/**
 * Migrate flat colon-delimited files to hierarchical directory structure.
 *
 * Scans basePath (non-recursively) for files with `:` in their name and moves
 * them to the corresponding nested directory path. Safe to call on every startup —
 * returns immediately if no flat colon-files exist.
 */
export async function migrateToHierarchical(
  basePath: string,
  _extension: string,
  logger?: Logger
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(basePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // No state dir yet — nothing to migrate
    }
    throw error;
  }

  // Filter for files with colons (candidates for migration)
  const colonFiles = files.filter((f) => f.includes(':'));
  if (colonFiles.length === 0) {
    return; // Fast path: nothing to migrate
  }

  let migrated = 0;
  let skipped = 0;

  for (const file of colonFiles) {
    // Process both primary and backup files
    const isTmp = file.includes('.tmp');
    if (isTmp) continue; // Skip temp files

    const targetRelative = file.replace(/:/g, '/');
    const sourcePath = join(basePath, file);
    const targetPath = join(basePath, targetRelative);

    // Verify source is actually a file (not a directory that somehow has : in name)
    try {
      const srcStat = await stat(sourcePath);
      if (!srcStat.isFile()) continue;
    } catch {
      continue;
    }

    // Collision check
    try {
      const targetStat = await stat(targetPath);
      // Target exists — check if same size
      const srcStat = await stat(sourcePath);
      if (targetStat.size === srcStat.size) {
        // Same size: assume duplicate, delete the flat file
        await unlink(sourcePath);
        migrated++;
      } else {
        logger?.warn(
          {
            source: file,
            target: targetRelative,
            sourceSize: srcStat.size,
            targetSize: targetStat.size,
          },
          'Migration collision: flat and nested files differ, skipping'
        );
        skipped++;
      }
      continue;
    } catch {
      // Target doesn't exist — proceed with move
    }

    // Create target directory and move
    await mkdir(dirname(targetPath), { recursive: true });
    await rename(sourcePath, targetPath);
    migrated++;
  }

  if (migrated > 0 || skipped > 0) {
    logger?.info(
      { migrated, skipped },
      'Storage migration: flat files moved to hierarchical structure'
    );
  }
}
