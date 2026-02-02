import { mkdir, readFile, writeFile, unlink, access, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
 * JSON file-based storage implementation.
 *
 * Features:
 * - Atomic writes (temp file + rename)
 * - Optional backup before overwrite
 * - Automatic directory creation
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
    return join(this.basePath, `${key}${this.extension}`);
  }

  /**
   * Get the backup path for a key.
   */
  private getBackupPath(key: string): string {
    return join(this.basePath, `${key}.backup${this.extension}`);
  }

  /**
   * Get the temp path for atomic writes.
   */
  private getTempPath(key: string): string {
    return join(this.basePath, `${key}.tmp${this.extension}`);
  }

  /**
   * Ensure the base directory exists.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
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
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
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
      const files = await readdir(this.basePath);
      let keys = files
        .filter((f) => f.endsWith(this.extension) && !f.includes('.backup') && !f.includes('.tmp'))
        .map((f) => f.slice(0, -this.extension.length));

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
