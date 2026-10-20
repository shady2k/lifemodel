import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestLogger, recordingLogger, type RecordedLog } from '../helpers/test-logger.js';
import {
  createPlatformSettingsReader,
  PLATFORM_SETTINGS_FILE,
  platformSettingSpecs,
  validatePlatformValue,
  type PlatformSettingsValues,
} from '../../src/config/platform-settings.js';
import { platformSettings } from '../../loader/src/settings/platform.js';

const defaults: PlatformSettingsValues = {
  'tasks.concurrency': 2,
  'tasks.harness': 'opencode',
  'tasks.wrapGraceSeconds': 300,
  'storage.retention': '90d',
  'storage.warningLeadSeconds': 604800,
  'storage.ceilingBytes': 20000000000,
};

function document(revision: number, values: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, revision, values });
}

describe('core platform settings reader', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function directory(): string {
    const root = mkdtempSync(join(tmpdir(), 'platform-settings-'));
    roots.push(root);
    return root;
  }
  function readerFor(
    dir: string,
    calls: RecordedLog[]
  ): ReturnType<typeof createPlatformSettingsReader> {
    return createPlatformSettingsReader({
      dir,
      logger: recordingLogger(createTestLogger('silent'), calls),
    });
  }
  const warnings = (calls: RecordedLog[]) => calls.filter((line) => line.level === 'warn');

  it('reads the revision and the valid values from the projected file', async () => {
    const calls: RecordedLog[] = [];
    const dir = directory();
    writeFileSync(
      join(dir, PLATFORM_SETTINGS_FILE),
      document(7, {
        'tasks.concurrency': 3,
        'tasks.harness': 'prime-agent',
        'tasks.wrapGraceSeconds': 600,
        'storage.retention': 'forever',
        'storage.warningLeadSeconds': 1209600,
        'storage.ceilingBytes': 20000000000,
      })
    );
    const settings = await readerFor(dir, calls).read();
    expect(settings).toEqual({
      revision: 7,
      values: {
        'tasks.concurrency': 3,
        'tasks.harness': 'prime-agent',
        'tasks.wrapGraceSeconds': 600,
        'storage.retention': 'forever',
        'storage.warningLeadSeconds': 1209600,
        'storage.ceilingBytes': 20000000000,
      },
    });
    expect(warnings(calls)).toEqual([]);
  });

  it('serves the declaration defaults when nothing is projected yet', async () => {
    const calls: RecordedLog[] = [];
    const settings = await readerFor(directory(), calls).read();
    expect(settings).toEqual({ revision: 0, values: defaults });
    expect(calls.some((line) => line.level === 'info' && line.obj.code === 'missing')).toBe(true);
  });

  it.each([
    ['not json', '{ not json'],
    ['an array', '[1,2]'],
    ['a wrong version', JSON.stringify({ version: 2, revision: 1, values: {} })],
    ['a missing values object', JSON.stringify({ version: 1, revision: 1 })],
    ['a non-object values', JSON.stringify({ version: 1, revision: 1, values: [1] })],
    ['a negative revision', JSON.stringify({ version: 1, revision: -1, values: {} })],
  ])('falls back to the defaults for %s and logs one safe reason', async (_name, text) => {
    const calls: RecordedLog[] = [];
    const dir = directory();
    writeFileSync(join(dir, PLATFORM_SETTINGS_FILE), text);
    const settings = await readerFor(dir, calls).read();
    expect(settings).toEqual({ revision: 0, values: defaults });
    expect(warnings(calls)).toHaveLength(1);
    expect(warnings(calls)[0]?.obj.code).toBe('corrupt');
  });

  it('falls back to the defaults when the file cannot be read', async () => {
    const calls: RecordedLog[] = [];
    const dir = directory();
    const file = join(dir, PLATFORM_SETTINGS_FILE);
    writeFileSync(file, document(1, {}));
    chmodSync(file, 0o000);
    try {
      const settings = await readerFor(dir, calls).read();
      expect(settings).toEqual({ revision: 0, values: defaults });
      expect(warnings(calls)[0]?.obj.code).toBe('unreadable');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('keeps valid values, falls back per refused value and names the key safely', async () => {
    const calls: RecordedLog[] = [];
    const dir = directory();
    writeFileSync(
      join(dir, PLATFORM_SETTINGS_FILE),
      document(3, {
        'tasks.concurrency': 4,
        'tasks.harness': 'codex',
        'tasks.wrapGraceSeconds': 29,
        'storage.made.up': true,
      })
    );
    const settings = await readerFor(dir, calls).read();
    expect(settings).toEqual({
      revision: 3,
      values: {
        ...defaults,
        'tasks.concurrency': 4,
      },
    });
    const refused = warnings(calls).map((line) => [line.obj.key, line.obj.reasonCode]);
    expect(refused).toEqual([
      ['tasks.harness', 'not_an_option'],
      ['tasks.wrapGraceSeconds', 'below_minimum'],
      ['storage.made.up', 'unknown_key'],
    ]);
  });

  it('picks up a projected change on the next read, without a restart', async () => {
    const calls: RecordedLog[] = [];
    const dir = directory();
    const file = join(dir, PLATFORM_SETTINGS_FILE);
    const reader = readerFor(dir, calls);
    await expect(reader.read()).resolves.toEqual({ revision: 0, values: defaults });
    writeFileSync(file, document(1, { 'tasks.harness': 'prime-agent' }));
    await expect(reader.read()).resolves.toEqual({
      revision: 1,
      values: { ...defaults, 'tasks.harness': 'prime-agent' },
    });
    writeFileSync(
      file,
      document(2, { 'tasks.harness': 'prime-agent', 'storage.retention': 'forever' })
    );
    await expect(reader.read()).resolves.toEqual({
      revision: 2,
      values: { ...defaults, 'tasks.harness': 'prime-agent', 'storage.retention': 'forever' },
    });
  });

  it('does not repeat the same problem on every read', async () => {
    const calls: RecordedLog[] = [];
    const dir = directory();
    writeFileSync(join(dir, PLATFORM_SETTINGS_FILE), '{ not json');
    const reader = readerFor(dir, calls);
    await reader.read();
    await reader.read();
    await reader.read();
    expect(warnings(calls)).toHaveLength(1);
    writeFileSync(
      join(dir, PLATFORM_SETTINGS_FILE),
      document(5, { 'tasks.wrapGraceSeconds': 3601 })
    );
    await reader.read();
    expect(warnings(calls)).toHaveLength(2);
    expect(warnings(calls)[1]?.obj.reasonCode).toBe('above_maximum');
  });

  it('never writes a value into a log line', async () => {
    const calls: RecordedLog[] = [];
    const dir = directory();
    writeFileSync(
      join(dir, PLATFORM_SETTINGS_FILE),
      document(3, { 'tasks.harness': 'codex', 'storage.warningLeadSeconds': 7 })
    );
    await readerFor(dir, calls).read();
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('codex');
    expect(serialized).toContain('storage.warningLeadSeconds');
  });
});

describe('core reader parity with the loader registry', () => {
  // The loader's platform.ts is the single declaration site (ADR-014 D6).
  // The core validates the projection with its own table, because the core
  // image builds only from src/; this contract pins the two together, so a
  // declaration the core has not learned fails here.
  it('declares exactly the keys of the loader registry, in order', () => {
    expect(platformSettingSpecs.map((spec) => spec.key)).toEqual(
      platformSettings.declarations().map((declaration) => declaration.key)
    );
  });

  it.each(platformSettings.declarations().map((declaration) => [declaration.key] as const))(
    'declares %s with the same default, bounds and options as the loader registry',
    (key) => {
      const declaration = platformSettings.get(key);
      const spec = platformSettingSpecs.find((candidate) => candidate.key === key);
      expect(declaration).toBeDefined();
      expect(spec).toBeDefined();
      expect(spec?.default).toEqual(declaration?.default);
      if (declaration?.control === 'number') {
        expect(spec).toMatchObject({ kind: 'number', min: declaration.min, max: declaration.max });
      }
      if (declaration?.control === 'select') {
        expect(spec).toMatchObject({
          kind: 'select',
          options: declaration.options?.map((option) => option.value),
        });
      }
    }
  );

  const corpus: readonly unknown[] = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    -1,
    2.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    'x',
    'opencode',
    'prime-agent',
    'codex',
    '90d',
    'forever',
    '0',
    [],
    {},
    29,
    300,
    3601,
    86400,
    604800,
    2592001,
    20000000000,
    20000000001,
  ];

  it.each(platformSettings.declarations().map((declaration) => [declaration.key] as const))(
    'validates every corpus value of %s with the same verdict as the loader registry',
    (key) => {
      for (const value of corpus) {
        const loader = platformSettings.validate(key, value);
        const core = validatePlatformValue(key, value);
        expect([key, value, core.ok]).toEqual([key, value, loader.ok]);
        if (loader.ok) expect([key, core.value]).toEqual([key, loader.value]);
        else expect([key, core.reasonCode]).toEqual([key, loader.reasonCode]);
      }
    }
  );
});
