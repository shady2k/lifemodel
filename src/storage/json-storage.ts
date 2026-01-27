import { mkdir, readFile, writeFile, unlink, access, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Storage } from './storage.js';

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

  constructor(config: JSONStorageConfig) {
    this.basePath = config.basePath;
    this.createBackup = config.createBackup ?? true;
    this.extension = config.extension ?? '.json';
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
      throw error;
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
   */
  async loadWithFallback(key: string): Promise<unknown> {
    try {
      const data = await this.load(key);
      if (data !== null) {
        return data;
      }
    } catch {
      // Primary load failed, try backup
    }

    // Try backup
    const backupPath = this.getBackupPath(key);
    try {
      const content = await readFile(backupPath, 'utf-8');
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * Factory function for creating JSON storage.
 */
export function createJSONStorage(
  basePath: string,
  options?: Partial<JSONStorageConfig>
): JSONStorage {
  return new JSONStorage({
    basePath,
    ...options,
  });
}
