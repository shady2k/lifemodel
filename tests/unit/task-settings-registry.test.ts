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

describe('settings HTTP routes', () => {
  const servers: Array<ReturnType<typeof createLoaderHttp>> = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(({ close }) => close()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function start(options: { settings?: SettingsHttp | null } = {}) {
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
    const store = createSettingsStore({
      fs: createNodeFileSystem(),
      config: { loaderDir: join(root, 'loader') },
      registry: createSettingsRegistry([concurrency, secretDeclaration]),
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

  it('keeps the route table: a keyed GET is 405, an empty key is 404, foreign origins are 403', async () => {
    const { ask } = await start();
    expect((await ask('/api/settings/tasks.concurrency')).status).toBe(405);
    expect(
      (await ask('/api/settings/', { method: 'PUT', body: JSON.stringify({ value: 1 }) })).status
    ).toBe(404);
    const foreign = await ask('/api/settings', { origin: 'https://elsewhere.example' });
    expect(foreign.status).toBe(403);
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
  async function settings(port: number, cookie: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/settings',
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
});
