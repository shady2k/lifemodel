import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const stateRoot = join(root, 'state');

function allYaml(directory: string): any[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? allYaml(path)
      : entry.name.endsWith('.yaml') && !path.endsWith('kustomization.yaml')
        ? YAML.parseAllDocuments(readFileSync(path, 'utf8')).map((doc) => doc.toJSON())
        : [];
  });
}

describe('Valkey platform state', () => {
  const objects = allYaml(stateRoot);
  const valkey = objects.find(
    (item) => item.kind === 'StatefulSet' && item.metadata.name === 'valkey'
  );

  it('is installed by step C beside CloudNativePG', () => {
    const c = YAML.parse(readFileSync(join(root, 'c-reconciler.yaml'), 'utf8'));
    const kustomization = YAML.parse(readFileSync(join(stateRoot, 'kustomization.yaml'), 'utf8'));
    expect(c.spec.path).toBe('./state');
    expect(kustomization.resources).toContain('valkey.yaml');
    expect(valkey.metadata.namespace).toBe('lifemodel-state');
    expect(
      objects.some(
        (item) => item.kind === 'Cluster' && item.metadata.namespace === valkey.metadata.namespace
      )
    ).toBe(true);
  });

  it('independently protects the Valkey StatefulSet and claim template from Flux pruning', () => {
    expect(valkey.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
    const claim = valkey.spec.volumeClaimTemplates.find(
      (item: any) => item.metadata.name === 'data'
    );
    expect(claim.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
  });

  it('pins the Valkey image by digest and requires durable writes', () => {
    const container = valkey.spec.template.spec.containers.find(
      (item: any) => item.name === 'valkey'
    );
    expect(container.image).toBe(
      'valkey/valkey:8.1-bookworm@sha256:fea8b3e67b15729d4bb70589eb03367bab9ad1ee89c876f54327fc7c6e618571'
    );
    expect(container.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(container.args).toEqual(
      expect.arrayContaining(['--appendonly', 'yes', '--appendfsync', 'always'])
    );
    expect(container.args).toEqual(expect.arrayContaining(['--requirepass', '$(VALKEY_PASSWORD)']));
    expect(container.env).toContainEqual(
      expect.objectContaining({
        name: 'VALKEY_PASSWORD',
        valueFrom: { secretKeyRef: { name: 'lifemodel-valkey-credentials', key: 'password' } },
      })
    );
  });

  it('stores the Valkey data directory on its own local-path PVC', () => {
    const container = valkey.spec.template.spec.containers[0];
    expect(container.volumeMounts).toContainEqual(
      expect.objectContaining({ name: 'data', mountPath: '/data' })
    );
    expect(valkey.spec.volumeClaimTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ name: 'data' }),
          spec: {
            storageClassName: 'local-path',
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: '1Gi' } },
          },
        }),
      ])
    );
  });

  it('runs under restricted PodSecurity and exposes health probes through a ClusterIP Service', () => {
    const pod = valkey.spec.template.spec;
    const container = pod.containers[0];
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(container.readinessProbe).toBeDefined();
    expect(container.livenessProbe).toBeDefined();
    expect(
      objects.find((item) => item.kind === 'Service' && item.metadata.name === 'valkey')
    ).toMatchObject({
      metadata: { namespace: 'lifemodel-state' },
      spec: { type: 'ClusterIP', ports: [{ port: 6379, targetPort: 6379 }] },
    });
  });

  it('admits only lifemodel pods to Valkey and opens only core egress to port 6379', () => {
    const statePolicies = objects.filter((item) => item.kind === 'NetworkPolicy');
    const ingress = statePolicies.find(
      (item) => item.metadata.name === 'lifemodel-state-valkey-access'
    );
    expect(ingress.spec.podSelector.matchLabels).toEqual({ app: 'valkey' });
    expect(ingress.spec.ingress).toEqual([
      {
        from: [
          { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel' } } },
        ],
        ports: [{ protocol: 'TCP', port: 6379 }],
      },
    ]);
    const apps = YAML.parseAllDocuments(
      readFileSync(join(root, 'a/applications.yaml'), 'utf8')
    ).map((doc) => doc.toJSON());
    const egress = apps.find(
      (item) => item.kind === 'NetworkPolicy' && item.metadata.name === 'lifemodel-valkey-egress'
    );
    expect(egress?.metadata.namespace).toBe('lifemodel');
    expect(egress?.spec.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-state' },
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 6379 }],
      },
    ]);
  });
});
