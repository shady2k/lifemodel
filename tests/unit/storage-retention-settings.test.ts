import { TASK_HARNESS_NAMES } from '../../src/ports/task-harness-names.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { evaluate } from '@marcbachmann/cel-js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { platformSettings } from '../../loader/src/settings/platform.js';
import { createSettingsRegistry } from '../../loader/src/settings/registry.js';
import { createPlatformSettingsProjection } from '../../loader/src/settings/projection.js';
import {
  createStorageRetentionSettings,
  STORAGE_RETENTION_SETTINGS_PATH,
} from '../../loader/src/storage-retention-settings.js';

const defaults = { retention: '90d', warningLeadDays: 7, revision: 0 };
const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'retention-settings-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function document(revision: number, values: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, revision, values });
}
function reader() {
  const path = join(directory(), 'settings.json');
  const lines: RecordedLine[] = [];
  const settings = createStorageRetentionSettings({ path, logger: createRecordingLogger(lines) });
  return { path, lines, settings };
}
function documents(path: string): any[] {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8')).map((item) => item.toJSON());
}

describe('storage retention settings declarations', () => {
  it('declares finite retention and a whole-day bounded warning with safe defaults', () => {
    expect(platformSettings.get('storage.retention')).toMatchObject({
      control: 'select',
      default: '90d',
      options: [
        expect.objectContaining({ value: '90d' }),
        expect.objectContaining({ value: 'forever' }),
      ],
    });
    expect(platformSettings.get('storage.warningLeadDays')).toMatchObject({
      control: 'number',
      integer: true,
      default: 7,
      min: 1,
      max: 30,
    });
    for (const value of ['90d', 'forever'])
      expect(platformSettings.validate('storage.retention', value)).toEqual({ ok: true, value });
    for (const value of [0, '0', '90', 'invalid', null, false])
      expect(platformSettings.validate('storage.retention', value).ok).toBe(false);
    for (let value = 1; value <= 30; value += 1)
      expect(platformSettings.validate('storage.warningLeadDays', value)).toEqual({
        ok: true,
        value,
      });
    for (const value of [0, 31, 2.5, 7.1, '7', null, true, Number.NaN, Infinity])
      expect(platformSettings.validate('storage.warningLeadDays', value).ok).toBe(false);
  });

  it('rejects contradictory integer metadata, without changing ordinary number settings', () => {
    const declaration = platformSettings.get('storage.warningLeadDays')!;
    expect(() => createSettingsRegistry([{ ...declaration, default: 7.5 }])).toThrow(/integer/);
    expect(() => createSettingsRegistry([{ ...declaration, control: 'select' }])).toThrow(
      /integer/
    );
    expect(platformSettings.validate('tasks.concurrency', 2.5)).toEqual({ ok: true, value: 2.5 });
  });
});

