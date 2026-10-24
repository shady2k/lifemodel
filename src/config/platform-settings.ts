import {
  DEFAULT_TASK_HARNESS,
  TASK_HARNESS_NAMES,
  type TaskHarnessName,
} from '../ports/task-harness-names.js';
/**
 * The core's read-only view of the platform settings (ADR-014 D6, T10): the
 * loader projects the owner's values into the `lifemodel-platform-settings`
 * ConfigMap, the pod mounts it read-only, and this reader parses
 * `settings.json` - `{"version":1,"revision":N,"values":{...}}` - and
 * validates every value against the platform declarations. A missing,
 * unreadable, corrupt or shape-invalid projection - and every invalid value
 * inside it - falls back to the declaration's default with a safe log; the
 * core never crashes on the projection and never writes it: it holds no
 * ConfigMap RBAC and no API token.
 *
 * The file is re-read on every `read()`: the kubelet refreshes the mounted
 * ConfigMap volume in the background, so a loader-side change reaches the
 * next read without a core restart.
 *
 * The core image builds only from `src/`, so the declarations are mirrored
 * here as a small spec table; the contract tests in
 * `tests/unit/platform-settings-reader.test.ts` pin the table to the loader's
 * `platformSettings` registry - keys, defaults, bounds, options and verdicts
 * - so the two cannot drift.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../types/logger.js';

/** Where the platform mounts the settings projection into the core pod. */
export const PLATFORM_SETTINGS_DIR = '/opt/lifemodel/platform-settings';

/** The projected document inside the mount, beside the loader's own name for it. */
export const PLATFORM_SETTINGS_FILE = 'settings.json';

const DOCUMENT_VERSION = 1;

export type TaskHarness = TaskHarnessName;
export type StorageRetention = '90d' | 'forever';

/** The effective platform values, typed per declaration. */
export interface PlatformSettingsValues {
  'tasks.concurrency': number;
  'tasks.harness': TaskHarness;
  'tasks.wrapGraceSeconds': number;
  'tasks.channel.maxFrameBytes': number;
  'tasks.channel.maxUnackedFrames': number;
  'tasks.channel.maxUnackedBytes': number;
  'tasks.channel.maxBufferedBytes': number;
  'tasks.channel.ackTimeoutMs': number;
  'tasks.channel.workers': number;
  'tasks.channel.sqlConnections': number;
  'storage.retention': StorageRetention;
  'storage.warningLeadDays': number;
  'storage.ceilingBytes': number;
}

export interface PlatformSettings {
  /** The loader-side revision the projection carried; 0 when nothing is projected. */
  readonly revision: number;
  readonly values: PlatformSettingsValues;
}

/** Why a projected value was refused - the loader registry's own codes. */
export type PlatformRefusalCode =
  | 'unknown_key'
  | 'wrong_type'
  | 'below_minimum'
  | 'above_maximum'
  | 'not_an_option'
  | 'read_only';

export type PlatformValueCheck =
  | { ok: true; value: number | string }
  | { ok: false; reasonCode: PlatformRefusalCode; reason: string; limit?: number };

/** The declarations' defaults, typed by the same keys the effective values use. */
const PLATFORM_SETTING_DEFAULTS = {
  'tasks.concurrency': 2,
  'tasks.harness': DEFAULT_TASK_HARNESS,
  'tasks.wrapGraceSeconds': 300,
  'tasks.channel.maxFrameBytes': 65_536,
  'tasks.channel.maxUnackedFrames': 16,
  'tasks.channel.maxUnackedBytes': 1_048_576,
  'tasks.channel.maxBufferedBytes': 4_194_304,
  'tasks.channel.ackTimeoutMs': 5_000,
  'tasks.channel.workers': 2,
  'tasks.channel.sqlConnections': 2,
  'storage.retention': '90d',
  'storage.warningLeadDays': 7,
  'storage.ceilingBytes': 20_000_000_000,
} as const satisfies PlatformSettingsValues;

interface NumberSpec {
  readonly kind: 'number';
  readonly key: keyof PlatformSettingsValues;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
  /** A fixed value: the loader refuses every write, so it is never projected. */
  readonly readOnly?: boolean;
}

interface SelectSpec {
  readonly kind: 'select';
  readonly key: keyof PlatformSettingsValues;
  readonly default: string;
  readonly options: readonly string[];
  /** A fixed value: the loader refuses every write, so it is never projected. */
  readonly readOnly?: boolean;
}

type PlatformSettingSpec = NumberSpec | SelectSpec;

