/**
 * The platform settings document on the loader's own volume (ADR-012 Decision
 * 5 shape, ADR-014 D6 content): one JSON file beside auth.json and
 * onboarding.json, written atomically, carrying a revision per change.
 *
 * A broken file never blocks the loader: a missing, unreadable, corrupt or
 * shape-invalid file - and every invalid value inside it - leaves the loader
 * running on the declarations' defaults, logs a safe reason without value
 * text, shows the problem in the settings section and keeps the bad file
 * aside instead of deleting it.
 *
 * The store projects every change through one narrow port; a failed
 * projection is recorded, shown and retried, never fatal.
 */
import { join } from 'node:path';
import type { Clock } from '../clock.js';
import type { FileSystem } from '../fs.js';
import type { LoaderConfig } from '../config.js';
import type { LoaderLogger } from '../logger.js';
import {
  type SettingRefusalCode,
  type SettingsRegistry,
  type SettingsSectionPayload,
} from './registry.js';

const FILE_MODE = 0o600;
const DOCUMENT_VERSION = 1;

export type SettingsProblemCode = 'unreadable' | 'corrupt' | SettingRefusalCode;

export interface SettingsProblem {
  code: SettingsProblemCode;
  /** The setting a per-value problem belongs to; absent for whole-file problems. */
  key?: string;
  /** Safe to show to the owner; the logs never carry it. */
  reason: string;
}

export type ProjectionOutcome =
  | { state: 'unattempted' }
  | { state: 'ok' }
  | { state: 'failed'; reason: string };

export interface StoredSettings {
  revision: number;
  values: Record<string, boolean | number | string>;
}

/** What the projection receives: effective non-secret values and the revision. */
export type SettingsProjectionContent = StoredSettings;

export interface SettingsProjection {
  project(content: SettingsProjectionContent): Promise<void>;
}

export type SettingsSectionSnapshot = SettingsSectionPayload;

/** A refused write: the declaration's own reason, safe to show. */
export class SettingsWriteError extends Error {
  constructor(
    readonly code: SettingRefusalCode | 'unknown_key',
    reason: string,
    readonly limit?: number
  ) {
    super(reason);
  }
}

export interface SettingsStore {
  /** Reads the volume; never throws. Call once before the store is served. */
  load(): Promise<void>;
  section(): SettingsSectionSnapshot;
  /** Validates through the registry, persists one value, then projects. */
  set(key: string, value: unknown): Promise<{ value: boolean | number | string; revision: number }>;
  /** One projection attempt; records the outcome, never throws. */
  projectNow(): Promise<void>;
}

export interface SettingsStoreDeps {
  fs: FileSystem;
  config: Pick<LoaderConfig, 'loaderDir'>;
  registry: SettingsRegistry;
  clock: Clock;
  logger: LoaderLogger;
  projection?: SettingsProjection;
}

