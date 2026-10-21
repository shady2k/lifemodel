/** Storage identity and listener isolation in the signed platform (ADR-015 S-D1/S-D2). */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { platformFirstStartPhases } from '../../loader/src/app.js';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
type Manifest = Record<string, any>;
function documents(path: string): Manifest[] {
  return YAML.parseAllDocuments(readFileSync(join(platformRoot, path), 'utf8')).map(
    (document) => document.toJSON() as Manifest
  );
}
const stepD = readdirSync(join(platformRoot, 'd'))
  .filter((name) => name.endsWith('.yaml') && name !== 'kustomization.yaml')
  .flatMap((name) => documents(`d/${name}`));
const policies = [
  ...documents('a0/network-policy.yaml'),
  ...documents('a/network-policy.yaml'),
  ...documents('a/applications.yaml'),
  ...stepD,
].filter((item) => item.kind === 'NetworkPolicy');
const moduleSubject = {
  kind: 'ServiceAccount',
  name: 'storage-module',
  namespace: 'lifemodel-system',
};
const modulePeer = peer('lifemodel-system', 'storage-module');
function peer(namespace: string, name: string): Manifest {
  return {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
    podSelector: { matchLabels: { 'app.kubernetes.io/name': name } },
  };
}
function storageEgress(namespace: string, name: string): Manifest[] {
  return policies
    .filter(
      (policy) =>
        policy.metadata.namespace === namespace &&
        policy.spec.podSelector?.matchLabels?.['app.kubernetes.io/name'] === name
    )
    .flatMap((policy) => policy.spec.egress ?? [])
    .filter((rule) =>
      (rule.to ?? []).some(
        (item: Manifest) =>
          item.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'storage-module'
      )
    );
}

describe('storage module Kubernetes verification rights', () => {
  it('grants only audience TokenReview creation, never the broad auth-delegator role', () => {
    const roles = stepD.filter((item) => item.kind === 'ClusterRole');
    expect(roles).toEqual([
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name: 'storage-module-token-review' },
        rules: [
          { apiGroups: ['authentication.k8s.io'], resources: ['tokenreviews'], verbs: ['create'] },
        ],
      },
    ]);
    expect(stepD.filter((item) => item.kind === 'ClusterRoleBinding')).toEqual([
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: 'storage-module-token-review' },
        subjects: [moduleSubject],
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'storage-module-token-review',
        },
      },
    ]);
  });

  it('permits fresh Pod gets in caller namespaces and Job gets only for tasks', () => {
    const roles = stepD.filter((item) => item.kind === 'Role');
    expect(roles).toHaveLength(2);
    for (const namespace of ['lifemodel', 'lifemodel-motor']) {
      const role = roles.find((item) => item.metadata.namespace === namespace);
      expect(role?.metadata).toEqual({ name: 'storage-module-identity-read', namespace });
      expect(role?.rules).toEqual([
        { apiGroups: [''], resources: ['pods'], verbs: ['get'] },
        ...(namespace === 'lifemodel-motor'
          ? [{ apiGroups: ['batch'], resources: ['jobs'], verbs: ['get'] }]
          : []),
      ]);
    }
    const bindings = stepD.filter((item) => item.kind === 'RoleBinding');
    expect(bindings).toHaveLength(2);
    for (const namespace of ['lifemodel', 'lifemodel-motor']) {
      expect(bindings.find((item) => item.metadata.namespace === namespace)).toEqual({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: 'storage-module-identity-read', namespace },
        subjects: [moduleSubject],
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'storage-module-identity-read',
        },
      });
    }
    // Exact rules above prohibit watches, lists, writes, token requests, secret
    // reads and access to Pods/Jobs outside these two namespaces.
  });

  it('provisions the shared task identity without any binding or API token automount', () => {
    expect(
      stepD.filter((item) => item.kind === 'ServiceAccount' && item.metadata.name === 'task')
    ).toEqual([
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: 'task', namespace: 'lifemodel-motor' },
        automountServiceAccountToken: false,
      },
    ]);
    const bindings = [
      ...documents('a/applications.yaml'),
      ...documents('a/loader-app-rbac.yaml'),
      ...stepD,
    ].filter((item) => ['RoleBinding', 'ClusterRoleBinding'].includes(item.kind));
    expect(
      bindings.some((binding) =>
        (binding.subjects ?? []).some(
          (subject: Manifest) => subject.kind === 'ServiceAccount' && subject.name === 'task'
        )
      )
    ).toBe(false);
  });
});