/**
 * The mirror of the loader's platform declarations, in the same order; the
 * defaults come from the typed defaults above, so a key cannot exist in one
 * and not the other. Only number and select declarations exist in the
 * platform scope today; a new control kind in
 * `loader/src/settings/platform.ts` fails the contract tests until the
 * mirror learns it.
 */
export const platformSettingSpecs: readonly PlatformSettingSpec[] = [
  {
    kind: 'number',
    key: 'tasks.concurrency',
    default: PLATFORM_SETTING_DEFAULTS['tasks.concurrency'],
    min: 1,
    max: 8,
  },
  {
    kind: 'select',
    key: 'tasks.harness',
    default: PLATFORM_SETTING_DEFAULTS['tasks.harness'],
    options: TASK_HARNESS_NAMES,
  },
  {
    kind: 'number',
    key: 'tasks.wrapGraceSeconds',
    default: PLATFORM_SETTING_DEFAULTS['tasks.wrapGraceSeconds'],
    min: 30,
    max: 3600,
  },
  {
    kind: 'number',
    key: 'tasks.channel.maxFrameBytes',
    default: PLATFORM_SETTING_DEFAULTS['tasks.channel.maxFrameBytes'],
    integer: true,
    min: 1,
    max: 65_536,
  },
  {
    kind: 'number',
    key: 'tasks.channel.maxUnackedFrames',
    default: PLATFORM_SETTING_DEFAULTS['tasks.channel.maxUnackedFrames'],
    integer: true,
    min: 1,
    max: 16,
  },
  {
    kind: 'number',
    key: 'tasks.channel.maxUnackedBytes',
    default: PLATFORM_SETTING_DEFAULTS['tasks.channel.maxUnackedBytes'],
    integer: true,
    min: 1,
    max: 1_048_576,
  },
  {
    kind: 'number',
    key: 'tasks.channel.maxBufferedBytes',
    default: PLATFORM_SETTING_DEFAULTS['tasks.channel.maxBufferedBytes'],
    integer: true,
    min: 1,
    max: 4_194_304,
  },
  {
    kind: 'number',
    key: 'tasks.channel.ackTimeoutMs',
    default: PLATFORM_SETTING_DEFAULTS['tasks.channel.ackTimeoutMs'],
    integer: true,
    min: 1,
    max: 5_000,
  },
  {
    kind: 'number',
    key: 'tasks.channel.workers',
    default: PLATFORM_SETTING_DEFAULTS['tasks.channel.workers'],
    integer: true,
    min: 1,
    max: 2,
  },
  {
    kind: 'number',
    key: 'tasks.channel.sqlConnections',
    default: PLATFORM_SETTING_DEFAULTS['tasks.channel.sqlConnections'],
    integer: true,
    min: 1,
    max: 2,
  },
  {
    kind: 'select',
    key: 'storage.retention',
    default: PLATFORM_SETTING_DEFAULTS['storage.retention'],
    options: ['90d', 'forever'],
  },
  {
    kind: 'number',
    key: 'storage.warningLeadDays',
    default: PLATFORM_SETTING_DEFAULTS['storage.warningLeadDays'],
    integer: true,
    min: 1,
    max: 30,
  },
  {
    kind: 'number',
    key: 'storage.ceilingBytes',
    default: PLATFORM_SETTING_DEFAULTS['storage.ceilingBytes'],
    min: 20_000_000_000,
    max: 20_000_000_000,
    readOnly: true,
  },
];

const specsByKey = new Map<string, PlatformSettingSpec>(
  platformSettingSpecs.map((spec) => [spec.key, spec])
);

/** The value check behind the core's reads, with the loader registry's codes. */
export function validatePlatformValue(key: string, value: unknown): PlatformValueCheck {
  const spec = specsByKey.get(key);
  if (spec === undefined)
    return { ok: false, reasonCode: 'unknown_key', reason: `unknown platform setting "${key}"` };
  if (spec.readOnly)
    return {
      ok: false,
      reasonCode: 'read_only',
      reason: `${key} is fixed; it cannot be changed`,
    };
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return { ok: false, reasonCode: 'wrong_type', reason: `${key} expects a number` };
    if (spec.integer && !Number.isSafeInteger(value))
      return { ok: false, reasonCode: 'wrong_type', reason: `${key} expects an integer` };
    if (value < spec.min)
      return {
        ok: false,
        reasonCode: 'below_minimum',
        reason: `value ${String(value)} is below the declared minimum ${String(spec.min)}`,
        limit: spec.min,
      };
    if (value > spec.max)
      return {
        ok: false,
        reasonCode: 'above_maximum',
        reason: `value ${String(value)} is above the declared maximum ${String(spec.max)}`,
        limit: spec.max,
      };
    return { ok: true, value };
  }
  if (typeof value !== 'string')
    return { ok: false, reasonCode: 'wrong_type', reason: `${key} expects a string` };
  if (!spec.options.includes(value))
    return {
      ok: false,
      reasonCode: 'not_an_option',
      reason: `value ${JSON.stringify(value)} is not one of the declared options of ${key}`,
    };
  return { ok: true, value };
}

