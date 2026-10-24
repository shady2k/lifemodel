import { TASK_HARNESS_NAMES } from '../../src/ports/task-harness-names.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import {
  createSettingsRegistry,
  SettingsDeclarationError,
  type SettingDeclaration,
} from '../../loader/src/settings/registry.js';
import { platformSettings } from '../../loader/src/settings/platform.js';
import {
  createSettingsStore,
  SettingsWriteError,
  type SettingsHttp,
} from '../../loader/src/settings/store.js';
import { createKubernetesSettingsProjection } from '../../loader/src/settings/projection.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createTestClock, systemClock } from '../../loader/src/clock.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { createLoaderHttp } from '../../loader/src/http.js';
import { createLoaderApp } from '../../loader/src/app.js';
import { loadConfig } from '../../loader/src/config.js';
import { createSession, csrfToken, hashPassword } from '../../loader/src/auth.js';
import type { LoaderState } from '../../loader/src/state.js';

const concurrency: SettingDeclaration = {
  key: 'tasks.concurrency',
  section: 'tasks',
  label: {
    en: 'Concurrent tasks',
    ru: '\u041f\u0430\u0440\u0430\u043b\u043b\u0435\u043b\u044c\u043d\u044b\u0435 \u0437\u0430\u0434\u0430\u0447\u0438',
  },
  description: {
    en: 'How many tasks may run at the same time.',
    ru: '\u0421\u043a\u043e\u043b\u044c\u043a\u043e \u0437\u0430\u0434\u0430\u0447 \u043c\u043e\u0433\u0443\u0442 \u0432\u044b\u043f\u043e\u043b\u043d\u044f\u0442\u044c\u0441\u044f \u043e\u0434\u043d\u043e\u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 2,
  min: 1,
  max: 8,
  authority: 'owner',
  apply: 'nextAdmission',
};

const other: SettingDeclaration = {
  key: 'tasks.other',
  section: 'tasks',
  label: { en: 'Other tasks', ru: 'Другие задачи' },
  description: { en: 'A second number setting.', ru: 'Вторая числовая настройка.' },
  control: 'number',
  dataClass: 'publicConfig',
  default: 5,
  min: 1,
  max: 8,
  authority: 'owner',
  apply: 'nextAdmission',
};

const enabled: SettingDeclaration = {
  key: 'tasks.enabled',
  section: 'tasks',
  label: { en: 'Enabled', ru: 'Включено' },
  description: { en: 'Whether tasks run.', ru: 'Запускаются ли задачи.' },
  control: 'toggle',
  dataClass: 'publicConfig',
  default: true,
  authority: 'owner',
  apply: 'nextAdmission',
};

describe('settings declaration registry', () => {
  it('registers a declaration and enumerates it', () => {
    const registry = createSettingsRegistry([concurrency]);
    expect(registry.declarations()).toHaveLength(1);
    expect(registry.get('tasks.concurrency')).toEqual(concurrency);
  });

  it('refuses a duplicate key', () => {
    expect(() => createSettingsRegistry([concurrency, concurrency])).toThrow(
      new SettingsDeclarationError('duplicate setting key "tasks.concurrency"')
    );
  });

  it('refuses an unknown key when validating a value', () => {
    const registry = createSettingsRegistry([concurrency]);
    const result = registry.validate('no.such.key', 3);
    expect(result).toMatchObject({ ok: false, reasonCode: 'unknown_key' });
    expect(result.ok === false && result.reason).toContain('no.such.key');
  });

  it("refuses a wrong type with the declaration's reason", () => {
    const registry = createSettingsRegistry([concurrency]);
    const result = registry.validate('tasks.concurrency', 'many');
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'wrong_type',
    });
    expect(result.ok === false && result.reason).toContain('tasks.concurrency');
  });

  it('refuses out-of-bounds values with the declared bounds', () => {
    const registry = createSettingsRegistry([concurrency]);
    const below = registry.validate('tasks.concurrency', 0);
    expect(below).toMatchObject({ ok: false, reasonCode: 'below_minimum', limit: 1 });
    const above = registry.validate('tasks.concurrency', 9);
    expect(above).toMatchObject({ ok: false, reasonCode: 'above_maximum', limit: 8 });
    expect(above.ok === false && above.reason).toContain('8');
  });

  it('accepts a valid value', () => {
    const registry = createSettingsRegistry([concurrency]);
    expect(registry.validate('tasks.concurrency', 4)).toEqual({ ok: true, value: 4 });
  });

  it('refuses a select value outside the declared options', () => {
    const registry = createSettingsRegistry([
      {
        key: 'tasks.harness',
        section: 'tasks',
        label: { en: 'Harness', ru: 'Harness' },
        description: { en: 'Which harness runs a task.', ru: 'Which harness runs a task.' },
        control: 'select',
        dataClass: 'publicConfig',
        default: 'opencode',
        options: [{ value: 'opencode', label: { en: 'OpenCode', ru: 'OpenCode' } }],
        authority: 'owner',
        apply: 'nextAdmission',
      },
    ]);
    expect(registry.validate('tasks.harness', 'vim')).toMatchObject({
      ok: false,
      reasonCode: 'not_an_option',
    });
  });

  it('refuses to set a secret: set, delete and exists only, no value path', () => {
    const registry = createSettingsRegistry([
      {
        key: 'tasks.token',
        section: 'tasks',
        label: { en: 'Token', ru: 'Token' },
        description: { en: 'A secret.', ru: 'A secret.' },
        control: 'secret',
        dataClass: 'secretAuthenticator',
        authority: 'owner',
        apply: 'immediate',
      },
    ]);
    const declaration = registry.get('tasks.token');
    expect(declaration).toBeDefined();
    expect(declaration && 'default' in declaration && declaration.default !== undefined).toBe(
      false
    );
    const result = registry.validate('tasks.token', 'hush');
    expect(result).toMatchObject({ ok: false, reasonCode: 'secret_setting' });
    expect(result.ok === false && result.reason).toContain('OpenBao');
    // No value of a secret is ever held or read back by the registry.
    expect(registry.declarations().every((d) => d.control !== 'secret' || !('default' in d))).toBe(
      true
    );
  });

  it('refuses a secret declared with a default', () => {
    expect(() =>
      createSettingsRegistry([
        {
          key: 'tasks.token',
          section: 'tasks',
          label: { en: 'Token', ru: 'Token' },
          description: { en: 'A secret.', ru: 'A secret.' },
          control: 'secret',
          dataClass: 'secretAuthenticator',
          default: 'hush',
          authority: 'owner',
          apply: 'immediate',
        },
      ])
    ).toThrow(new SettingsDeclarationError('a secret setting must not declare a default'));
  });

  it.each([
    ['', 'key'],
    ['Tasks', 'key'],
    ['tasks..concurrency', 'key'],
  ])('refuses the malformed key %j', (key) => {
    expect(() => createSettingsRegistry([{ ...concurrency, key }])).toThrow(
      SettingsDeclarationError
    );
  });

  it('refuses a select declaration without options or with a default outside them', () => {
    const base = {
      key: 'tasks.harness',
      section: 'tasks',
      label: { en: 'Harness', ru: 'Harness' },
      description: { en: 'Which harness.', ru: 'Which harness.' },
      control: 'select',
      dataClass: 'publicConfig',
      authority: 'owner',
      apply: 'nextAdmission',
    } satisfies SettingDeclaration;
    expect(() => createSettingsRegistry([{ ...base, default: 'opencode' }])).toThrow(
      SettingsDeclarationError
    );
    expect(() =>
      createSettingsRegistry([
        {
          ...base,
          default: 'vim',
          options: [{ value: 'opencode', label: { en: 'OpenCode', ru: 'OpenCode' } }],
        },
      ])
    ).toThrow(SettingsDeclarationError);
  });

  it('registers a toggle with a boolean default, true or false, and validates boolean values', () => {
    expect(() => createSettingsRegistry([enabled])).not.toThrow();
    expect(() => createSettingsRegistry([{ ...enabled, default: false }])).not.toThrow();
    const registry = createSettingsRegistry([enabled]);
    expect(registry.validate('tasks.enabled', true)).toEqual({ ok: true, value: true });
    expect(registry.validate('tasks.enabled', false)).toEqual({ ok: true, value: false });
    expect(registry.validate('tasks.enabled', 'true')).toMatchObject({
      ok: false,
      reasonCode: 'wrong_type',
    });
  });

  it('refuses a toggle declared with a non-boolean default', () => {
    expect(() => createSettingsRegistry([{ ...enabled, default: 'yes' }])).toThrow(
      new SettingsDeclarationError('tasks.enabled: a toggle declares a boolean default')
    );
    expect(() => createSettingsRegistry([{ ...enabled, default: 1 }])).toThrow(
      SettingsDeclarationError
    );
    expect(() =>
      createSettingsRegistry([{ ...enabled, default: undefined } as SettingDeclaration])
    ).toThrow(SettingsDeclarationError);
  });

  it('refuses a number declaration whose default or bounds contradict each other', () => {
    expect(() => createSettingsRegistry([{ ...concurrency, default: 20 }])).toThrow(
      SettingsDeclarationError
    );
    expect(() => createSettingsRegistry([{ ...concurrency, min: 8, max: 1 }])).toThrow(
      SettingsDeclarationError
    );
  });

  it('carries a localized unit on a number declaration, en and ru', () => {
    const wrapGrace = platformSettings.get('tasks.wrapGraceSeconds');
    expect(wrapGrace?.unit).toEqual({ en: 'seconds', ru: 'секунды' });
    expect(() =>
      createSettingsRegistry([{ ...concurrency, unit: { en: 'tasks', ru: '' } }])
    ).toThrow(SettingsDeclarationError);
    expect(() =>
      createSettingsRegistry([{ ...concurrency, unit: { en: '', ru: 'задачи' } }])
    ).toThrow(SettingsDeclarationError);
  });

  it('declares the platform tasks.concurrency setting: number 1..8, default 2, section tasks', () => {
    const declaration = platformSettings.get('tasks.concurrency');
    expect(declaration).toMatchObject({
      key: 'tasks.concurrency',
      section: 'tasks',
      control: 'number',
      default: 2,
      min: 1,
      max: 8,
      unit: { en: 'tasks', ru: 'задачи' },
      authority: 'owner',
      apply: 'nextAdmission',
    });
    expect(declaration?.label.en).toBeTruthy();
    expect(declaration?.label.ru).toBeTruthy();
    expect(declaration?.description.en).toBeTruthy();
    expect(declaration?.description.ru).toBeTruthy();
  });

  it('declares the task harness as a select of the two adapters, defaulting to opencode', () => {
    const harness = platformSettings.get('tasks.harness');
    expect(harness).toMatchObject({
      key: 'tasks.harness',
      section: 'tasks',
      control: 'select',
      dataClass: 'publicConfig',
      default: 'opencode',
      authority: 'owner',
      apply: 'nextAdmission',
    });
    expect(harness?.options?.map((option) => option.value)).toEqual(TASK_HARNESS_NAMES);
    expect(harness?.options?.every((option) => option.label.en && option.label.ru)).toBe(true);
    expect(platformSettings.validate('tasks.harness', TASK_HARNESS_NAMES[0])).toEqual({
      ok: true,
      value: TASK_HARNESS_NAMES[0],
    });
    expect(platformSettings.validate('tasks.harness', 'codex')).toMatchObject({
      ok: false,
      reasonCode: 'not_an_option',
    });
  });

  it('declares the soft-stop grace in seconds, 30..3600, default 300', () => {
    const wrapGrace = platformSettings.get('tasks.wrapGraceSeconds');
    expect(wrapGrace).toMatchObject({
      key: 'tasks.wrapGraceSeconds',
      section: 'tasks',
      control: 'number',
      dataClass: 'publicConfig',
      default: 300,
      min: 30,
      max: 3600,
      unit: { en: 'seconds', ru: 'секунды' },
      authority: 'owner',
      apply: 'nextAdmission',
    });
    expect(platformSettings.validate('tasks.wrapGraceSeconds', 29)).toMatchObject({
      ok: false,
      reasonCode: 'below_minimum',
      limit: 30,
    });
    expect(platformSettings.validate('tasks.wrapGraceSeconds', 3601)).toMatchObject({
      ok: false,
      reasonCode: 'above_maximum',
      limit: 3600,
    });
    expect(platformSettings.validate('tasks.wrapGraceSeconds', 600)).toEqual({
      ok: true,
      value: 600,
    });
  });

  it('declares the output retention as an enum, never 0, default 90 days', () => {
    const retention = platformSettings.get('storage.retention');
    expect(retention).toMatchObject({
      key: 'storage.retention',
      section: 'tasks',
      control: 'select',
      dataClass: 'publicConfig',
      default: '90d',
      authority: 'owner',
      apply: 'immediate',
    });
    expect(retention?.options?.map((option) => option.value)).toEqual(['90d', 'forever']);
    // Forever is an enum value of its own, never a 0 number (ADR-014 D6).
    expect(platformSettings.validate('storage.retention', 0)).toMatchObject({
      ok: false,
      reasonCode: 'wrong_type',
    });
    expect(platformSettings.validate('storage.retention', '0')).toMatchObject({
      ok: false,
      reasonCode: 'not_an_option',
    });
    expect(platformSettings.validate('storage.retention', 'forever')).toEqual({
      ok: true,
      value: 'forever',
    });
  });

  it('declares the deletion warning lead in days, one to thirty, default seven', () => {
    const warningLead = platformSettings.get('storage.warningLeadDays');
    expect(warningLead).toMatchObject({
      key: 'storage.warningLeadDays',
      section: 'tasks',
      control: 'number',
      dataClass: 'publicConfig',
      default: 7,
      min: 1,
      max: 30,
      unit: { en: 'days', ru: 'дни' },
      authority: 'owner',
      apply: 'immediate',
    });
    // The owner never sees a raw second count: the value is whole days.
    expect(platformSettings.validate('storage.warningLeadDays', 0)).toMatchObject({
      ok: false,
      reasonCode: 'below_minimum',
      limit: 1,
    });
    expect(platformSettings.validate('storage.warningLeadDays', 31)).toMatchObject({
      ok: false,
      reasonCode: 'above_maximum',
      limit: 30,
    });
    expect(platformSettings.validate('storage.warningLeadDays', 7)).toEqual({
      ok: true,
      value: 7,
    });
  });

  it('declares the storage ceiling read-only, displayed as decimal bytes', () => {
    const ceiling = platformSettings.get('storage.ceilingBytes');
    expect(ceiling).toMatchObject({
      key: 'storage.ceilingBytes',
      section: 'tasks',
      control: 'number',
      dataClass: 'publicConfig',
      default: 20_000_000_000,
      min: 20_000_000_000,
      max: 20_000_000_000,
      unit: { en: 'bytes', ru: 'байты' },
      format: 'bytes',
      readOnly: true,
      authority: 'owner',
      apply: 'immediate',
    });
    // The registry refuses every write, the fixed value included; the display
    // format is a bytes count, so a screen shows 20 GB instead of a raw digit
    // string.
    expect(platformSettings.validate('storage.ceilingBytes', 20_000_000_000)).toMatchObject({
      ok: false,
      reasonCode: 'read_only',
    });
    expect(platformSettings.validate('storage.ceilingBytes', 40_000_000_000)).toMatchObject({
      ok: false,
      reasonCode: 'read_only',
    });
  });

  it('refuses a bytes display format outside a number control', () => {
    expect(() => createSettingsRegistry([{ ...concurrency, format: 'bytes' }])).not.toThrow();
    expect(() =>
      createSettingsRegistry([{ ...enabled, format: 'bytes' } as SettingDeclaration])
    ).toThrow(SettingsDeclarationError);
    expect(() =>
      createSettingsRegistry([{ ...secretDeclaration, format: 'bytes' } as SettingDeclaration])
    ).toThrow(SettingsDeclarationError);
  });

  it('refuses every write to a read-only declaration, the default included', () => {
    const registry = createSettingsRegistry([fixed]);
    expect(registry.validate('tasks.fixed', 6)).toMatchObject({
      ok: false,
      reasonCode: 'read_only',
    });
    expect(registry.validate('tasks.fixed', 5)).toMatchObject({
      ok: false,
      reasonCode: 'read_only',
    });
    expect(registry.validate('tasks.fixed', 'five')).toMatchObject({
      ok: false,
      reasonCode: 'read_only',
    });
    expect(
      registry.validate('tasks.fixed', 5).ok === false && registry.validate('tasks.fixed', 5).reason
    ).toContain('tasks.fixed');
  });

  it('refuses a read-only declaration on a secret and a non-boolean readOnly', () => {
    expect(() => createSettingsRegistry([{ ...secretDeclaration, readOnly: true }])).toThrow(
      new SettingsDeclarationError('a read-only secret cannot exist: a secret is never read')
    );
    expect(() =>
      createSettingsRegistry([{ ...fixed, readOnly: 'yes' } as SettingDeclaration])
    ).toThrow(SettingsDeclarationError);
  });

  it('carries English and Russian labels and descriptions on every platform declaration', () => {
    for (const declaration of platformSettings.declarations()) {
      for (const language of ['en', 'ru'] as const) {
        expect(declaration.label[language].trim()).not.toBe('');
        expect(declaration.description[language].trim()).not.toBe('');
      }
    }
  });

  it('keeps every platform declaration in the one generated tasks section', () => {
    expect(platformSettings.declarations().length).toBeGreaterThan(0);
    expect(
      platformSettings.declarations().every((declaration) => declaration.section === 'tasks')
    ).toBe(true);
  });
});

