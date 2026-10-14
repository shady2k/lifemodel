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
    return entry.isDirectory() ? allYaml(path) : entry.name.endsWith('.yaml') && !path.endsWith('kustomization.yaml')
      ? YAML.parseAllDocuments(readFileSync(path, 'utf8')).map((doc) => doc.toJSON()) : [];
  });
}

describe('CloudNativePG platform state', () => {
  it('pins the latest stable vendored operator and operator image by digest', () => {
    const chart = YAML.parse(readFileSync(join(root, 'charts/cloudnative-pg/Chart.yaml'), 'utf8'));
    expect(chart.version).toBe('0.29.1');
    const operator = allYaml(join(root, 'b/operator'));
    expect(operator.some((item) => item.kind === 'CustomResourceDefinition' && item.metadata.name === 'clusters.postgresql.cnpg.io')).toBe(true);
    const deployment = operator.find((item) => item.kind === 'Deployment' && item.metadata.name === 'cloudnative-pg');
    expect(deployment).toBeDefined();
    expect(deployment.spec.template.spec.containers[0].image).toMatch(/@sha256:[a-f0-9]{64}$/);
  });

  it('applies CRDs before the operator and the database step after both', () => {
    const rootObjects = YAML.parseAllDocuments(readFileSync(join(root, 'kustomization.yaml'), 'utf8'));
    expect(rootObjects.flatMap((doc) => doc.errors)).toEqual([]);
    expect(rootObjects.map((doc) => doc.toJSON().resources ?? []).flat()).toEqual(expect.arrayContaining(['a-reconciler.yaml', 'b-reconciler.yaml', 'c-reconciler.yaml']));
    const reconcilerFiles = ['a-reconciler.yaml', 'b-reconciler.yaml', 'c-reconciler.yaml'];
    const steps = reconcilerFiles.map((file) => YAML.parse(readFileSync(join(root, file), 'utf8')));
    expect(steps.map((step) => step.metadata.name)).toEqual(['platform-a', 'platform-b', 'platform-c']);
    expect(steps[1].spec.dependsOn).toEqual([{ name: 'platform-a' }]);
    expect(steps[2].spec.dependsOn).toEqual([{ name: 'platform-b' }]);
    expect(steps[2].spec.wait).toBe(true);
    const crds = allYaml(join(root, 'b/operator'));
    expect(crds.some((item) => item.kind === 'CustomResourceDefinition' && item.metadata.name === 'clusters.postgresql.cnpg.io')).toBe(true);
    expect(allYaml(join(stateRoot, 'cluster')).some((item) => item.kind === 'Cluster')).toBe(true);
  });

  it('declares the singleton database, owner role, pgvector image and retained PVC', () => {
    const cluster = YAML.parse(readFileSync(join(stateRoot, 'cluster/cluster.yaml'), 'utf8'));
    expect(cluster).toMatchObject({
      apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster',
      metadata: { name: 'lifemodel', namespace: 'lifemodel-state' },
      spec: {
        instances: 1,
        imageName: 'ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm@sha256:fe22b9fcd038dcd08c2019b17d95f517f137801e5f39d857a895d65e8c63033b',
        bootstrap: { initdb: { database: 'lifemodel', owner: 'lifemodel' } },
        storage: { size: '4Gi', storageClass: 'local-path' },
      },
    });
    expect(cluster.spec.imageName).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(cluster.spec.postInitApplicationSQL).toEqual(['CREATE EXTENSION IF NOT EXISTS vector;']);
    expect(cluster.spec.bootstrap.initdb).not.toHaveProperty('secret');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('generated `lifemodel-app` Secret');
    expect(readFileSync(fileURLToPath(new URL('../../loader/src/postgres.ts', import.meta.url)), 'utf8')).toContain("const SOURCE_NAME = 'lifemodel-app'");
  });

  it('limits database ingress to the core namespace and CNPG operator ports', () => {
    const policies = allYaml(stateRoot).filter((item) => item.kind === 'NetworkPolicy');
    const deny = policies.find((item) => item.metadata.name === 'lifemodel-state-default-deny');
    expect(deny?.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] });
    const database = policies.find((item) => item.metadata.name === 'lifemodel-state-postgres-access');
    expect(database?.spec.ingress).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: [expect.objectContaining({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel' } } })], ports: [{ protocol: 'TCP', port: 5432 }] }),
      expect.objectContaining({ ports: expect.arrayContaining([{ protocol: 'TCP', port: 5432 }, { protocol: 'TCP', port: 8000 }]) }),
    ]));
    expect(database?.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(database?.spec.egress).toEqual([]);
  });

  it('refuses application Kustomizations that target platform-owned state', () => {
    const policies = YAML.parseAllDocuments(readFileSync(join(root, 'a0/admission-policies.yaml'), 'utf8')).map((doc) => doc.toJSON());
    const policy = policies.find((item) => item.kind === 'ValidatingAdmissionPolicy' && item.metadata.name === 'application-kustomization-admission');
    expect(policy).toBeDefined();
    const targetGuard = policy.spec.validations.map((rule: any) => rule.expression).join(' ');
    expect(targetGuard).toContain('object.spec.targetNamespace == request.namespace');
    const admissionAllows = (requestNamespace: string, targetNamespace: string) =>
      ['lifemodel', 'lifemodel-motor'].includes(requestNamespace) && targetNamespace === requestNamespace;
    for (const namespace of ['lifemodel', 'lifemodel-motor']) {
      expect(admissionAllows(namespace, namespace)).toBe(true);
      expect(admissionAllows(namespace, 'lifemodel-state')).toBe(false);
    }
    expect(policy.spec.failurePolicy).toBe('Fail');
    const secretPolicy = YAML.parseAllDocuments(readFileSync(join(root, 'a0/admission-policies.yaml'), 'utf8')).map((doc) => doc.toJSON())
      .find((item) => item.kind === 'ValidatingAdmissionPolicy' && item.metadata.name === 'loader-secret-admission');
    expect(secretPolicy.spec.validations.map((rule: any) => rule.expression).join(' ')).toContain("object.metadata.name == 'lifemodel-db-credentials'");
    const stateAccess = YAML.parseAllDocuments(readFileSync(join(stateRoot, 'credentials-rbac.yaml'), 'utf8')).map((doc) => doc.toJSON());
    expect(stateAccess).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Role', metadata: { name: 'loader-copy-cnpg-credentials', namespace: 'lifemodel-state' }, rules: [{ apiGroups: [''], resources: ['secrets'], resourceNames: ['lifemodel-app'], verbs: ['get'] }] }),
      expect.objectContaining({ kind: 'RoleBinding', metadata: { name: 'loader-copy-cnpg-credentials', namespace: 'lifemodel-state' }, subjects: [expect.objectContaining({ name: 'loader', namespace: 'lifemodel-system' })] }),
    ]));
    expect(policies.find((item) => item.kind === 'ValidatingAdmissionPolicyBinding' && item.metadata.name === 'application-kustomization-admission')?.spec.validationActions).toContain('Deny');
  });

  it('rejects a tag-only database image', () => {
    const cluster = YAML.parse(readFileSync(join(stateRoot, 'cluster/cluster.yaml'), 'utf8'));
    const valid = (image: string) => /^.+@sha256:[a-f0-9]{64}$/.test(image);
    expect(valid(cluster.spec.imageName)).toBe(true);
    expect(valid('ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm')).toBe(false);
  });
});
