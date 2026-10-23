import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import YAML from 'yaml';

// Follow each kustomization's resources, not a directory glob: an unreferenced
// permit must not make a test green. Helm charts contain no task principals.
function render(path: string): any[] {
  const docs = YAML.parseAllDocuments(readFileSync(path, 'utf8'))
    .map((d) => d.toJSON())
    .filter(Boolean);
  return docs.flatMap((d) =>
    d.kind === 'Kustomization' && Array.isArray(d.resources)
      ? d.resources.flatMap((r: string) =>
          render(resolve(dirname(path), r.endsWith('.yaml') ? r : `${r}/kustomization.yaml`))
        )
      : [d]
  );
}
const objects = ['instance', 'a0', 'a', 'b', 'state', 'd'].flatMap((step) =>
  render(`deploy/platform/${step}/kustomization.yaml`)
);
const policy = (name: string) =>
  objects.find((o) => o.kind === 'NetworkPolicy' && o.metadata.name === name)?.spec;
const labels = (name: string) => ({ matchLabels: { 'app.kubernetes.io/name': name } });
const peer = (namespace: string, name: string, dns = false) => ({
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
  podSelector: dns ? { matchLabels: { 'k8s-app': 'kube-dns' } } : labels(name),
});
const tcp = (port: number) => ({ protocol: 'TCP', port });

describe('task namespace network and launch rights', () => {
  it('allows DNS only to kube-system kube-dns, on UDP/TCP 53', () => {
    expect(policy('task-dns-egress')).toEqual({
      podSelector: labels('task'),
      policyTypes: ['Egress'],
      egress: [
        { to: [peer('kube-system', '', true)], ports: [{ protocol: 'UDP', port: 53 }, tcp(53)] },
      ],
    });
  });
  it('has exactly the four task egress routes and no internet, API or direct store route', () => {
    const policies = objects.filter(
      (o) => o.kind === 'NetworkPolicy' && o.metadata.namespace === 'lifemodel-motor'
    );
    const deny = policies.find((o) => o.metadata.name === 'default-deny');
    expect(deny?.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    });
    expect(policies.flatMap((o) => o.spec.ingress ?? [])).toEqual([]);
    const permits = policies.filter((o) => o.spec.egress?.length);
    expect(permits.map((o) => o.metadata.name).sort()).toEqual([
      'task-channel-egress',
      'task-dns-egress',
      'task-model-egress',
      'task-storage-egress',
    ]);
    for (const p of permits) expect(p.spec.podSelector).toEqual(labels('task'));
    expect(permits.flatMap((o) => o.spec.egress)).toEqual(
      expect.arrayContaining([
        { to: [peer('lifemodel-system', 'storage-module')], ports: [tcp(8443)] },
        { to: [peer('lifemodel-system', 'model-gateway')], ports: [tcp(8446)] },
        { to: [peer('lifemodel', 'core')], ports: [tcp(8447)] },
      ])
    );
    // Count and exact peer/port checks catch an appended widening too.
    expect(permits.flatMap((o) => o.spec.egress)).toHaveLength(4);
    expect(
      permits.flatMap((o) => o.spec.egress).some((r) => r.to.some((p: any) => p.ipBlock))
    ).toBe(false);
  });
  it('admits task ingress only on the separate model and core channel listeners', () => {
    for (const [name, target, port] of [
      ['task-model-ingress', 'model-gateway', 8446],
      ['task-channel-ingress', 'core', 8447],
    ] as const) {
      expect(policy(name)).toEqual({
        podSelector: labels(target),
        policyTypes: ['Ingress'],
        ingress: [{ from: [peer('lifemodel-motor', 'task')], ports: [tcp(port)] }],
      });
    }
    const services = objects.filter((o) => o.kind === 'Service');
    expect(services.find((o) => o.metadata.name === 'model-gateway').spec.ports).toContainEqual({
      name: 'task',
      port: 8446,
      targetPort: 8446,
      protocol: 'TCP',
    });
    const core = render('deploy/platform/applications/lifemodel/core.yaml');
    expect(core.find((o) => o.kind === 'Service').spec.ports).toContainEqual({
      name: 'task-channel',
      port: 8447,
      targetPort: 8447,
      protocol: 'TCP',
    });
  });
  it('never binds the task SA, including service-account group subjects', () => {
    for (const o of objects.filter((o) => ['RoleBinding', 'ClusterRoleBinding'].includes(o.kind))) {
      for (const s of o.subjects ?? []) {
        expect(
          s.kind === 'ServiceAccount' &&
            s.name === 'task' &&
            (s.namespace ?? o.metadata.namespace) === 'lifemodel-motor'
        ).toBe(false);
        expect(s.kind === 'User' && s.name === 'system:serviceaccount:lifemodel-motor:task').toBe(
          false
        );
        expect(
          s.kind === 'Group' &&
            [
              'system:authenticated',
              'system:serviceaccounts',
              'system:serviceaccounts:lifemodel-motor',
            ].includes(s.name)
        ).toBe(false);
      }
    }
    expect(
      objects.find((o) => o.kind === 'ServiceAccount' && o.metadata.name === 'task')
    ).toMatchObject({ automountServiceAccountToken: false });
  });
  it('grants core only namespaced Job control and read-only Pod observation', () => {
    const role = objects.find((o) => o.kind === 'Role' && o.metadata.name === 'core-task-launcher');
    expect(role?.metadata.namespace).toBe('lifemodel-motor');
    expect(role?.rules).toEqual([
      {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['create', 'get', 'list', 'watch', 'patch', 'delete'],
      },
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    ]);
    expect(
      objects.find((o) => o.kind === 'RoleBinding' && o.metadata.name === 'core-task-launcher')
    ).toMatchObject({
      metadata: { namespace: 'lifemodel-motor' },
      subjects: [{ kind: 'ServiceAccount', name: 'core', namespace: 'lifemodel' }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'core-task-launcher' },
    });
    const pod = render('deploy/platform/applications/lifemodel/core.yaml').find(
      (o) => o.kind === 'StatefulSet'
    ).spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.volumes).toContainEqual({
      name: 'task-api-identity',
      projected: {
        defaultMode: 288,
        sources: [
          { serviceAccountToken: { expirationSeconds: 3600, path: 'token' } },
          { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
        ],
      },
    });
    expect(pod.containers[0].volumeMounts).toContainEqual({
      name: 'task-api-identity',
      mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
      readOnly: true,
    });
    expect(
      pod.initContainers[0].volumeMounts.some((m: any) => m.name === 'task-api-identity')
    ).toBe(false);
    expect(policy('core-task-api-egress')).toEqual({
      podSelector: labels('core'),
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [tcp(6443)] }],
    });
  });
});