interface StoredDocument {
  version?: unknown;
  revision?: unknown;
  values?: unknown;
}

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const { fs, config, registry, clock, logger } = deps;
  const path = join(config.loaderDir, 'settings.json');
  let stored: StoredSettings = { revision: 0, values: {} };
  let problems: SettingsProblem[] = [];
  let projection: ProjectionOutcome = { state: 'unattempted' };

  async function keepAside(): Promise<void> {
    let target = `${path}.invalid-${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.rename(path, target);
        return;
      } catch (error) {
        if (attempt >= 5) {
          logger.warn(
            { path, code: 'keep_aside_failed' },
            `platform settings file could not be kept aside: ${describe(error)}`
          );
          return;
        }
        target = `${path}.invalid-${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}-${String(attempt)}`;
      }
    }
  }

  function resetToDefaults(problem: SettingsProblem): void {
    stored = { revision: 0, values: {} };
    problems = [problem];
  }

  // One serial queue per store: a settings read-modify-write transaction -
  // validate, allocate the revision, write the file, project - never overlaps
  // another, and projection attempts run in submission order, so an older
  // attempt can neither overwrite a newer projection nor mark success after a
  // newer failure.
  let transactions: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = transactions.then(task, task);
    transactions = run.catch(() => undefined);
    return run;
  }

  return {
    load: async () => {
      problems = [];
      if (!(await fs.exists(path))) {
        stored = { revision: 0, values: {} };
        return;
      }
      let text: string;
      try {
        text = await fs.readFile(path);
      } catch (error) {
        problems = [
          {
            code: 'unreadable',
            reason: `the settings file could not be read (${describe(error)}); the defaults are in use`,
          },
        ];
        stored = { revision: 0, values: {} };
        await keepAside();
        logger.warn(
          { path, code: 'unreadable' },
          "platform settings file is unreadable; the declarations' defaults are in use"
        );
        return;
      }
      let document: StoredDocument;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error('not an object');
        document = parsed as StoredDocument;
        if (document.version !== DOCUMENT_VERSION || typeof document.values !== 'object')
          throw new Error('wrong shape');
        if (document.values === null || Array.isArray(document.values))
          throw new Error('wrong shape');
      } catch (error) {
        resetToDefaults({
          code: 'corrupt',
          reason: `the settings file is not a settings document this loader wrote (${describe(error)}); the defaults are in use`,
        });
        await keepAside();
        logger.warn(
          { path, code: 'corrupt' },
          "platform settings file is unusable; the declarations' defaults are in use"
        );
        return;
      }
      const values: Record<string, boolean | number | string> = {};
      problems = [];
      const raw = document.values as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        const check = registry.validate(key, value);
        if (check.ok) {
          values[key] = check.value;
          continue;
        }
        problems.push({ code: check.reasonCode, key, reason: check.reason });
        logger.warn({ key, code: check.reasonCode }, 'platform settings value is not usable');
      }
      stored = {
        revision:
          typeof document.revision === 'number' &&
          Number.isFinite(document.revision) &&
          document.revision >= 0
            ? Math.floor(document.revision)
            : 0,
        values,
      };
      if (problems.length > 0) {
        // Any per-value problem is a kept-aside reason, like a corrupt file:
        // the original bytes are the only repair copy, so move them aside
        // before a later write can overwrite them. Valid values stay
        // effective and a failed backup stays nonfatal.
        await keepAside();
        logger.warn(
          { path, code: 'kept_aside' },
          'platform settings file has values this loader refused; it is kept aside and the next change writes a fresh document'
        );
      }
    },
    section: () => {
      const values: Record<string, boolean | number | string> = {};
      for (const declaration of registry.declarations()) {
        if (declaration.control === 'secret') continue;
        const override = stored.values[declaration.key];
        values[declaration.key] = override ?? (declaration.default as boolean | number | string);
      }
      return {
        declarations: registry.declarations(),
        values,
        revision: stored.revision,
        problems,
        projection,
      };
    },
    set: (key, value) =>
      serialize(async () => {
        const check = registry.validate(key, value);
        if (!check.ok) throw new SettingsWriteError(check.reasonCode, check.reason, check.limit);
        const typed = check.value;
        // The revision is allocated inside the serial section, from the state
        // the previous transaction committed.
        const next: StoredSettings = {
          revision: stored.revision + 1,
          values: { ...stored.values, [key]: typed },
        };
        await fs.writeFileAtomic(path, `${JSON.stringify(document(next), null, 2)}\n`, FILE_MODE);
        stored = next;
        problems = problems.filter((problem) => problem.key !== key);
        await projectNow();
        return { value: typed, revision: next.revision };
      }),
    projectNow: () => serialize(() => projectNow()),
  };

  function document(state: StoredSettings): StoredDocument {
    return { version: DOCUMENT_VERSION, revision: state.revision, values: state.values };
  }

  /** One projection attempt over the current state; records the outcome, never throws. */
  async function projectNow(): Promise<void> {
    if (!deps.projection) {
      projection = { state: 'ok' };
      return;
    }
    const content: SettingsProjectionContent = {
      revision: stored.revision,
      values: { ...stored.values },
    };
    try {
      await deps.projection.project(content);
      projection = { state: 'ok' };
    } catch (error) {
      projection = { state: 'failed', reason: describe(error) };
      logger.warn(
        { code: 'projection_failed' },
        'the platform settings projection failed; it will be retried'
      );
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
