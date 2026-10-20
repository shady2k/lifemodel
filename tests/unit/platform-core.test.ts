import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { PLATFORM_SETTINGS_DIR } from '../../src/config/platform-settings.js';

const root = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const application = YAML.parseAllDocuments(
  readFileSync(`${root}applications/lifemodel/core.yaml`, 'utf8')
).map((doc) => doc.toJSON());
const kustomization = YAML.parse(
  readFileSync(`${root}applications/lifemodel/kustomization.yaml`, 'utf8')
);
const platformApplication = YAML.parseAllDocuments(
  readFileSync(`${root}a/applications.yaml`, 'utf8')
).map((doc) => doc.toJSON());
const applier = platformApplication.find(
  (item: any) => item.kind === 'Role' && item.metadata.name === 'lifemodel-applier'
);

describe('core application generation', () => {
  it('runs one ordered StatefulSet with only a bounded memory /tmp and restricted security', () => {
    const statefulSet = application.find((item: any) => item.kind === 'StatefulSet');
    const pod = statefulSet.spec.template.spec;
    expect(statefulSet.spec).toMatchObject({
      replicas: 1,
      podManagementPolicy: 'OrderedReady',
      updateStrategy: { type: 'RollingUpdate' },
    });
    expect(statefulSet.spec.volumeClaimTemplates).toBeUndefined();
    expect(pod.volumes).toEqual([
      { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
      // The loader's settings projection, read-only (ADR-014 D6): the core
      // reads the owner's platform values and can never write them.
      {
        name: 'platform-settings',
        configMap: { name: 'lifemodel-platform-settings', optional: true },
      },
    ]);
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(pod.automountServiceAccountToken).toBe(false);
    const stopDeadlineMs = Number(
      pod.containers[0].env.find((entry: any) => entry.name === 'LIFEMODEL_CORE_STOP_DEADLINE_MS')
        ?.value
    );
    expect(Number.isFinite(stopDeadlineMs)).toBe(true);
    expect(stopDeadlineMs).toBeGreaterThan(0);
    expect(pod.terminationGracePeriodSeconds * 1000).toBeGreaterThan(stopDeadlineMs + 1000);
    expect(pod.containers[0].securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(pod.containers[0].volumeMounts).toEqual([
      { name: 'tmp', mountPath: '/tmp' },
      { name: 'platform-settings', mountPath: PLATFORM_SETTINGS_DIR, readOnly: true },
    ]);
    expect(pod.initContainers[0].command).toEqual([
      '/usr/local/bin/lifemodel-core-entrypoint',
      'migrate',
    ]);
    expect(pod.initContainers[0].image).toBe(pod.containers[0].image);
    expect(pod.containers[0].env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'MOTOR_CORTEX_ENABLED', value: 'false' }),
        expect.objectContaining({ name: 'LIFEMODEL_CORE_STOP_DEADLINE_MS', value: '5000' }),
      ])
    );
    expect(pod.containers[0].readinessProbe.httpGet.path).toBe('/healthz');
    expect(pod.containers[0].livenessProbe.httpGet.path).toBe('/healthz');
  });

  it('pins the application core image by digest, not by a mutable tag', () => {
    const image = kustomization.images.find(
      (entry: any) => entry.name === 'ghcr.io/shady2k/lifemodel-core'
    );
    expect(image?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(image?.newTag).toBeUndefined();
    expect(kustomization.resources).toContain('core.yaml');
  });

  it('grants the application applier the kinds used by every lifemodel seed', () => {
    expect(applier.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['serviceaccounts', 'services'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'statefulsets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
    ]);
    const seedDirectory = fileURLToPath(
      new URL('../../deploy/platform/applications/lifemodel/', import.meta.url)
    );
    const seeded = readdirSync(seedDirectory)
      .filter((name) => name.endsWith('.yaml') && name !== 'kustomization.yaml')
      .flatMap((name) =>
        YAML.parseAllDocuments(readFileSync(join(seedDirectory, name), 'utf8')).map((doc) =>
          doc.toJSON()
        )
      )
      .filter((resource: any) => resource?.metadata?.namespace === 'lifemodel');
    const grants = new Set(
      applier.rules.flatMap((rule: any) =>
        rule.resources.map((resource: string) => `${rule.apiGroups[0]}/${resource}`)
      )
    );
    for (const resource of seeded) {
      const group =
        resource.apiVersion.split('/')[0] === resource.apiVersion
          ? ''
          : resource.apiVersion.split('/')[0];
      expect(
        grants.has(`${group}/${resource.kind.toLowerCase()}s`),
        `${resource.kind} in ${resource.metadata.name} must be permitted to lifemodel-applier`
      ).toBe(true);
    }
  });

  it('mounts the settings projection read-only at the path the core reader reads', () => {
    const statefulSet = application.find((item: any) => item.kind === 'StatefulSet');
    const pod = statefulSet.spec.template.spec;
    const mount = pod.containers[0].volumeMounts.find(
      (entry: any) => entry.name === 'platform-settings'
    );
    expect(mount).toEqual({
      name: 'platform-settings',
      mountPath: PLATFORM_SETTINGS_DIR,
      readOnly: true,
    });
    // The init container migrates the database and never reads the settings.
    expect(pod.initContainers[0].volumeMounts).toEqual([{ name: 'tmp', mountPath: '/tmp' }]);
  });

  it('grants the core no ConfigMap write anywhere in the platform', () => {
    const manifestDirectory = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) files.push(path);
      }
    };
    walk(manifestDirectory);
    const documents = files
      .flatMap((file) =>
        YAML.parseAllDocuments(readFileSync(file, 'utf8')).map((doc) => doc.toJSON())
      )
      .filter((object: any) => object !== null && typeof object === 'object');
    const writeVerbs = new Set(['create', 'update', 'patch', 'delete', 'deletecollection', '*']);
    const configMapWriters = documents.filter((object: any) =>
      ['Role', 'ClusterRole'].includes(object.kind) &&
      (object.rules ?? []).some(
        (rule: any) =>
          (rule.resources ?? []).includes('configmaps') &&
          (rule.verbs ?? []).some((verb: string) => writeVerbs.has(verb))
      )
    );
    // The projection writer exists - the loader's settings Role - and the
    // core is bound to none of the writers.
    expect(
      configMapWriters.some((object: any) => object.metadata.name === 'loader-platform-settings')
    ).toBe(true);
    const bindings = documents.filter((object: any) =>
      ['RoleBinding', 'ClusterRoleBinding'].includes(object.kind)
    );
    for (const binding of bindings) {
      const ref = binding.roleRef ?? {};
      const bindsWriter = configMapWriters.some(
        (writer: any) =>
          writer.kind === ref.kind &&
          writer.metadata.name === ref.name &&
          (ref.kind === 'ClusterRole' || writer.metadata.namespace === binding.metadata.namespace)
      );
      if (!bindsWriter) continue;
      const boundToCore = (binding.subjects ?? []).some(
        (subject: any) => subject.kind === 'ServiceAccount' && subject.name === 'core'
      );
      expect(
        boundToCore,
        `${binding.kind} ${binding.metadata?.name} binds a ConfigMap writer to the core`
      ).toBe(false);
    }
    // And the core keeps no API token its mounts could turn into API access.
    const coreAccount = documents.find(
      (object: any) => object.kind === 'ServiceAccount' && object.metadata.name === 'core'
    );
    expect(coreAccount?.automountServiceAccountToken).toBe(false);
  });

  it('keeps the core and web build scripts separate', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
    ) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.build).not.toContain('build:web');
    expect(manifest.scripts.build).not.toContain('build:app');
    expect(manifest.scripts['build:web']).toContain('build:web-server');
    expect(manifest.scripts['build:web']).toContain('build:app');
  });

  it('builds the core image before pinning it in the release workflow', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)),
      'utf8'
    );
    expect(workflow).toContain('file: docker/core/Dockerfile');
    expect(workflow).toContain('run: scripts/release/set-core-digest.sh');
    expect(workflow.indexOf('id: core')).toBeLessThan(workflow.indexOf('set-core-digest.sh'));
    expect(workflow.indexOf('set-core-digest.sh')).toBeLessThan(
      workflow.indexOf('flux push artifact')
    );
  });

  it('pins core and web digests independently in either release order', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../deploy/platform/applications/lifemodel/kustomization.yaml', import.meta.url)
      ),
      'utf8'
    );
    const coreDigest = `sha256:${'a'.repeat(64)}`;
    const webDigest = `sha256:${'b'.repeat(64)}`;
    const coreScript = fileURLToPath(
      new URL('../../scripts/release/set-core-digest.sh', import.meta.url)
    );
    const webScript = fileURLToPath(
      new URL('../../scripts/release/set-web-digest.sh', import.meta.url)
    );
    const corePlaceholder = `name: ghcr.io/shady2k/lifemodel-core\n    newName: ghcr.io/shady2k/lifemodel-core\n    digest: sha256:${'0'.repeat(64)}`;
    const webPlaceholder = `name: ghcr.io/shady2k/lifemodel-web\n    newName: ghcr.io/shady2k/lifemodel-web\n    digest: sha256:${'0'.repeat(64)}`;

    for (const order of [
      [coreScript, webScript],
      [webScript, coreScript],
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'release-digests-'));
      try {
        const file = join(directory, 'kustomization.yaml');
        writeFileSync(file, source);
        const digests = new Map([
          [coreScript, coreDigest],
          [webScript, webDigest],
        ]);
        for (const script of order) {
          const result = spawnSync('bash', [script, digests.get(script)!, file], {
            encoding: 'utf8',
          });
          expect(result.status, result.stderr).toBe(0);
        }
        expect(readFileSync(file, 'utf8')).toBe(
          source
            .replace(
              corePlaceholder,
              corePlaceholder.replace(`sha256:${'0'.repeat(64)}`, coreDigest)
            )
            .replace(webPlaceholder, webPlaceholder.replace(`sha256:${'0'.repeat(64)}`, webDigest))
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it.each([
    ['zero core placeholders', 'core', ''],
    ['two core placeholders', 'core', 'duplicate'],
    ['zero web placeholders', 'web', ''],
    ['two web placeholders', 'web', 'duplicate'],
  ])('refuses %s', (_description, image, variant) => {
    const directory = mkdtempSync(join(tmpdir(), 'release-digest-invalid-'));
    try {
      const file = join(directory, 'kustomization.yaml');
      const core = `  - name: ghcr.io/shady2k/lifemodel-core\n    digest: sha256:${'0'.repeat(64)}\n`;
      const web = `  - name: ghcr.io/shady2k/lifemodel-web\n    digest: sha256:${'0'.repeat(64)}\n`;
      const ownEntry = image === 'core' ? core : web;
      const otherEntry = image === 'core' ? web : core;
      writeFileSync(file, `images:\n${variant === 'duplicate' ? ownEntry + ownEntry : otherEntry}`);
      const script = fileURLToPath(
        new URL(
          image === 'core'
            ? '../../scripts/release/set-core-digest.sh'
            : '../../scripts/release/set-web-digest.sh',
          import.meta.url
        )
      );
      const result = spawnSync('bash', [script, `sha256:${'c'.repeat(64)}`, file], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`found ${variant === 'duplicate' ? 2 : 0}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('assembles store URLs from secret-backed variables in the image entrypoint', () => {
    const entrypoint = readFileSync(
      fileURLToPath(new URL('../../docker/core/entrypoint.sh', import.meta.url)),
      'utf8'
    );
    expect(entrypoint).toContain('LIFEMODEL_DATABASE_URL=');
    expect(entrypoint).toContain('LIFEMODEL_VALKEY_URL=');
    expect(entrypoint).toContain('scripts/apply-migrations.js');
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../docker/core/Dockerfile', import.meta.url)),
      'utf8'
    );
    expect(dockerfile).toContain('db/migrations');
    expect(dockerfile).toContain('scripts/apply-migrations.js');
  });
});
