import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const appRoot = join(root, 'deploy/platform/applications/lifemodel');
const workload = YAML.parseAllDocuments(readFileSync(join(appRoot, 'web.yaml'), 'utf8')).map(
  (doc) => doc.toJSON()
);

describe('web application generation', () => {
  it('runs independently with restricted security, store probes, and bounded resources', () => {
    const deployment = workload.find((item: any) => item.kind === 'Deployment');
    const pod = deployment.spec.template.spec;
    const container = pod.containers[0];
    expect(deployment.spec.strategy).toEqual({
      type: 'RollingUpdate',
      rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    });
    expect(deployment.spec.replicas).toBe(1);
    expect(container.resources.requests.cpu).toBe('50m');
    expect(container.resources.limits).toEqual({ cpu: 1, memory: '768Mi' });
    // The repo's platform manifests do not declare node/system workload requests,
    // so the complete 2-vCPU node budget cannot be derived here. Keep the web
    // footprint bounded and assert the platform-owned core scheduling priority.
    expect(container.image).toBe('ghcr.io/shady2k/lifemodel-web');
    expect(container.readinessProbe).toMatchObject({
      httpGet: { path: '/readyz', port: 'internal' },
    });
    expect(container.ports).toEqual([
      { name: 'http', containerPort: 8080, protocol: 'TCP' },
      { name: 'internal', containerPort: 8081, protocol: 'TCP' },
    ]);
    expect(container.env).toEqual(
      expect.arrayContaining([
        {
          name: 'LIFEMODEL_NAME',
          valueFrom: { configMapKeyRef: { name: 'lifemodel-instance', key: 'LIFEMODEL_NAME' } },
        },
        { name: 'LIFEMODEL_WEB_ALLOWED_ORIGIN', value: 'https://$(LIFEMODEL_NAME).local' },
        { name: 'LIFEMODEL_WEB_PORT', value: '8080' },
        { name: 'LIFEMODEL_WEB_INTERNAL_PORT', value: '8081' },
        { name: 'LIFEMODEL_WEB_APP_DIRECTORY', value: '/opt/lifemodel/web/app' },
        expect.objectContaining({
          name: 'LIFEMODEL_DB_USERNAME',
          valueFrom: { secretKeyRef: { name: 'lifemodel-db-credentials', key: 'username' } },
        }),
        expect.objectContaining({
          name: 'LIFEMODEL_DB_PASSWORD',
          valueFrom: { secretKeyRef: { name: 'lifemodel-db-credentials', key: 'password' } },
        }),
        expect.objectContaining({
          name: 'LIFEMODEL_VALKEY_PASSWORD',
          valueFrom: { secretKeyRef: { name: 'lifemodel-valkey-credentials', key: 'password' } },
        }),
      ])
    );
    expect(container.resources.requests).toBeDefined();
    expect(container.resources.limits).toBeDefined();
    expect(container.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(pod.volumes).toContainEqual({
      name: 'tmp',
      emptyDir: { medium: 'Memory', sizeLimit: '128Mi' },
    });
    expect(workload.find((item: any) => item.kind === 'Service').spec.ports).toEqual([
      { name: 'http', port: 8080, targetPort: 'http', protocol: 'TCP' },
    ]);
    expect(workload.find((item: any) => item.kind === 'Service').spec.ports).not.toContainEqual(
      expect.objectContaining({ port: 8081, targetPort: 'internal' })
    );
  });

  it('keeps the core above web pods through a platform-owned PriorityClass', () => {
    const platformKustomization = YAML.parse(
      readFileSync(join(root, 'deploy/platform/a0/kustomization.yaml'), 'utf8')
    );
    expect(platformKustomization.resources).toContain('core-priority-class.yaml');
    const priorityClass = YAML.parse(
      readFileSync(join(root, 'deploy/platform/a0/core-priority-class.yaml'), 'utf8')
    );
    expect(priorityClass).toMatchObject({
      apiVersion: 'scheduling.k8s.io/v1',
      kind: 'PriorityClass',
      metadata: { name: 'lifemodel-core' },
      value: 1000000,
      globalDefault: false,
    });
    const core = YAML.parseAllDocuments(readFileSync(join(appRoot, 'core.yaml'), 'utf8'))
      .map((doc) => doc.toJSON())
      .find((item: any) => item.kind === 'StatefulSet');
    expect(core.spec.template.spec.priorityClassName).toBe('lifemodel-core');
  });

  it('builds the web image in CI and pins its release digest before rendering the seed', () => {
    const kustomization = YAML.parse(readFileSync(join(appRoot, 'kustomization.yaml'), 'utf8'));
    expect(kustomization.resources).toEqual(['core.yaml', 'web.yaml']);
    expect(kustomization.images).toContainEqual(
      expect.objectContaining({
        name: 'ghcr.io/shady2k/lifemodel-web',
        digest: `sha256:${'0'.repeat(64)}`,
      })
    );
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(ci).toContain('ci-web-image:');
    expect(ci).toContain('scripts/build-web-image.sh');
    expect(ci).toContain('ci-web-image-publish:');
    expect(ci).toContain('ghcr.io/shady2k/lifemodel-web');
    expect(release).toContain('file: docker/web/Dockerfile');
    expect(release).toContain('scripts/release/set-web-digest.sh');
    expect(release.indexOf('id: web')).toBeLessThan(release.indexOf('set-web-digest.sh'));
    expect(release.indexOf('set-web-digest.sh')).toBeLessThan(
      release.indexOf('flux push artifact')
    );

    const directory = mkdtempSync(join(tmpdir(), 'web-digest-'));
    try {
      const file = join(directory, 'kustomization.yaml');
      writeFileSync(
        file,
        `images:\n  - name: ghcr.io/shady2k/lifemodel-core\n    digest: sha256:${'0'.repeat(64)}\n  - name: ghcr.io/shady2k/lifemodel-web\n    digest: sha256:${'0'.repeat(64)}\n`
      );
      const digest = `sha256:${'b'.repeat(64)}`;
      const result = spawnSync(
        'bash',
        [join(root, 'scripts/release/set-web-digest.sh'), digest, file],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      expect(readFileSync(file, 'utf8')).toContain(
        `name: ghcr.io/shady2k/lifemodel-web\n    digest: ${digest}`
      );
      expect(readFileSync(file, 'utf8')).toContain(
        `name: ghcr.io/shady2k/lifemodel-core\n    digest: sha256:${'0'.repeat(64)}`
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
