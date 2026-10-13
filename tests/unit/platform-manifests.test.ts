import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? yamlFiles(path) : entry.name.endsWith('.yaml') ? [path] : [];
  });
}

function parseYamlFiles(files: string[]): Record<string, any>[] {
  return files.flatMap((file) => {
    const documents = YAML.parseAllDocuments(readFileSync(file, 'utf8'));
    expect(documents.flatMap((document) => document.errors)).toEqual([]);
    return documents.map((document) => document.toJSON() as Record<string, any>);
  });
}

function loadObjects(): Record<string, any>[] {
  try {
    const rendered = execFileSync('kustomize', ['build', platformRoot], { encoding: 'utf8' });
    return YAML.parseAllDocuments(rendered).map((doc) => doc.toJSON() as Record<string, any>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The isolated launcher does not provision kustomize. Validate the declared resources directly.
    const configs = parseYamlFiles(yamlFiles(platformRoot).filter((file) => file.endsWith('kustomization.yaml')));
    const resources = [
      ...parseYamlFiles(yamlFiles(join(platformRoot, 'a0')).filter((file) => !file.endsWith('kustomization.yaml'))),
      ...parseYamlFiles([join(platformRoot, 'a0-reconciler.yaml')]),
    ];
    const imagePin = configs.flatMap((config) => config.images ?? []).find((image) => image.digest);
    const deployment = resources.find((item) => item.kind === 'Deployment');
    if (deployment && imagePin) {
      const container = deployment.spec.template.spec.containers[0];
      if (container.image.startsWith(`${imagePin.name}:`)) {
        container.image = `${imagePin.newName ?? imagePin.name}@${imagePin.digest}`;
      }
    }
    return resources;
  }
}

function expectValidPlatform(objects: Record<string, any>[]): void {
  expect(objects.length).toBeGreaterThan(0);
  const object = (kind: string) => {
    const found = objects.find((item) => item.kind === kind);
    expect(found, `missing ${kind}`).toBeDefined();
    return found!;
  };
  for (const item of objects) {
    if (item.kind === 'Namespace') {
      expect(item.metadata.name).toBe('lifemodel-system');
    } else if (item.kind === 'Kustomization' && item.apiVersion?.startsWith('kustomize.toolkit.fluxcd.io/')) {
      expect(item.metadata.namespace).toBe('flux-system');
    } else {
      expect(item.metadata.namespace).toBe('lifemodel-system');
    }
  }

  const deployment = object('Deployment');
  expect(deployment.spec.replicas).toBe(1);
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  expect(container.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  expect(container.env).toContainEqual({ name: 'LIFEMODEL_LOADER_MODE', value: 'platform' });
  expect(container.ports).toContainEqual(expect.objectContaining({ containerPort: 7000 }));
  expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } });
  expect(container.securityContext).toMatchObject({
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
    seccompProfile: { type: 'RuntimeDefault' },
  });
  expect(container.volumeMounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'state', mountPath: '/var/lib/loader' }),
    expect.objectContaining({ name: 'tmp', mountPath: '/tmp' }),
  ]));
  expect(pod.volumes).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'state', persistentVolumeClaim: expect.any(Object) }),
    expect.objectContaining({ name: 'tmp', emptyDir: expect.any(Object) }),
  ]));
  expect(container.readinessProbe).toBeDefined();
  expect(container.livenessProbe).toBeDefined();

  expect(object('Namespace').metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
  expect(object('PersistentVolumeClaim').spec.storageClassName).toBe('local-path');
  const policy = object('NetworkPolicy');
  expect(policy.spec.podSelector).toEqual({});
  expect(policy.spec.policyTypes).toEqual(expect.arrayContaining(['Ingress', 'Egress']));
  expect(policy.spec.ingress).toEqual([expect.objectContaining({
    from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
    ports: [expect.objectContaining({ port: 7000 })],
  })]);
  expect(policy.spec.egress).toEqual([]);

  const fluxObjects = objects.filter(
    (item) => item.kind === 'Kustomization' && item.apiVersion?.startsWith('kustomize.toolkit.fluxcd.io/')
  );
  expect(fluxObjects).toHaveLength(1);
  const flux = fluxObjects[0];
  expect(flux.metadata.name).toBe('platform-a0');
  expect(flux.spec).toMatchObject({ path: './a0', prune: true, wait: true });
  expect(flux.spec.dependsOn ?? []).toEqual([]);
  expect(objects.filter((item) => item.kind === 'ServiceAccount')[0].automountServiceAccountToken).toBe(false);
  expect(object('Ingress').spec.rules[0].host).toBe('boot.localhost');
  expect(objects.some((item) => ['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding'].includes(item.kind))).toBe(false);
}

describe('platform manifests', () => {
  it('contains valid, confined, digest-pinned A0 manifests', () => {
    const sourceFiles = yamlFiles(platformRoot);
    const parsedSource = parseYamlFiles(sourceFiles);
    expect(parsedSource.length).toBeGreaterThan(0);
    expectValidPlatform(loadObjects());
  });

  it('rejects a loader image that uses a tag instead of a digest', () => {
    const objects = loadObjects();
    const deployment = objects.find((item) => item.kind === 'Deployment');
    expect(deployment).toBeDefined();
    deployment!.spec.template.spec.containers[0].image = 'ghcr.io/shady2k/lifemodel-loader:latest';
    expect(() => expectValidPlatform(objects)).toThrow();
  });
});