describe('the storage module settings reader', () => {
  it('re-reads projected values and revision on each call; unrelated settings stay quiet', async () => {
    const { path, settings, lines } = reader();
    writeFileSync(
      path,
      document(4, {
        'storage.retention': 'forever',
        'storage.warningLeadDays': 3,
        'tasks.harness': TASK_HARNESS_NAMES[0],
        'private-unknown-canary': 'do-not-log',
      })
    );
    await expect(settings.read()).resolves.toEqual({
      retention: 'forever',
      warningLeadDays: 3,
      revision: 4,
    });
    writeFileSync(path, document(5, { 'storage.retention': '90d', 'storage.warningLeadDays': 30 }));
    await expect(settings.read()).resolves.toEqual({
      retention: '90d',
      warningLeadDays: 30,
      revision: 5,
    });
    expect(lines).toEqual([]);
  });

  it('waits for the first valid projection and keeps it if missing, logging once until recovery', async () => {
    const { path, settings, lines } = reader();
    await expect(settings.read()).resolves.toBeUndefined();
    await settings.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual({ code: 'missing', count: 1 });
    writeFileSync(path, document(1, { 'storage.retention': 'forever' }));
    const cached = { ...defaults, retention: 'forever', revision: 1 };
    await expect(settings.read()).resolves.toEqual(cached);
    rmSync(path);
    await expect(settings.read()).resolves.toEqual(cached);
    await settings.read();
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain(path);
    writeFileSync(path, document(2, {}));
    await expect(settings.read()).resolves.toEqual({ ...defaults, revision: 2 });
    rmSync(path);
    await expect(settings.read()).resolves.toEqual({ ...defaults, revision: 2 });
    expect(lines).toHaveLength(3);
  });

  it('waits on an unreadable projection and keeps the last valid document after recovery', async () => {
    const { path, settings, lines } = reader();
    // A directory cannot be read as utf8 on the supported Linux test boundary.
    mkdirSync(path);
    await expect(settings.read()).resolves.toBeUndefined();
    expect(lines[0]?.fields).toEqual({ code: 'unreadable', count: 1 });
    rmSync(path, { recursive: true });
    writeFileSync(path, document(4, { 'storage.retention': 'forever' }));
    const cached = { ...defaults, retention: 'forever', revision: 4 };
    await expect(settings.read()).resolves.toEqual(cached);
    rmSync(path);
    mkdirSync(path);
    await expect(settings.read()).resolves.toEqual(cached);
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain(path);
    expect(JSON.stringify(lines)).not.toContain('EISDIR');
  });

  it.each([
    '{ private-document-canary',
    'null',
    '[]',
    JSON.stringify({ version: 2, revision: 1, values: {} }),
    JSON.stringify({ version: 1, values: {} }),
    JSON.stringify({ version: 1, revision: -1, values: {} }),
    JSON.stringify({ version: 1, revision: 1.5, values: {} }),
    JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER + 1, values: {} }),
    JSON.stringify({ version: 1, revision: 1, values: [] }),
    JSON.stringify({ version: 1, revision: 1, values: null }),
    JSON.stringify({ version: 1, revision: 1 }),
  ])('waits for a valid document and keeps it on invalid document %s', async (text) => {
    const { path, settings, lines } = reader();
    writeFileSync(path, text);
    await expect(settings.read()).resolves.toBeUndefined();
    await settings.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual({ code: 'invalid_document', count: 1 });
    writeFileSync(
      path,
      document(4, { 'storage.retention': 'forever', 'storage.warningLeadDays': 3 })
    );
    const cached = { retention: 'forever', warningLeadDays: 3, revision: 4 };
    await expect(settings.read()).resolves.toEqual(cached);
    writeFileSync(path, text);
    await expect(settings.read()).resolves.toEqual(cached);
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain('private-document-canary');
    expect(JSON.stringify(lines)).not.toContain(path);
  });

  it.each([0, 31, 7.5, '3', null, false])(
    'rejects the entire document on invalid lead %s',
    async (lead) => {
      const { path, settings, lines } = reader();
      const invalid = document(8, {
        'storage.retention': '90d',
        'storage.warningLeadDays': lead,
      });
      writeFileSync(path, invalid);
      await expect(settings.read()).resolves.toBeUndefined();
      expect(lines[0]?.fields).toEqual({ code: 'invalid_value', count: 1 });
      writeFileSync(
        path,
        document(7, { 'storage.retention': 'forever', 'storage.warningLeadDays': 3 })
      );
      const cached = { retention: 'forever', warningLeadDays: 3, revision: 7 };
      await expect(settings.read()).resolves.toEqual(cached);
      writeFileSync(path, invalid);
      await expect(settings.read()).resolves.toEqual(cached);
      expect(lines).toHaveLength(2);
    }
  );

  it('rejects invalid retention without changing the cached document or logging private data', async () => {
    const { path, settings, lines } = reader();
    writeFileSync(
      path,
      document(9, {
        'storage.retention': 'private-value-canary',
        'storage.warningLeadDays': 3,
        'private-key-canary': 'private-body-canary',
      })
    );
    await expect(settings.read()).resolves.toBeUndefined();
    writeFileSync(
      path,
      document(7, { 'storage.retention': 'forever', 'storage.warningLeadDays': 30 })
    );
    const cached = { retention: 'forever', warningLeadDays: 30, revision: 7 };
    await expect(settings.read()).resolves.toEqual(cached);
    writeFileSync(path, document(9, { 'storage.retention': 'private-value-canary' }));
    await expect(settings.read()).resolves.toEqual(cached);
    writeFileSync(path, document(10, { 'storage.retention': 0, 'storage.warningLeadDays': 0 }));
    await expect(settings.read()).resolves.toEqual(cached);
    expect(lines.map((line) => line.fields)).toEqual([
      { code: 'invalid_value', count: 1 },
      { code: 'invalid_value', count: 1 },
      { code: 'invalid_value', count: 2 },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/canary|storage\.retention|storage\.warningLeadDays/);
  });
});