const fixed: SettingDeclaration = {
  key: 'tasks.fixed',
  section: 'tasks',
  label: { en: 'Fixed', ru: 'Фиксировано' },
  description: { en: 'A fixed value.', ru: 'Фиксированное значение.' },
  control: 'number',
  dataClass: 'publicConfig',
  default: 5,
  min: 1,
  max: 8,
  authority: 'owner',
  apply: 'immediate',
  readOnly: true,
};

const secretDeclaration: SettingDeclaration = {
  key: 'tasks.token',
  section: 'tasks',
  label: { en: 'Token', ru: 'Токен' },
  description: { en: 'A secret.', ru: 'Секрет.' },
  control: 'secret',
  dataClass: 'secretAuthenticator',
  authority: 'owner',
  apply: 'immediate',
};

describe('settings file store', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function storeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'settings-store-'));
    mkdirSync(join(root, 'loader'), { recursive: true });
    roots.push(root);
    return root;
  }
  const settingsPath = (root: string) => join(root, 'loader', 'settings.json');
  function createStore(
    root: string,
    options: {
      declarations?: SettingDeclaration[];
      readFile?: (path: string) => Promise<string>;
      rename?: (from: string, to: string) => Promise<void>;
      projection?: { project(): Promise<void> };
    } = {}
  ) {
    const lines: RecordedLine[] = [];
    let fs = createNodeFileSystem();
    if (options.readFile) fs = { ...fs, readFile: (path: string) => options.readFile!(path) };
    if (options.rename)
      fs = { ...fs, rename: (from: string, to: string) => options.rename!(from, to) };
    const store = createSettingsStore({
      fs,
      config: { loaderDir: join(root, 'loader') },
      registry: createSettingsRegistry(options.declarations ?? [concurrency, secretDeclaration]),
      clock: createTestClock(),
      logger: createRecordingLogger(lines),
      ...(options.projection ? { projection: options.projection } : {}),
    });
    return { store, lines };
  }

  it('normally a valid value stores with a new revision and reads back', async () => {
    const root = storeRoot();
    const { store } = createStore(root);
    await store.load();
    const written = await store.set('tasks.concurrency', 3);
    expect(written).toEqual({ value: 3, revision: 1 });
    const section = store.section();
    expect(section.values['tasks.concurrency']).toBe(3);
    expect(section.revision).toBe(1);
    expect(JSON.parse(readFileSync(settingsPath(root), 'utf8'))).toEqual({
      version: 1,
      revision: 1,
      values: { 'tasks.concurrency': 3 },
    });
  });

  it('stores a toggle write as a boolean and reads it back', async () => {
    const root = storeRoot();
    const { store } = createStore(root, {
      declarations: [concurrency, enabled, secretDeclaration],
    });
    await store.load();
    await expect(store.set('tasks.enabled', false)).resolves.toEqual({ value: false, revision: 1 });
    expect(JSON.parse(readFileSync(settingsPath(root), 'utf8'))).toEqual({
      version: 1,
      revision: 1,
      values: { 'tasks.enabled': false },
    });
    expect(store.section().values['tasks.enabled']).toBe(false);
    await expect(store.set('tasks.enabled', 'on')).rejects.toMatchObject({ code: 'wrong_type' });
  });

  it('the value survives re-creating the store over the same store', async () => {
    const root = storeRoot();
    const first = createStore(root);
    await first.store.load();
    await first.store.set('tasks.concurrency', 5);
    const second = createStore(root);
    await second.store.load();
    expect(second.store.section().values['tasks.concurrency']).toBe(5);
    expect(second.store.section().revision).toBe(1);
  });

  it('continues the revision stored in the file', async () => {
    const root = storeRoot();
    writeFileSync(
      settingsPath(root),
      JSON.stringify({ version: 1, revision: 41, values: { 'tasks.concurrency': 2 } })
    );
    const { store } = createStore(root);
    await store.load();
    expect(store.section().revision).toBe(41);
    const written = await store.set('tasks.concurrency', 4);
    expect(written.revision).toBe(42);
  });

  it('a corrupt file is kept aside with a timestamp, the defaults are used and the problem is shown', async () => {
    const root = storeRoot();
    const broken = '{ not json';
    writeFileSync(settingsPath(root), broken);
    const renames: Array<[string, string]> = [];
    const { store, lines } = createStore(root, {
      rename: async (from, to) => {
        renames.push([from, to]);
        await createNodeFileSystem().rename(from, to);
      },
    });
    await store.load();
    expect(store.section().values['tasks.concurrency']).toBe(2);
    expect(store.section().revision).toBe(0);
    expect(store.section().problems).toHaveLength(1);
    expect(store.section().problems[0]?.code).toBe('corrupt');
    expect(
      readdirSync(join(root, 'loader')).some((name) => name.startsWith('settings.json.invalid-'))
    ).toBe(true);
    const kept = readdirSync(join(root, 'loader')).find((name) =>
      name.startsWith('settings.json.invalid-')
    )!;
    expect(readFileSync(join(root, 'loader', kept), 'utf8')).toBe(broken);
    expect(readdirSync(join(root, 'loader'))).not.toContain('settings.json');
    expect(lines.some((line) => line.level === 'warn' && line.fields.code === 'corrupt')).toBe(
      true
    );
    // And the loader keeps working: a write starts a fresh document.
    const written = await store.set('tasks.concurrency', 3);
    expect(written.revision).toBe(1);
  });

  it('an unreadable file does not block the loader: defaults are used and the problem is shown', async () => {
    const root = storeRoot();
    writeFileSync(settingsPath(root), JSON.stringify({ version: 1, revision: 7, values: {} }));
    const renames: Array<[string, string]> = [];
    const { store } = createStore(root, {
      readFile: (path) => {
        if (path === settingsPath(root)) {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return createNodeFileSystem().readFile(path);
      },
      rename: async (from, to) => {
        renames.push([from, to]);
      },
    });
    await store.load();
    expect(store.section().values['tasks.concurrency']).toBe(2);
    expect(store.section().problems[0]?.code).toBe('unreadable');
    expect(renames).toHaveLength(1);
    await expect(store.set('tasks.concurrency', 3)).resolves.toMatchObject({ revision: 1 });
  });

  it('a value of the wrong type is dropped with a problem and valid values are kept', async () => {
    const root = storeRoot();
    writeFileSync(
      settingsPath(root),
      JSON.stringify({ version: 1, revision: 3, values: { 'tasks.concurrency': 'many' } })
    );
    const { store, lines } = createStore(root);
    await store.load();
    expect(store.section().values['tasks.concurrency']).toBe(2);
    expect(store.section().revision).toBe(3);
    expect(store.section().problems).toEqual([
      {
        code: 'wrong_type',
        key: 'tasks.concurrency',
        reason: expect.stringContaining('tasks.concurrency'),
      },
    ]);
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });

  it('an unknown key in the file is dropped with a problem', async () => {
    const root = storeRoot();
    writeFileSync(
      settingsPath(root),
      JSON.stringify({
        version: 1,
        revision: 2,
        values: { 'tasks.concurrency': 2, 'tasks.made.up': true },
      })
    );
    const { store } = createStore(root);
    await store.load();
    expect(store.section().values['tasks.concurrency']).toBe(2);
    expect(store.section().problems).toEqual([
      {
        code: 'unknown_key',
        key: 'tasks.made.up',
        reason: expect.stringContaining('tasks.made.up'),
      },
    ]);
  });

  it('a secret value in the file is dropped with a problem: no read path exists', async () => {
    const root = storeRoot();
    writeFileSync(
      settingsPath(root),
      JSON.stringify({ version: 1, revision: 1, values: { 'tasks.token': 'hush' } })
    );
    const { store } = createStore(root);
    await store.load();
    expect(store.section().values['tasks.token']).toBeUndefined();
    expect(store.section().problems).toEqual([
      { code: 'secret_setting', key: 'tasks.token', reason: expect.stringContaining('OpenBao') },
    ]);
  });

  it('an out-of-bounds value in the file falls back to the default with a problem', async () => {
    const root = storeRoot();
    writeFileSync(
      settingsPath(root),
      JSON.stringify({ version: 1, revision: 1, values: { 'tasks.concurrency': 99 } })
    );
    const { store } = createStore(root);
    await store.load();
    expect(store.section().values['tasks.concurrency']).toBe(2);
    expect(store.section().problems[0]).toMatchObject({
      code: 'above_maximum',
      key: 'tasks.concurrency',
    });
  });

  it('a file with a per-value problem is kept aside before a later write can overwrite it', async () => {
    const root = storeRoot();
    const original = JSON.stringify({
      version: 1,
      revision: 7,
      values: { 'tasks.concurrency': 3, 'tasks.other': 99, 'tasks.made.up': 1 },
    });
    writeFileSync(settingsPath(root), original);
    const { store } = createStore(root, {
      declarations: [concurrency, other, secretDeclaration],
    });
    await store.load();
    // Valid values stay effective; the refused ones show as problems.
    expect(store.section().values['tasks.concurrency']).toBe(3);
    expect(store.section().values['tasks.other']).toBe(5);
    expect(store.section().problems.map((problem) => problem.code)).toEqual([
      'above_maximum',
      'unknown_key',
    ]);
    // The original document is preserved beside the store, untouched.
    const directory = readdirSync(join(root, 'loader'));
    const kept = directory.filter((name) => name.startsWith('settings.json.invalid-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(root, 'loader', kept[0]!), 'utf8')).toBe(original);
    expect(directory).not.toContain('settings.json');
    // A later successful PUT writes a fresh document and leaves the repair copy alone.
    await expect(store.set('tasks.concurrency', 4)).resolves.toMatchObject({ revision: 8 });
    expect(JSON.parse(readFileSync(settingsPath(root), 'utf8'))).toEqual({
      version: 1,
      revision: 8,
      values: { 'tasks.concurrency': 4 },
    });
    expect(
      readdirSync(join(root, 'loader')).some((name) => name.startsWith('settings.json.invalid-'))
    ).toBe(true);
  });

  it('a failed keep-aside of a value-invalid file is nonfatal: the problem is shown and the loader keeps working', async () => {
    const root = storeRoot();
    writeFileSync(
      settingsPath(root),
      JSON.stringify({ version: 1, revision: 7, values: { 'tasks.concurrency': 99 } })
    );
    const { store, lines } = createStore(root, {
      rename: async () => {
        throw new Error('the volume refused the rename');
      },
    });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.section().values['tasks.concurrency']).toBe(2);
    expect(store.section().problems[0]).toMatchObject({ code: 'above_maximum' });
    expect(
      lines.some((line) => line.level === 'warn' && line.fields.code === 'keep_aside_failed')
    ).toBe(true);
    await expect(store.set('tasks.concurrency', 3)).resolves.toMatchObject({ revision: 8 });
  });

  it("a write refuses unknown keys, wrong types and bounds with the declaration's reason", async () => {
    const root = storeRoot();
    const { store } = createStore(root);
    await store.load();
    await expect(store.set('tasks.made.up', 1)).rejects.toMatchObject({
      code: 'unknown_key',
    });
    await expect(store.set('tasks.concurrency', 'many')).rejects.toBeInstanceOf(SettingsWriteError);
    await expect(store.set('tasks.concurrency', 0)).rejects.toMatchObject({
      code: 'below_minimum',
      limit: 1,
    });
    await expect(store.set('tasks.concurrency', 9)).rejects.toMatchObject({
      code: 'above_maximum',
      limit: 8,
    });
    await expect(store.set('tasks.token', 'hush')).rejects.toMatchObject({
      code: 'secret_setting',
    });
    // A refused write changes nothing on disk.
    expect(() => readFileSync(settingsPath(root))).toThrow();
  });

  it('refuses a write to a read-only setting and changes nothing on disk', async () => {
    const root = storeRoot();
    const { store } = createStore(root, {
      declarations: [concurrency, fixed, secretDeclaration],
    });
    await store.load();
    await expect(store.set('tasks.fixed', 6)).rejects.toMatchObject({ code: 'read_only' });
    await expect(store.set('tasks.fixed', 5)).rejects.toMatchObject({ code: 'read_only' });
    expect(() => readFileSync(settingsPath(root))).toThrow();
    expect(store.section().values['tasks.fixed']).toBe(5);
  });

  it('a failed projection is recorded and shown, never fatal, and a retry recovers', async () => {
    const root = storeRoot();
    let attempts = 0;
    const { store } = createStore(root, {
      projection: {
        project: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('the API refused the write');
        },
      },
    });
    await store.load();
    await expect(store.set('tasks.concurrency', 3)).resolves.toMatchObject({ revision: 1 });
    expect(store.section().projection).toEqual({
      state: 'failed',
      reason: 'the API refused the write',
    });
    // The value is stored despite the failed projection.
    expect(store.section().values['tasks.concurrency']).toBe(3);
    await store.projectNow();
    expect(store.section().projection).toEqual({ state: 'ok' });
    expect(attempts).toBe(2);
  });

  it('serializes projection attempts: an older attempt never marks success after a newer failure', async () => {
    const root = storeRoot();
    let setCalls = 0;
    let releaseFirstProjection!: () => void;
    const secondSetCalled = new Promise<void>((resolve) => {
      releaseFirstProjection = resolve;
    });
    let projectCalls = 0;
    const created = createStore(root, {
      projection: {
        project: async () => {
          projectCalls += 1;
          if (projectCalls === 1) await secondSetCalled;
          else throw new Error('the API refused the newer write');
        },
      },
    });
    const raw = created.store;
    const store = {
      ...raw,
      set: (key: string, value: unknown) => {
        setCalls += 1;
        if (setCalls === 2) releaseFirstProjection();
        return raw.set(key, value);
      },
    };
    await store.load();
    const first = store.set('tasks.concurrency', 3);
    const second = store.set('tasks.concurrency', 4);
    await Promise.all([first, second]);
    // The recorded outcome is the newest attempt's failure, not the older success.
    expect(store.section().projection).toEqual({
      state: 'failed',
      reason: 'the API refused the newer write',
    });
    expect(store.section().values['tasks.concurrency']).toBe(4);
  });
});

