import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { evaluate } from '@marcbachmann/cel-js';

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

describe('CloudNativePG platform state', () => {
  it('pins the latest stable vendored operator and operator image by digest', () => {
    const chart = YAML.parse(readFileSync(join(root, 'charts/cloudnative-pg/Chart.yaml'), 'utf8'));
    expect(chart.version).toBe('0.29.1');
    const operator = allYaml(join(root, 'b/operator'));
    expect(
      operator.some(
        (item) =>
          item.kind === 'CustomResourceDefinition' &&
          item.metadata.name === 'clusters.postgresql.cnpg.io'
      )
    ).toBe(true);
    const deployment = operator.find(
      (item) => item.kind === 'Deployment' && item.metadata.name === 'cloudnative-pg'
    );
    expect(deployment).toBeDefined();
    expect(deployment.spec.template.spec.containers[0].image).toMatch(/@sha256:[a-f0-9]{64}$/);
  });

  it('independently protects the state namespace and CNPG Cluster from Flux pruning', () => {
    const namespace = YAML.parse(readFileSync(join(stateRoot, 'namespace.yaml'), 'utf8'));
    const cluster = YAML.parse(readFileSync(join(stateRoot, 'cluster/cluster.yaml'), 'utf8'));
    expect(namespace.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
    expect(cluster.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
  });

  it('default-denies the operator namespace and permits only declared routes', () => {
    const files = YAML.parse(readFileSync(join(root, 'b/kustomization.yaml'), 'utf8')).resources;
    expect(files).toContain('network-policy.yaml');
    const policies = YAML.parseAllDocuments(
      readFileSync(join(root, 'b/network-policy.yaml'), 'utf8')
    ).map((doc) => doc.toJSON());
    const deny = policies.find((item) => item.metadata.name === 'cnpg-system-default-deny');
    expect(deny).toMatchObject({
      metadata: { namespace: 'cnpg-system' },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] },
    });
    const routes = policies.find((item) => item.metadata.name === 'cnpg-operator-routes');
    expect(routes.metadata.namespace).toBe('cnpg-system');
    expect(routes.spec.ingress).toEqual([
      {
        from: [
          { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
        ],
        ports: [{ protocol: 'TCP', port: 9443 }],
      },
    ]);
    expect(routes.spec.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          },
        ],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
      { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-state' },
            },
            podSelector: { matchLabels: { 'cnpg.io/cluster': 'lifemodel' } },
          },
        ],
        ports: [
          { protocol: 'TCP', port: 5432 },
          { protocol: 'TCP', port: 8000 },
        ],
      },
    ]);
    const operator = allYaml(join(root, 'b/operator')).find(
      (item) => item.kind === 'Service' && item.metadata.name === 'cnpg-webhook-service'
    );
    expect(operator.spec.ports).toContainEqual({
      port: 443,
      targetPort: 'webhook-server',
      name: 'webhook-server',
    });
  });

  it('applies CRDs before the operator and the database step after both', () => {
    const rootObjects = YAML.parseAllDocuments(
      readFileSync(join(root, 'kustomization.yaml'), 'utf8')
    );
    expect(rootObjects.flatMap((doc) => doc.errors)).toEqual([]);
    expect(rootObjects.map((doc) => doc.toJSON().resources ?? []).flat()).toEqual(
      expect.arrayContaining(['a-reconciler.yaml', 'b-reconciler.yaml', 'c-reconciler.yaml'])
    );
    const reconcilerFiles = ['a-reconciler.yaml', 'b-reconciler.yaml', 'c-reconciler.yaml'];
    const steps = reconcilerFiles.map((file) => YAML.parse(readFileSync(join(root, file), 'utf8')));
    expect(steps.map((step) => step.metadata.name)).toEqual([
      'platform-a',
      'platform-b',
      'platform-c',
    ]);
    expect(steps[1].spec.dependsOn).toEqual([{ name: 'platform-a' }]);
    expect(steps[2].spec.dependsOn).toEqual([{ name: 'platform-b' }]);
    expect(steps[2].spec.wait).toBe(true);
    const crds = allYaml(join(root, 'b/operator'));
    expect(
      crds.some(
        (item) =>
          item.kind === 'CustomResourceDefinition' &&
          item.metadata.name === 'clusters.postgresql.cnpg.io'
      )
    ).toBe(true);
    expect(allYaml(join(stateRoot, 'cluster')).some((item) => item.kind === 'Cluster')).toBe(true);
  });

  it('declares the singleton database, owner role, pgvector image and retained PVC', () => {
    const cluster = YAML.parse(readFileSync(join(stateRoot, 'cluster/cluster.yaml'), 'utf8'));
    expect(cluster).toMatchObject({
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: { name: 'lifemodel', namespace: 'lifemodel-state' },
      spec: {
        instances: 1,
        imageName:
          'ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm@sha256:fe22b9fcd038dcd08c2019b17d95f517f137801e5f39d857a895d65e8c63033b',
        bootstrap: { initdb: { database: 'lifemodel', owner: 'lifemodel' } },
        storage: { size: '4Gi', storageClass: 'local-path' },
      },
    });
    expect(cluster.spec.imageName).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(cluster.spec.bootstrap.initdb.postInitApplicationSQL).toEqual([
      'CREATE EXTENSION IF NOT EXISTS vector;',
    ]);
    expect(cluster.spec.bootstrap.initdb).not.toHaveProperty('secret');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(
      'generated `lifemodel-app` Secret'
    );
    expect(
      readFileSync(fileURLToPath(new URL('../../loader/src/postgres.ts', import.meta.url)), 'utf8')
    ).toContain("const SOURCE_NAME = 'lifemodel-app'");
  });

  it('provisions a dedicated capture writer and SELECT-only reader without owner membership for the writer', () => {
    const cluster = YAML.parse(readFileSync(join(stateRoot, 'cluster/cluster.yaml'), 'utf8'));
    expect(cluster.spec.managed.roles).toEqual([
      {
        name: 'lifemodel_capture_writer',
        ensure: 'present',
        login: true,
        passwordSecret: { name: 'lifemodel-capture-credentials' },
      },
      { name: 'lifemodel_capture_reader', ensure: 'present', login: false },
      { name: 'lifemodel', ensure: 'present', login: true, inRoles: ['lifemodel_capture_reader'] },
    ]);
    const gateway = allYaml(join(root, 'a')).find(
      (item) => item.kind === 'Deployment' && item.metadata.name === 'model-gateway'
    );
    const container = gateway.spec.template.spec.containers[0];
    expect(container.env).toEqual(
      expect.arrayContaining([
        {
          name: 'LIFEMODEL_CAPTURE_DB_USERNAME_FILE',
          value: '/opt/lifemodel/capture-database/username',
        },
        {
          name: 'LIFEMODEL_CAPTURE_DB_PASSWORD_FILE',
          value: '/opt/lifemodel/capture-database/password',
        },
      ])
    );
    expect(gateway.spec.template.spec.volumes).toContainEqual({
      name: 'capture-database',
      secret: { secretName: 'model-capture-db-credentials', optional: true, defaultMode: 288 },
    });
    const grant = allYaml(stateRoot).find(
      (item) => item.kind === 'Role' && item.metadata.name === 'loader-capture-credentials'
    );
    expect(grant.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['secrets'],
        resourceNames: ['lifemodel-capture-credentials'],
        verbs: ['get'],
      },
      { apiGroups: [''], resources: ['secrets'], verbs: ['create'] },
    ]);
  });

  it('limits database ingress to the core namespace and CNPG operator ports', () => {
    const policies = allYaml(stateRoot).filter((item) => item.kind === 'NetworkPolicy');
    const deny = policies.find((item) => item.metadata.name === 'lifemodel-state-default-deny');
    expect(deny?.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    });
    const database = policies.find(
      (item) => item.metadata.name === 'lifemodel-state-postgres-access'
    );
    expect(database?.spec.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: [
            expect.objectContaining({
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel' } },
            }),
          ],
          ports: [{ protocol: 'TCP', port: 5432 }],
        }),
        expect.objectContaining({
          ports: expect.arrayContaining([
            { protocol: 'TCP', port: 5432 },
            { protocol: 'TCP', port: 8000 },
          ]),
        }),
      ])
    );
    expect(database?.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(database?.spec.egress).toEqual([
      expect.objectContaining({
        to: [
          expect.objectContaining({
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          }),
        ],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      }),
      { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
    ]);
  });

  it('allows core egress to the state Postgres Service through its namespace default deny', () => {
    const objects = YAML.parseAllDocuments(
      readFileSync(join(root, 'a/applications.yaml'), 'utf8')
    ).map((doc) => doc.toJSON());
    const policy = objects.find(
      (item) => item.kind === 'NetworkPolicy' && item.metadata.name === 'lifemodel-postgres-egress'
    );
    expect(policy?.metadata.namespace).toBe('lifemodel');
    expect(policy?.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'core' } },
      policyTypes: ['Egress'],
      ingress: [],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-state' },
              },
            },
          ],
          ports: [{ protocol: 'TCP', port: 5432 }],
        },
      ],
    });
    const dns = objects.find(
      (item) => item.kind === 'NetworkPolicy' && item.metadata.name === 'lifemodel-dns-egress'
    );
    expect(dns?.metadata.namespace).toBe('lifemodel');
    expect(dns?.spec.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          },
        ],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
    ]);
  });

  it('evaluates the rendered application admission CEL and denies platform-owned state', () => {
    const policies = YAML.parseAllDocuments(
      readFileSync(join(root, 'a0/admission-policies.yaml'), 'utf8')
    ).map((doc) => doc.toJSON());
    const policy = policies.find(
      (item) =>
        item.kind === 'ValidatingAdmissionPolicy' &&
        item.metadata.name === 'application-kustomization-admission'
    );
    expect(policy).toBeDefined();
    const expression = policy.spec.validations[0].expression;
    const request = {
      operation: 'CREATE',
      namespace: 'lifemodel',
      userInfo: { username: 'system:serviceaccount:lifemodel:applier' },
    };
    const validObject = {
      metadata: { name: 'application' },
      spec: {
        serviceAccountName: 'lifemodel-applier',
        sourceRef: { kind: 'GitRepository', name: 'lifemodel' },
        targetNamespace: 'lifemodel',
        path: './deploy/platform/applications/lifemodel',
      },
    };
    expect(evaluate(expression, { request, object: validObject })).toBe(true);
    expect(
      evaluate(expression, {
        request,
        object: {
          ...validObject,
          spec: { ...validObject.spec, targetNamespace: 'lifemodel-state' },
        },
      })
    ).toBe(false);
    expect(policy.spec.failurePolicy).toBe('Fail');
    const secretPolicy = policies.find(
      (item) =>
        item.kind === 'ValidatingAdmissionPolicy' &&
        item.metadata.name === 'loader-secret-admission'
    );
    expect(secretPolicy.spec.validations.map((rule: any) => rule.expression).join(' ')).toContain(
      "object.metadata.name == 'lifemodel-db-credentials'"
    );
    const stateAccess = YAML.parseAllDocuments(
      readFileSync(join(stateRoot, 'credentials-rbac.yaml'), 'utf8')
    ).map((doc) => doc.toJSON());
    expect(stateAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'Role',
          metadata: { name: 'loader-copy-cnpg-credentials', namespace: 'lifemodel-state' },
          rules: [
            {
              apiGroups: [''],
              resources: ['secrets'],
              resourceNames: ['lifemodel-app'],
              verbs: ['get'],
            },
          ],
        }),
        expect.objectContaining({
          kind: 'RoleBinding',
          metadata: { name: 'loader-copy-cnpg-credentials', namespace: 'lifemodel-state' },
          subjects: [expect.objectContaining({ name: 'loader', namespace: 'lifemodel-system' })],
        }),
      ])
    );
    expect(
      policies.find(
        (item) =>
          item.kind === 'ValidatingAdmissionPolicyBinding' &&
          item.metadata.name === 'application-kustomization-admission'
      )?.spec.validationActions
    ).toContain('Deny');
  });

  it('rejects a tag-only database image', () => {
    const cluster = YAML.parse(readFileSync(join(stateRoot, 'cluster/cluster.yaml'), 'utf8'));
    const valid = (image: string) => /^.+@sha256:[a-f0-9]{64}$/.test(image);
    expect(valid(cluster.spec.imageName)).toBe(true);
    expect(valid('ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm')).toBe(false);
  });
});