describe('service-audience caller projections', () => {
  for (const name of ['core', 'web']) {
    it(`projects only ${name}'s storage audiences under its dedicated identity`, () => {
      const resources = documents(`applications/lifemodel/${name}.yaml`);
      const account = resources.find((item) => item.kind === 'ServiceAccount');
      expect(account).toEqual({
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name, namespace: 'lifemodel' },
        automountServiceAccountToken: false,
      });
      const workload = resources.find((item) => ['StatefulSet', 'Deployment'].includes(item.kind));
      const pod = workload?.spec.template.spec;
      expect(pod?.serviceAccountName).toBe(name);
      expect(pod?.automountServiceAccountToken).toBe(false);
      const sources = (pod?.volumes ?? []).flatMap(
        (volume: Manifest) => volume.projected?.sources ?? []
      );
      expect(sources).toEqual([
        ...(name === 'core'
          ? [
              {
                serviceAccountToken: {
                  audience: 'lifemodel-core-storage-control',
                  expirationSeconds: 3600,
                  path: 'control-token',
                },
              },
            ]
          : []),
        {
          serviceAccountToken: {
            audience: `lifemodel-${name}-storage-read`,
            expirationSeconds: 3600,
            path: 'read-token',
          },
        },
      ]);
      const volume = (pod?.volumes ?? []).find(
        (item: Manifest) => item.name === 'storage-identity'
      );
      expect(volume?.projected.defaultMode).toBe(288);
      const container = pod?.containers.find((item: Manifest) => item.name === name);
      expect(container?.volumeMounts).toContainEqual({
        name: 'storage-identity',
        mountPath: '/var/run/secrets/lifemodel-storage',
        readOnly: true,
      });
      expect(container?.env).toContainEqual({
        name: 'LIFEMODEL_STORAGE_READ_TOKEN_FILE',
        value: '/var/run/secrets/lifemodel-storage/read-token',
      });
      const controls = (container?.env ?? []).filter(
        (item: Manifest) => item.name === 'LIFEMODEL_STORAGE_CONTROL_TOKEN_FILE'
      );
      expect(controls).toEqual(
        name === 'core'
          ? [
              {
                name: 'LIFEMODEL_STORAGE_CONTROL_TOKEN_FILE',
                value: '/var/run/secrets/lifemodel-storage/control-token',
              },
            ]
          : []
      );
      for (const init of pod?.initContainers ?? [])
        expect(init.volumeMounts.some((mount: Manifest) => mount.name === 'storage-identity')).toBe(
          false
        );
    });
  }
});

