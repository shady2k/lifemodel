import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSettingsRegistry,
  SettingsDeclarationError,
  type SettingDeclaration,
} from '../../loader/src/settings/registry.js';
import { platformSettings } from '../../loader/src/settings/platform.js';
import { createSettingsStore, SettingsWriteError } from '../../loader/src/settings/store.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';

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

  it('refuses a number declaration whose default or bounds contradict each other', () => {
    expect(() => createSettingsRegistry([{ ...concurrency, default: 20 }])).toThrow(
      SettingsDeclarationError
    );
    expect(() => createSettingsRegistry([{ ...concurrency, min: 8, max: 1 }])).toThrow(
      SettingsDeclarationError
    );
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
      authority: 'owner',
      apply: 'nextAdmission',
    });
    expect(declaration?.label.en).toBeTruthy();
    expect(declaration?.label.ru).toBeTruthy();
    expect(declaration?.description.en).toBeTruthy();
    expect(declaration?.description.ru).toBeTruthy();
  });
});

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
});