describe('settings HTTP routes', () => {
  const servers: Array<ReturnType<typeof createLoaderHttp>> = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(({ close }) => close()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  type StartedStore = SettingsHttp & { load(): Promise<void> };
  async function start(
    options: {
      settings?: SettingsHttp | null;
      declarations?: SettingDeclaration[];
      buildStore?: (loaderDir: string) => StartedStore;
    } = {}
  ) {
    const root = mkdtempSync(join(tmpdir(), 'settings-http-'));
    roots.push(root);
    mkdirSync(join(root, 'loader'), { recursive: true });
    const record = await hashPassword('owner password');
    const session = createSession(record, Date.now());
    const state = {
      ensureLayout: async () => undefined,
      readAuth: async () => record,
      writeAuth: async () => undefined,
      replaceAuth: async () => undefined,
      readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
    } as unknown as LoaderState;
    const store: StartedStore =
      options.buildStore !== undefined
        ? options.buildStore(join(root, 'loader'))
        : createSettingsStore({
            fs: createNodeFileSystem(),
            config: { loaderDir: join(root, 'loader') },
            registry: createSettingsRegistry(
              options.declarations ?? [concurrency, secretDeclaration]
            ),
            clock: createTestClock(),
            logger: createRecordingLogger([]),
          });
    await store.load();
    const loader = createLoaderHttp({
      state,
      logger: createRecordingLogger([]),
      clock: createTestClock(),
      config: loadConfig({ LIFEMODEL_NAME: 'lifemodel' }),
      pki: {
        bootstrap: async () => undefined,
        report: async () => ({
          identity: 'present',
          ca: 'present',
          leaf: 'valid',
          sans: [],
          fingerprint: 'x',
        }),
        caPem: async () => 'CA',
      },
      ...(options.settings === null ? {} : { settings: options.settings ?? store }),
    });
    servers.push(loader);
    await new Promise<void>((resolve) => loader.server.listen(0, '127.0.0.1', resolve));
    const address = loader.server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${String(address.port)}`;
    const ask = async (
      path: string,
      init: {
        method?: string;
        body?: string;
        cookie?: boolean;
        csrf?: string;
        origin?: string | null;
        contentType?: string | null;
      } = {}
    ) => {
      const headers: Record<string, string> = {
        host: 'boot-lifemodel.local',
        ...(init.cookie === false ? {} : { cookie: `__Host-lm_session=${session}` }),
        ...(init.csrf === undefined ? {} : { 'x-csrf-token': init.csrf }),
        ...(init.origin === null ? {} : { origin: init.origin ?? 'https://boot-lifemodel.local' }),
        ...(init.contentType === null
          ? {}
          : { 'content-type': init.contentType ?? 'application/json' }),
      };
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          `${base}${path}`,
          { method: init.method ?? 'GET', headers },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on('error', reject);
        req.end(init.body);
      });
    };
    return {
      base,
      csrf: () => csrfToken(record, session),
      ask,
    };
  }

  it('serves the section: declarations with values, no secret value, revision and no problems', async () => {
    const { ask } = await start();
    const response = await ask('/api/settings');
    expect(response.status).toBe(200);
    const section = JSON.parse(response.body) as {
      declarations: Array<{ key: string; control: string }>;
      values: Record<string, number>;
      revision: number;
      problems: unknown[];
      projection: { state: string };
    };
    expect(section.declarations.map((d) => d.key)).toEqual(['tasks.concurrency', 'tasks.token']);
    expect(section.values).toEqual({ 'tasks.concurrency': 2 });
    expect(section.revision).toBe(0);
    expect(section.problems).toEqual([]);
    expect(section.projection).toEqual({ state: 'unattempted' });
  });

  it('writes one value behind session, CSRF and origin, then serves it back', async () => {
    const { ask, csrf } = await start();
    const refused = await ask('/api/settings/tasks.concurrency', {
      method: 'PUT',
      body: JSON.stringify({ value: 3 }),
    });
    expect(refused.status).toBe(403);
    const written = await ask('/api/settings/tasks.concurrency', {
      method: 'PUT',
      body: JSON.stringify({ value: 3 }),
      csrf: csrf(),
    });
    expect(written.status).toBe(200);
    expect(JSON.parse(written.body)).toEqual({ ok: true, value: 3, revision: 1 });
    const section = JSON.parse((await ask('/api/settings')).body) as {
      values: Record<string, number>;
    };
    expect(section.values['tasks.concurrency']).toBe(3);
  });

  it("refuses wrong types, bounds and unknown keys with the declaration's reason", async () => {
    const { ask, csrf } = await start();
    const token = csrf();
    const wrongType = await ask('/api/settings/tasks.concurrency', {
      method: 'PUT',
      body: JSON.stringify({ value: 'many' }),
      csrf: token,
    });
    expect(wrongType.status).toBe(400);
    expect(JSON.parse(wrongType.body)).toMatchObject({
      error: 'invalid_value',
      reasonCode: 'wrong_type',
    });
    const bounds = await ask('/api/settings/tasks.concurrency', {
      method: 'PUT',
      body: JSON.stringify({ value: 9 }),
      csrf: token,
    });
    expect(JSON.parse(bounds.body)).toMatchObject({
      error: 'invalid_value',
      reasonCode: 'above_maximum',
      limit: 8,
    });
    const unknown = await ask('/api/settings/tasks.made.up', {
      method: 'PUT',
      body: JSON.stringify({ value: 1 }),
      csrf: token,
    });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toMatchObject({ error: 'unknown_setting' });
    const secret = await ask('/api/settings/tasks.token', {
      method: 'PUT',
      body: JSON.stringify({ value: 'hush' }),
      csrf: token,
    });
    expect(secret.status).toBe(400);
    expect(JSON.parse(secret.body)).toMatchObject({ error: 'secret_setting' });
  });

  it('writes a toggle value as a boolean through the route', async () => {
    const { ask, csrf } = await start({
      declarations: [concurrency, enabled, secretDeclaration],
    });
    const written = await ask('/api/settings/tasks.enabled', {
      method: 'PUT',
      body: JSON.stringify({ value: false }),
      csrf: csrf(),
    });
    expect(written.status).toBe(200);
    expect(JSON.parse(written.body)).toEqual({ ok: true, value: false, revision: 1 });
    const refused = await ask('/api/settings/tasks.enabled', {
      method: 'PUT',
      body: JSON.stringify({ value: 'on' }),
      csrf: csrf(),
    });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: 'invalid_value',
      reasonCode: 'wrong_type',
    });
  });

  it('keeps the route table: a keyed GET is 405, an empty key is 404, foreign origins are 403', async () => {
    const { ask } = await start();
    expect((await ask('/api/settings/tasks.concurrency')).status).toBe(405);
    expect(
      (await ask('/api/settings/', { method: 'PUT', body: JSON.stringify({ value: 1 }) })).status
    ).toBe(404);
    const foreign = await ask('/api/settings', { origin: 'https://elsewhere.example' });
    expect(foreign.status).toBe(403);
  });

  it('serializes overlapping PUTs: unique increasing revisions, both keys kept, newest projected', async () => {
    let setCalls = 0;
    let releaseFirstWrite!: () => void;
    const secondSetCalled = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    let loaderDir = '';
    const projected: Array<{
      revision: number;
      values: Record<string, boolean | number | string>;
    }> = [];
    const { ask, csrf } = await start({
      buildStore: (dir) => {
        loaderDir = dir;
        const real = createNodeFileSystem();
        const raw = createSettingsStore({
          fs: {
            ...real,
            writeFileAtomic: async (path: string, contents: string, mode: number) => {
              writes += 1;
              // Hold the first write at the filesystem boundary until both
              // requests have entered the store, making the overlap exact.
              if (writes === 1) await secondSetCalled;
              return real.writeFileAtomic(path, contents, mode);
            },
          },
          config: { loaderDir: dir },
          registry: createSettingsRegistry([concurrency, other, secretDeclaration]),
          clock: createTestClock(),
          logger: createRecordingLogger([]),
          projection: {
            project: async (content) => {
              projected.push(structuredClone(content));
            },
          },
        });
        return {
          ...raw,
          set: (key: string, value: unknown) => {
            setCalls += 1;
            if (setCalls === 2) releaseFirstWrite();
            return raw.set(key, value);
          },
        };
      },
    });
    const token = csrf();
    const [left, right] = await Promise.all([
      ask('/api/settings/tasks.concurrency', {
        method: 'PUT',
        body: JSON.stringify({ value: 3 }),
        csrf: token,
      }),
      ask('/api/settings/tasks.other', {
        method: 'PUT',
        body: JSON.stringify({ value: 4 }),
        csrf: token,
      }),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const revisions = [
      (JSON.parse(left.body) as { revision: number }).revision,
      (JSON.parse(right.body) as { revision: number }).revision,
    ].sort((a, b) => a - b);
    expect(revisions).toEqual([1, 2]);
    const finalDocument = JSON.parse(readFileSync(join(loaderDir, 'settings.json'), 'utf8')) as {
      version: number;
      revision: number;
      values: Record<string, number>;
    };
    expect(finalDocument).toEqual({
      version: 1,
      revision: 2,
      values: { 'tasks.concurrency': 3, 'tasks.other': 4 },
    });
    const restarted = createSettingsStore({
      fs: createNodeFileSystem(),
      config: { loaderDir },
      registry: createSettingsRegistry([concurrency, other, secretDeclaration]),
      clock: createTestClock(),
      logger: createRecordingLogger([]),
    });
    await restarted.load();
    expect(restarted.section().values).toEqual({ 'tasks.concurrency': 3, 'tasks.other': 4 });
    expect(restarted.section().revision).toBe(2);
    expect(projected.map((content) => content.revision)).toEqual([1, 2]);
    expect(projected.at(-1)?.values).toEqual({ 'tasks.concurrency': 3, 'tasks.other': 4 });
  });

  it('refuses a PUT to a read-only setting with the read_only reason', async () => {
    const { ask, csrf } = await start({
      declarations: [concurrency, fixed, secretDeclaration],
    });
    const written = await ask('/api/settings/tasks.fixed', {
      method: 'PUT',
      body: JSON.stringify({ value: 5 }),
      csrf: csrf(),
    });
    expect(written.status).toBe(400);
    expect(JSON.parse(written.body)).toMatchObject({
      error: 'invalid_value',
      reasonCode: 'read_only',
    });
  });

  it('saves every platform key through the route, refuses the read-only ceiling and survives a restart', async () => {
    let loaderDir = '';
    const registry = createSettingsRegistry(platformSettings.declarations());
    const { ask, csrf } = await start({
      buildStore: (dir) => {
        loaderDir = dir;
        return createSettingsStore({
          fs: createNodeFileSystem(),
          config: { loaderDir: dir },
          registry,
          clock: createTestClock(),
          logger: createRecordingLogger([]),
        });
      },
    });
    const token = csrf();
    const grace = await ask('/api/settings/tasks.wrapGraceSeconds', {
      method: 'PUT',
      body: JSON.stringify({ value: 600 }),
      csrf: token,
    });
    expect(grace.status).toBe(200);
    expect(JSON.parse(grace.body)).toMatchObject({ ok: true, value: 600 });
    const lead = await ask('/api/settings/storage.warningLeadDays', {
      method: 'PUT',
      body: JSON.stringify({ value: 14 }),
      csrf: token,
    });
    expect(lead.status).toBe(200);
    expect(JSON.parse(lead.body)).toMatchObject({ ok: true, value: 14 });
    const ceiling = await ask('/api/settings/storage.ceilingBytes', {
      method: 'PUT',
      body: JSON.stringify({ value: 40000000000 }),
      csrf: token,
    });
    expect(ceiling.status).toBe(400);
    expect(JSON.parse(ceiling.body)).toMatchObject({
      error: 'invalid_value',
      reasonCode: 'read_only',
    });
    const section = JSON.parse((await ask('/api/settings')).body) as {
      values: Record<string, number>;
    };
    expect(section.values['tasks.wrapGraceSeconds']).toBe(600);
    expect(section.values['storage.warningLeadDays']).toBe(14);
    expect(section.values['storage.ceilingBytes']).toBe(20000000000);
    const restarted = createSettingsStore({
      fs: createNodeFileSystem(),
      config: { loaderDir },
      registry,
      clock: createTestClock(),
      logger: createRecordingLogger([]),
    });
    await restarted.load();
    expect(restarted.section().values).toEqual({
      'tasks.concurrency': 2,
      'tasks.harness': 'opencode',
      'tasks.wrapGraceSeconds': 600,
      'tasks.channel.maxFrameBytes': 65_536,
      'tasks.channel.maxUnackedFrames': 16,
      'tasks.channel.maxUnackedBytes': 1_048_576,
      'tasks.channel.maxBufferedBytes': 4_194_304,
      'tasks.channel.ackTimeoutMs': 5_000,
      'tasks.channel.workers': 2,
      'tasks.channel.sqlConnections': 2,
      'storage.retention': '90d',
      'storage.warningLeadDays': 14,
      'storage.ceilingBytes': 20000000000,
    });
  });

  it('answers 503 storage_unavailable when the settings seam is not wired', async () => {
    const { ask } = await start({ settings: null });
    const response = await ask('/api/settings');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'storage_unavailable' });
  });
});

describe('settings ConfigMap projection', () => {
  const projectionRoots: string[] = [];
  afterEach(() => {
    for (const root of projectionRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  async function projectionWith(
    respond: (
      url: URL,
      method: string,
      body: string | undefined
    ) => { status: number; body: string }
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'settings-projection-'));
    projectionRoots.push(directory);
    const tokenFile = join(directory, 'token');
    writeFileSync(tokenFile, 'test-token');
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    const projection = createKubernetesSettingsProjection({
      tokenFile,
      request: async (url, method, _token, body) => {
        calls.push({ method, path: url.pathname, body });
        return respond(url, method, body);
      },
    });
    return { projection, calls };
  }
  const configMapBody = (body: string | undefined) =>
    JSON.parse(body ?? '{}') as {
      metadata: { name: string; namespace: string; annotations: Record<string, string> };
      data: Record<string, string>;
    };

  it('creates the named ConfigMap once and verifies the write by reading back', async () => {
    let stored: Record<string, string> | null = null;
    const { projection, calls } = await projectionWith((_url, method, body) => {
      if (method === 'GET')
        return {
          status: stored === null ? 404 : 200,
          body: stored === null ? '' : JSON.stringify({ data: stored }),
        };
      if (method === 'POST') {
        stored = configMapBody(body).data;
        return { status: 201, body: '' };
      }
      stored = configMapBody(body).data;
      return { status: 200, body: '' };
    });
    await projection.project({ revision: 3, values: { 'tasks.concurrency': 3 } });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[0]?.path).toBe(
      '/api/v1/namespaces/lifemodel/configmaps/lifemodel-platform-settings'
    );
    const created = configMapBody(calls[1]?.body);
    expect(created.metadata.name).toBe('lifemodel-platform-settings');
    expect(created.metadata.namespace).toBe('lifemodel');
    expect(created.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
    expect(JSON.parse(created.data['settings.json'])).toEqual({
      version: 1,
      revision: 3,
      values: { 'tasks.concurrency': 3 },
    });
  });

  it('updates with the read resourceVersion', async () => {
    let stored: Record<string, string> | null = null;
    const { projection, calls } = await projectionWith((_url, method, body) => {
      if (method === 'GET')
        return {
          status: 200,
          body: JSON.stringify({
            metadata: { resourceVersion: stored === null ? '42' : '43' },
            ...(stored === null ? {} : { data: stored }),
          }),
        };
      stored = configMapBody(body).data;
      return { status: 200, body: '' };
    });
    await projection.project({ revision: 4, values: {} });
    const updated = JSON.parse(calls.find((call) => call.method === 'PUT')?.body ?? '{}') as {
      metadata: { resourceVersion?: string };
    };
    expect(updated.metadata.resourceVersion).toBe('42');
  });

  it('throws on a refused write so the store can record, show and retry it', async () => {
    const { projection } = await projectionWith((_url, method) =>
      method === 'POST' ? { status: 403, body: 'denied' } : { status: 404, body: '' }
    );
    await expect(projection.project({ revision: 1, values: {} })).rejects.toThrow(
      /create failed \(403\)/
    );
  });
});

describe('the platform loader serves settings', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function appFor(root: string, projectionLog: unknown[]) {
    return createLoaderApp({
      config: {
        ...loadConfig({
          LIFEMODEL_VOLUME_ROOT: root,
          LIFEMODEL_HTTP_PORT: '0',
          LIFEMODEL_NAME: 'lifemodel',
        }),
        loaderDir: root,
      },
      fs: createNodeFileSystem(),
      runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      logger: createRecordingLogger([]),
      clock: systemClock,
      exit: () => undefined,
      pki: {
        bootstrap: async () => undefined,
        report: async () => ({
          identity: 'present',
          ca: 'present',
          leaf: 'valid',
          sans: [],
          fingerprint: 'x',
        }),
        caPem: async () => 'CA',
      },
      platformBootstrap: {
        runInitial: async () => undefined,
        unsealIfSealed: async () => undefined,
      },
      settingsProjection: {
        project: async (content) => {
          projectionLog.push(structuredClone(content));
        },
      },
    });
  }
  async function getFrom(
    port: number,
    path: string,
    cookie: string
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: { host: 'boot-lifemodel.local', cookie },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }
  const settings = (port: number, cookie: string) => getFrom(port, '/api/settings', cookie);
  async function putSetting(
    port: number,
    cookie: string,
    csrf: string,
    key: string,
    value: unknown
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: `/api/settings/${key}`,
          method: 'PUT',
          headers: {
            host: 'boot-lifemodel.local',
            cookie,
            origin: 'https://boot-lifemodel.local',
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ value }));
    });
  }
  async function setUp(port: number): Promise<string> {
    const setup = await new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/setup',
          method: 'POST',
          headers: {
            host: 'boot-lifemodel.local',
            origin: 'https://boot-lifemodel.local',
            'content-type': 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
            })
          );
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ password: 'a secure password' }));
    });
    expect(setup.status).toBe(200);
    return String(setup.headers['set-cookie'] ?? '').split(';')[0]!;
  }

  it('starts with a corrupt settings file, serves defaults and shows the problem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'settings-app-'));
    roots.push(root);
    writeFileSync(join(root, 'settings.json'), '{ broken');
    const projectionLog: unknown[] = [];
    const app = appFor(root, projectionLog);
    await app.start();
    const cookie = await setUp(app.port());
    const response = await settings(app.port(), cookie);
    expect(response.status).toBe(200);
    const section = JSON.parse(response.body) as {
      values: Record<string, number>;
      revision: number;
      problems: Array<{ code: string }>;
    };
    expect(section.values['tasks.concurrency']).toBe(2);
    expect(section.revision).toBe(0);
    expect(section.problems.map((problem) => problem.code)).toEqual(['corrupt']);
    expect(readdirSync(root).some((name) => name.startsWith('settings.json.invalid-'))).toBe(true);
    expect(readdirSync(root)).not.toContain('settings.json');
    await app.shutdown('test');
  });

  it('serves a valid stored value across a restart and projects it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'settings-app-valid-'));
    roots.push(root);
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ version: 1, revision: 4, values: { 'tasks.concurrency': 3 } })
    );
    const projectionLog: unknown[] = [];
    const first = appFor(root, projectionLog);
    await first.start();
    const cookie = await setUp(first.port());
    const served = JSON.parse((await settings(first.port(), cookie)).body) as {
      values: Record<string, number>;
      revision: number;
      problems: unknown[];
    };
    expect(served.values['tasks.concurrency']).toBe(3);
    expect(served.revision).toBe(4);
    expect(served.problems).toEqual([]);
    expect(projectionLog).toEqual([{ revision: 4, values: { 'tasks.concurrency': 3 } }]);
    await first.shutdown('test');
    const second = appFor(root, projectionLog);
    await second.start();
    const again = JSON.parse((await settings(second.port(), cookie)).body) as {
      values: Record<string, number>;
    };
    expect(again.values['tasks.concurrency']).toBe(3);
    await second.shutdown('test');
  });

  it('keeps a value-invalid settings file aside and a later PUT writes a fresh document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'settings-app-invalid-'));
    roots.push(root);
    const original = JSON.stringify({
      version: 1,
      revision: 7,
      values: { 'tasks.concurrency': 99 },
    });
    writeFileSync(join(root, 'settings.json'), original);
    const app = appFor(root, []);
    await app.start();
    const cookie = await setUp(app.port());
    const served = JSON.parse((await settings(app.port(), cookie)).body) as {
      values: Record<string, number>;
      revision: number;
      problems: Array<{ code: string }>;
    };
    expect(served.values['tasks.concurrency']).toBe(2);
    expect(served.revision).toBe(7);
    expect(served.problems.map((problem) => problem.code)).toEqual(['above_maximum']);
    const kept = readdirSync(root).filter((name) => name.startsWith('settings.json.invalid-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(root, kept[0]!), 'utf8')).toBe(original);
    const state = JSON.parse((await getFrom(app.port(), '/api/state', cookie)).body) as {
      csrfToken: string;
    };
    const written = await putSetting(app.port(), cookie, state.csrfToken, 'tasks.concurrency', 3);
    expect(written.status).toBe(200);
    expect(JSON.parse(written.body)).toEqual({ ok: true, value: 3, revision: 8 });
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))).toEqual({
      version: 1,
      revision: 8,
      values: { 'tasks.concurrency': 3 },
    });
    expect(readFileSync(join(root, kept[0]!), 'utf8')).toBe(original);
    await app.shutdown('test');
  });
});