describe('storage listener network isolation', () => {
  it('maps only the intended namespace AND Pod peers to each listener', () => {
    const modulePolicies = policies.filter(
      (policy) =>
        policy.metadata.namespace === 'lifemodel-system' &&
        policy.spec.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'storage-module'
    );
    expect(modulePolicies).toHaveLength(1);
    expect(modulePolicies[0]?.spec.ingress).toEqual([
      { from: [peer('lifemodel-system', 'loader')], ports: [{ protocol: 'TCP', port: 8081 }] },
      { from: [peer('lifemodel-motor', 'task')], ports: [{ protocol: 'TCP', port: 8443 }] },
      { from: [peer('lifemodel', 'core')], ports: [{ protocol: 'TCP', port: 8444 }] },
      {
        from: [peer('lifemodel', 'core'), peer('lifemodel', 'web')],
        ports: [{ protocol: 'TCP', port: 8445 }],
      },
    ]);
  });

  it('opens reverse egress for only task data, core control/read and web read', () => {
    for (const [namespace, name, ports] of [
      ['lifemodel-motor', 'task', [8443]],
      ['lifemodel', 'core', [8444, 8445]],
      ['lifemodel', 'web', [8445]],
      ['lifemodel-system', 'loader', [8081]],
    ] as const) {
      expect(storageEgress(namespace, name)).toEqual([
        {
          to: [modulePeer],
          ports: ports.map((port) => ({ protocol: 'TCP', port })),
        },
      ]);
    }
    const taskPolicy = stepD.find(
      (item) => item.kind === 'NetworkPolicy' && item.metadata.namespace === 'lifemodel-motor'
    );
    expect(taskPolicy?.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'task' } },
      policyTypes: ['Egress'],
      egress: [{ to: [modulePeer], ports: [{ protocol: 'TCP', port: 8443 }] }],
    });
    const reverse = stepD.filter(
      (item) => item.kind === 'NetworkPolicy' && item.metadata.namespace !== 'lifemodel-system'
    );
    expect(reverse).toHaveLength(3);
    for (const policy of reverse) {
      expect(policy.spec.policyTypes).toEqual(['Egress']);
      expect(policy.spec.ingress).toBeUndefined();
      expect(policy.spec.egress).toHaveLength(1);
    }
  });

  it('allows the module API port exception only for live TokenReview and object gets', () => {
    const access = stepD.find(
      (item) => item.kind === 'NetworkPolicy' && item.metadata.name === 'storage-module-access'
    );
    expect(
      access?.spec.egress.filter((rule: Manifest) =>
        (rule.to ?? []).some((item: Manifest) => item.ipBlock)
      )
    ).toEqual([
      {
        to: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
        ports: [{ protocol: 'TCP', port: 6443 }],
      },
    ]);
  });
});

describe('storage identity bootstrap order', () => {
  it('keeps identities and verification RBAC in D after the database with no new phase', () => {
    const step = YAML.parse(readFileSync(join(platformRoot, 'd/kustomization.yaml'), 'utf8'));
    expect(step.resources).toEqual([
      'storage-module-service-account.yaml',
      'task-service-account.yaml',
      'storage-module-rbac.yaml',
      'storage-module.yaml',
      'network-policy.yaml',
    ]);
    for (const [file, parent] of [
      ['a-reconciler.yaml', 'platform-a0'],
      ['b-reconciler.yaml', 'platform-a'],
      ['c-reconciler.yaml', 'platform-b'],
      ['d-reconciler.yaml', 'platform-c'],
    ])
      expect(documents(file)[0]?.spec.dependsOn).toEqual([{ name: parent }]);
    expect(
      platformFirstStartPhases({
        storageCustody: { name: 'storage-custody', run: async () => {} },
        gitea: [{ name: 'gitea', run: async () => {} }],
      }).map((phase) => phase.name)
    ).toEqual(['storage-custody', 'gitea', 'cnpg-copy-core-credentials', 'valkey-password']);
  });
});

describe('storage entry point listener ports', () => {
  it('names all four port constants and starts each listener with its own constant', () => {
    const entry = readFileSync(join(platformRoot, '../../loader/src/storage-module.ts'), 'utf8');
    for (const [name, port, listener] of [
      ['STATUS_PORT', 8081, 'app.status'],
      ['TASK_PORT', 8443, 'app.task.server'],
      ['CONTROL_PORT', 8444, 'app.control.server'],
      ['READ_PORT', 8445, 'app.read.server'],
    ] as const) {
      expect(entry).toContain(`const ${name} = ${port};`);
      expect(entry).toContain(`${listener}.listen(${name}, '0.0.0.0')`);
    }
  });
});
