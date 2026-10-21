/**
 * The module's read-only view of the loader's settings document (ADR-014 D6).
 * Re-read the directory-mounted ConfigMap on each use, so kubelet updates need
 * no restart. Defaults are safe even before the loader can project settings.
 * Logs contain reason codes and counts only, never paths, values or errors.
 */
import { readFile } from 'node:fs/promises';
import type { LoaderLogger } from './logger.js';
import { platformSettings } from './settings/platform.js';

export const STORAGE_RETENTION_SETTINGS_PATH = '/opt/lifemodel/platform-settings/settings.json';

export interface StorageRetentionSettings {
  retention: '90d' | 'forever';
  warningLeadDays: number;
  revision: number;
}

export interface StorageRetentionSettingsReader {
  read(): Promise<StorageRetentionSettings>;
}

export function createStorageRetentionSettings(options: {
  path?: string;
  logger: Pick<LoaderLogger, 'warn'>;
}): StorageRetentionSettingsReader {
  const path = options.path ?? STORAGE_RETENTION_SETTINGS_PATH;
  const defaults = (): StorageRetentionSettings => ({
    retention: '90d',
    warningLeadDays: 7,
    revision: 0,
  });
  let loggedProblem: string | undefined;
  function report(code: string, count: number): void {
    const signature = `${code}:${String(count)}`;
    if (loggedProblem === signature) return;
    loggedProblem = signature;
    options.logger.warn({ code, count }, 'storage retention settings use declared defaults');
  }
  function fallback(code: string): StorageRetentionSettings {
    report(code, 1);
    return defaults();
  }
  return {
    read: async () => {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        return fallback(
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fallback('invalid_document');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return fallback('invalid_document');
      const document = parsed as Record<string, unknown>;
      const revision = document['revision'];
      const raw = document['values'];
      if (
        document['version'] !== 1 ||
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        typeof raw !== 'object' ||
        raw === null ||
        Array.isArray(raw)
      )
        return fallback('invalid_document');
      const values = raw as Record<string, unknown>;
      const result = { ...defaults(), revision };
      let invalidCount = 0;
      if (Object.hasOwn(values, 'storage.retention')) {
        const check = platformSettings.validate('storage.retention', values['storage.retention']);
        if (check.ok) result.retention = check.value as StorageRetentionSettings['retention'];
        else invalidCount += 1;
      }
      if (Object.hasOwn(values, 'storage.warningLeadDays')) {
        const check = platformSettings.validate(
          'storage.warningLeadDays',
          values['storage.warningLeadDays']
        );
        if (check.ok) result.warningLeadDays = check.value as number;
        else invalidCount += 1;
      }
      // The same document carries unrelated platform values. This reader
      // validates only the two values it uses and never logs untrusted keys.
      if (invalidCount > 0) report('invalid_value', invalidCount);
      else loggedProblem = undefined;
      return result;
    },
  };
}