describe('the loader projects one settings document to both fixed targets', () => {
  function projection() {
    const tokenFile = join(directory(), 'token');
    writeFileSync(tokenFile, 'private-test-token');
    const objects = new Map<string, any>();
    const writes: Array<{ path: string; method: string; body: any }> = [];
    let failedNamespace: string | undefined;
    let corruptStorageReadback = false;
    const settings = createPlatformSettingsProjection({
      tokenFile,
      caFile: join(directory(), 'missing-ca'),
      apiServer: 'https://kubernetes.test',
      request: async (url, method, token, body) => {
        expect(token).toBe('private-test-token');
        const path = url.pathname;
        if (method === 'GET') {
          const object = objects.get(path);
          if (object && corruptStorageReadback && path.includes('/namespaces/lifemodel-system/'))
            return {
              status: 200,
              body: JSON.stringify({ ...object, data: { 'settings.json': '{}' } }),
            };
          return object ? { status: 200, body: JSON.stringify(object) } : { status: 404, body: '' };
        }
        const object = JSON.parse(body!);
        writes.push({ path, method, body: object });
        if (object.metadata.namespace === failedNamespace)
          return { status: 403, body: 'private-api-body-canary' };
        const objectPath = method === 'POST' ? `${path}/${object.metadata.name}` : path;
        const previous = objects.get(objectPath);
        if (method === 'PUT')
          expect(object.metadata.resourceVersion).toBe(previous.metadata.resourceVersion);
        object.metadata.resourceVersion = String(
          Number(previous?.metadata.resourceVersion ?? 0) + 1
        );
        objects.set(objectPath, object);
        return { status: method === 'POST' ? 201 : 200, body: '{}' };
      },
    });
    return {
      objects,
      writes,
      settings,
      fail: (value: boolean, namespace = 'lifemodel-system') => {
        failedNamespace = value ? namespace : undefined;
      },
      corruptReadback: () => {
        corruptStorageReadback = true;
      },
    };
  }

  it('creates and updates both exact names with identical document bytes and revision', async () => {
    const { objects, writes, settings } = projection();
    const targets = [
      '/api/v1/namespaces/lifemodel/configmaps/lifemodel-platform-settings',
      '/api/v1/namespaces/lifemodel-system/configmaps/lifemodel-storage-settings',
    ];
    const first = {
      revision: 3,
      values: { 'storage.retention': 'forever', 'storage.warningLeadDays': 3 },
    };
    await settings.project(first);
    expect([...objects.keys()].sort()).toEqual([...targets].sort());
    expect(writes.map((write) => write.method)).toEqual(['POST', 'POST']);
    const projected = targets.map((target) => objects.get(target).data['settings.json']);
    expect(projected[0]).toBe(projected[1]);
    expect(JSON.parse(projected[0])).toEqual({ version: 1, ...first });
    const next = {
      revision: 4,
      values: { 'storage.retention': '90d', 'storage.warningLeadDays': 30 },
    };
    await settings.project(next);
    expect(writes.map((write) => write.method)).toEqual(['POST', 'POST', 'PUT', 'PUT']);
    for (const target of targets)
      expect(JSON.parse(objects.get(target).data['settings.json'])).toEqual({
        version: 1,
        ...next,
      });
    expect(readFileSync('loader/src/app.ts', 'utf8')).toContain(
      'projection: deps.settingsProjection ?? createPlatformSettingsProjection()'
    );
  });

  it('does not hide a second-target failure or block the first target, and retries the current revision', async () => {
    const { objects, settings, fail } = projection();
    fail(true);
    const content = { revision: 2, values: { 'storage.warningLeadDays': 3 } };
    await expect(settings.project(content)).rejects.toThrow(/create failed \(403\)/);
    expect(objects.size).toBe(1);
    fail(false);
    await settings.project({ ...content, revision: 3 });
    expect(objects.size).toBe(2);
    for (const object of objects.values())
      expect(JSON.parse(object.data['settings.json']).revision).toBe(3);
  });

  it('still projects to storage if the application projection is denied during bootstrap', async () => {
    const { objects, settings, fail } = projection();
    fail(true, 'lifemodel');
    await expect(settings.project({ revision: 1, values: {} })).rejects.toThrow(
      /create failed \(403\)/
    );
    expect([...objects.keys()]).toEqual([
      '/api/v1/namespaces/lifemodel-system/configmaps/lifemodel-storage-settings',
    ]);
  });

  it('verifies the second target by reading back, rather than trusting a successful write status', async () => {
    const { settings, corruptReadback } = projection();
    corruptReadback();
    await expect(settings.project({ revision: 2, values: {} })).rejects.toThrow(
      /read-back did not match/
    );
  });
});