export interface PlatformSettingsReader {
  /** Reads the projection now; never throws; the defaults on any problem. */
  read(): Promise<PlatformSettings>;
}

export interface PlatformSettingsReaderDeps {
  logger: Logger;
  /** The mounted projection directory; the pod's mount point in production. */
  dir?: string;
}

interface ProjectedDocument {
  version?: unknown;
  revision?: unknown;
  values?: unknown;
}

export function createPlatformSettingsReader(
  deps: PlatformSettingsReaderDeps
): PlatformSettingsReader {
  const dir = deps.dir ?? PLATFORM_SETTINGS_DIR;
  const logger = deps.logger.child({ component: 'platform-settings' });
  const file = join(dir, PLATFORM_SETTINGS_FILE);
  const defaultValues = (): PlatformSettingsValues => ({ ...PLATFORM_SETTING_DEFAULTS });

  // The mount is re-read per use; without a change the same state must not
  // log again, so a steady projection stays quiet at any read rate.
  let loggedSignature: string | null = null;

  interface LogLine {
    level: 'info' | 'warn';
    code: string;
    key?: string | undefined;
    reasonCode?: string | undefined;
    msg: string;
  }
  function logOnce(signature: string, lines: LogLine[]): void {
    if (signature === loggedSignature) return;
    loggedSignature = signature;
    for (const line of lines) {
      const fields: Record<string, unknown> = { code: line.code };
      if (line.key !== undefined) fields['key'] = line.key;
      if (line.reasonCode !== undefined) fields['reasonCode'] = line.reasonCode;
      logger[line.level](fields, line.msg);
    }
  }

  function fallback(
    signature: string,
    code: string,
    msg: string,
    level: 'info' | 'warn' = 'warn'
  ): PlatformSettings {
    logOnce(signature, [{ level, code, msg }]);
    return { revision: 0, values: defaultValues() };
  }

  return {
    read: async () => {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return fallback(
            'missing',
            'missing',
            'the platform settings are not projected yet; the declared defaults are in use',
            'info'
          );
        return fallback(
          'unreadable',
          'unreadable',
          'the platform settings file could not be read; the declared defaults are in use'
        );
      }
      let document: ProjectedDocument;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error('not an object');
        document = parsed as ProjectedDocument;
        if (document.version !== DOCUMENT_VERSION || typeof document.values !== 'object')
          throw new Error('wrong shape');
        if (document.values === null || Array.isArray(document.values))
          throw new Error('wrong shape');
        if (
          typeof document.revision !== 'number' ||
          !Number.isFinite(document.revision) ||
          document.revision < 0
        )
          throw new Error('wrong revision');
      } catch {
        return fallback(
          'corrupt',
          'corrupt',
          'the platform settings file is not a document this loader projects; the declared defaults are in use'
        );
      }
      const revision = Math.floor(document.revision);
      const values: PlatformSettingsValues = { ...defaultValues() };
      const refused: { key?: string; reasonCode: PlatformRefusalCode }[] = [];
      for (const [key, raw] of Object.entries(document.values as Record<string, unknown>)) {
        const check = validatePlatformValue(key, raw);
        if (!check.ok) {
          // A key is logged only when the declarations know it: an unknown key
          // is untrusted file text, so its refusal carries the code alone.
          refused.push(
            specsByKey.has(key)
              ? { key, reasonCode: check.reasonCode }
              : { reasonCode: check.reasonCode }
          );
          continue;
        }
        // The key's spec typed the check, so the value fits the key's kind.
        Object.assign(values, { [key]: check.value });
      }
      const signature = `r${String(revision)}|${refused
        .map((problem) => `${problem.key ?? 'unknown'}:${problem.reasonCode}`)
        .sort()
        .join(',')}`;
      if (refused.length > 0)
        logOnce(
          signature,
          refused.map((problem) => ({
            level: 'warn' as const,
            code: 'invalid_value',
            key: problem.key,
            reasonCode: problem.reasonCode,
            msg: 'the platform settings carry a value this core refuses; the key uses the declared default',
          }))
        );
      else
        logOnce(signature, [
          { level: 'info', code: 'current', msg: 'the platform settings are read' },
        ]);
      return { revision, values };
    },
  };
}