describe('storage settings bootstrap and authority', () => {
  const admissions = documents('deploy/platform/a0/admission-policies.yaml');
  const policy = (name: string) =>
    admissions.find(
      (item) => item.kind === 'ValidatingAdmissionPolicy' && item.metadata.name === name
    ).spec;
  const writePolicy = policy('loader-configmap-admission');
  const ownership = policy('platform-settings-ownership-admission');
  const loader = 'system:serviceaccount:lifemodel-system:loader';
  function request(
    name: string,
    namespace = 'lifemodel-system',
    operation = 'CREATE',
    username = loader
  ) {
    return { name, namespace, operation, userInfo: { username } };
  }
  function permits(name: string, operation = 'CREATE', namespace = 'lifemodel-system') {
    return evaluate(writePolicy.validations[0].expression, {
      request: request(name, namespace, operation),
      object: { metadata: { name } },
    });
  }

  it('grants only the loader named get/update and create in system namespace at step A', () => {
    const objects = documents('deploy/platform/a/loader-settings-rbac.yaml');
    const role = objects.find(
      (item) => item.kind === 'Role' && item.metadata.namespace === 'lifemodel-system'
    );
    expect(role.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['configmaps'],
        resourceNames: ['lifemodel-storage-settings'],
        verbs: ['get', 'update'],
      },
      { apiGroups: [''], resources: ['configmaps'], verbs: ['create'] },
    ]);
    const binding = objects.find(
      (item) => item.kind === 'RoleBinding' && item.metadata.namespace === 'lifemodel-system'
    );
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'loader', namespace: 'lifemodel-system' },
    ]);
    expect(binding.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: role.metadata.name,
    });
    expect(
      YAML.parse(readFileSync('deploy/platform/a/kustomization.yaml', 'utf8')).resources
    ).toContain('loader-settings-rbac.yaml');
    for (const object of documents('deploy/platform/d/storage-module-rbac.yaml').filter((item) =>
      ['Role', 'ClusterRole'].includes(item.kind)
    ))
      for (const rule of object.rules) expect(rule.resources).not.toContain('configmaps');
  });

  it('mounts an optional read-only directory before any projection exists, with no subPath', () => {
    const workload = documents('deploy/platform/d/storage-module.yaml').find(
      (item) => item.kind === 'Deployment'
    );
    const pod = workload.spec.template.spec;
    const container = pod.containers[0];
    expect(pod.volumes).toContainEqual({
      name: 'platform-settings',
      configMap: { name: 'lifemodel-storage-settings', optional: true },
    });
    expect(container.volumeMounts).toContainEqual({
      name: 'platform-settings',
      mountPath: '/opt/lifemodel/platform-settings',
      readOnly: true,
    });
    expect(container.env).toContainEqual({
      name: 'LIFEMODEL_STORAGE_SETTINGS_PATH',
      value: STORAGE_RETENTION_SETTINGS_PATH,
    });
    // The loader TypeScript allowlist already includes this reader and its registry imports.
    expect(readFileSync('.dockerignore', 'utf8')).toContain('!loader/src/**/*.ts');
  });

  it('clamps loader creates to the second fixed name and preserves existing PKI updates', () => {
    expect(writePolicy.matchConstraints.namespaceSelector.matchExpressions[0].values).toContain(
      'lifemodel-system'
    );
    expect(permits('lifemodel-storage-settings')).toBe(true);
    expect(permits('lifemodel-storage-settings', 'UPDATE')).toBe(true);
    expect(permits('lifemodel-storage-settings', 'DELETE')).toBe(false);
    expect(permits('arbitrary')).toBe(false);
    expect(permits('lifemodel-platform-settings')).toBe(false);
    expect(permits('lifemodel-storage-settings', 'CREATE', 'lifemodel')).toBe(false);
    for (const name of ['lifemodel-ca', 'lifemodel-pki-status']) {
      expect(permits(name, 'UPDATE')).toBe(true);
      expect(permits(name, 'CREATE')).toBe(false);
      expect(permits(name, 'DELETE')).toBe(false);
    }
  });

  it('reserves the second target to loader against other identities, including DELETE without object', () => {
    expect(ownership.matchConstraints.namespaceSelector.matchExpressions[0].values).toContain(
      'lifemodel-system'
    );
    for (const operation of ['CREATE', 'UPDATE', 'DELETE']) {
      for (const identity of [
        'system:serviceaccount:lifemodel-system:storage-module',
        'system:serviceaccount:cnpg-system:cloudnative-pg',
        'system:serviceaccount:lifemodel:core',
      ]) {
        const args = {
          request: request('lifemodel-storage-settings', 'lifemodel-system', operation, identity),
          object: null,
        };
        expect(evaluate(ownership.matchConditions[0].expression, args)).toBe(true);
        expect(evaluate(ownership.validations[0].expression, args)).toBe(false);
      }
    }
    expect(
      evaluate(ownership.validations[0].expression, {
        request: request('lifemodel-storage-settings'),
      })
    ).toBe(true);
    for (const name of ['lifemodel-ca', 'lifemodel-pki-status', 'arbitrary'])
      expect(evaluate(ownership.matchConditions[0].expression, { request: request(name) })).toBe(
        false
      );
  });

  it('keeps the A0 to D chain acyclic when the settings ConfigMap has not been created', () => {
    const chain = [
      ['a0', 'platform-instance'],
      ['a', 'platform-a0'],
      ['b', 'platform-a'],
      ['c', 'platform-b'],
      ['d', 'platform-c'],
    ];
    for (const [step, dependency] of chain) {
      const reconciler = YAML.parse(
        readFileSync(`deploy/platform/${step}-reconciler.yaml`, 'utf8')
      );
      expect(reconciler.spec.dependsOn).toEqual([{ name: dependency }]);
    }
    const loaderDeployment = documents('deploy/platform/a0/deployment.yaml').find(
      (item) => item.kind === 'Deployment'
    );
    const loaderPod = loaderDeployment.spec.template.spec;
    // A0 is healthy from the loader HTTP process, not a later projection or store.
    expect(loaderPod.containers[0].readinessProbe.httpGet.path).toBe('/login');
    expect(
      loaderPod.volumes.every(
        (volume: any) => volume.configMap?.name !== 'lifemodel-storage-settings'
      )
    ).toBe(true);
    const placeholders = documents('deploy/platform/a0/pki-configmap.yaml');
    expect(placeholders.map((item) => [item.metadata.namespace, item.metadata.name])).toEqual([
      ['lifemodel-system', 'lifemodel-ca'],
      ['lifemodel', 'lifemodel-ca'],
      ['lifemodel-motor', 'lifemodel-ca'],
      ['lifemodel-system', 'lifemodel-pki-status'],
    ]);
    // A0 creates these as Flux, before loader's UPDATE-only bootstrap writes.
    expect(
      evaluate(writePolicy.matchConditions[0].expression, {
        request: request(
          'lifemodel-ca',
          'lifemodel-system',
          'CREATE',
          'system:serviceaccount:flux-system:kustomize-controller'
        ),
      })
    ).toBe(false);
    expect(
      evaluate(writePolicy.validations[0].expression, {
        request: request('lifemodel-storage-settings', 'lifemodel-system', 'DELETE'),
        object: null,
      })
    ).toBe(false);
    for (const policyName of [
      'loader-configmap-admission',
      'platform-settings-ownership-admission',
    ]) {
      expect(policy(policyName).failurePolicy).toBe('Fail');
      expect(
        admissions.find(
          (item) =>
            item.kind === 'ValidatingAdmissionPolicyBinding' && item.spec.policyName === policyName
        ).spec.validationActions
      ).toEqual(['Deny']);
    }
  });

  it('grants the module no ConfigMap API access through any shipped binding', () => {
    function manifestFiles(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? manifestFiles(path)
          : /\.ya?ml$/.test(entry.name)
            ? [path]
            : [];
      });
    }
    const objects = manifestFiles('deploy/platform').flatMap(documents).filter(Boolean);
    const bindings = objects.filter(
      (item) =>
        ['RoleBinding', 'ClusterRoleBinding'].includes(item.kind) &&
        item.subjects?.some(
          (subject: any) =>
            subject.kind === 'ServiceAccount' &&
            subject.name === 'storage-module' &&
            subject.namespace === 'lifemodel-system'
        )
    );
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      const role = objects.find(
        (item) =>
          item.kind === binding.roleRef.kind &&
          item.metadata.name === binding.roleRef.name &&
          (item.kind === 'ClusterRole' || item.metadata.namespace === binding.metadata.namespace)
      );
      expect(role).toBeDefined();
      for (const rule of role.rules) {
        if (rule.apiGroups.includes('') || rule.apiGroups.includes('*')) {
          expect(rule.resources).not.toContain('configmaps');
          expect(rule.resources).not.toContain('*');
        }
      }
    }
  });
});
