import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { evaluate } from '@marcbachmann/cel-js';
import { createKubernetesTlsStores } from '../../loader/src/pki-kubernetes.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function documents(path: string): any[] {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8')).map((doc) => doc.toJSON());
}
const source = '/api/v1/namespaces/lifemodel-system/configmaps/lifemodel-ca';
const replica = '/api/v1/namespaces/lifemodel/configmaps/lifemodel-ca';
const motorReplica = '/api/v1/namespaces/lifemodel-motor/configmaps/lifemodel-ca';
function stores(failureTarget = replica) {
  const directory = mkdtempSync(join(tmpdir(), 'storage-ca-'));
  directories.push(directory);
  writeFileSync(join(directory, 'token'), 'loader-token');
  const objects = new Map<string, any>(
    [source, replica, motorReplica].map((path) => [
      path,
      {
        metadata: { resourceVersion: '1', annotations: { keep: 'annotation' } },
        data: {},
      },
    ])
  );
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let failure: 'missing' | 'denied' | 'readback' | null = null;
  const result = createKubernetesTlsStores({
    tokenFile: join(directory, 'token'),
    caFile: join(directory, 'absent-ca'),
    request: async (url, method, token, body) => {
      expect(token).toBe('loader-token');
      const path = url.pathname;
      calls.push({ path, method, ...(body ? { body: JSON.parse(body) } : {}) });
      if (path === failureTarget && failure === 'missing') return { status: 404, body: '' };
      if (path === failureTarget && failure === 'denied' && method === 'PUT')
        return { status: 403, body: 'secret error body' };
      if (method === 'PUT' && !(path === failureTarget && failure === 'readback'))
        objects.set(path, JSON.parse(body!));
      return { status: 200, body: JSON.stringify(objects.get(path)) };
    },
  });
  return {
    ...result,
    objects,
    calls,
    fail: (value: typeof failure) => {
      failure = value;
    },
  };
}

describe('public instance CA replication for core storage control', () => {
  it('publishes and reads back the same public CA in all three fixed namespaces on every PKI write', async () => {
    const { configMap, objects, calls } = stores();
    await configMap.write('PUBLIC-CA');
    await configMap.write('RENEWED-PUBLIC-CA');
    expect(await configMap.read()).toBe('RENEWED-PUBLIC-CA');
    for (const path of [source, replica, motorReplica]) {
      expect(objects.get(path).data).toEqual({ 'ca.crt': 'RENEWED-PUBLIC-CA' });
      expect(objects.get(path).metadata.annotations).toEqual({ keep: 'annotation' });
      expect(calls.filter((call) => call.path === path && call.method === 'PUT')).toHaveLength(2);
    }
    expect(calls.every((call) => ['GET', 'PUT'].includes(call.method))).toBe(true);
    expect(
      calls
        .filter((call) => call.method === 'PUT')
        .every(
          (call) => Object.keys(call.body.data).join() === 'ca.crt' && !('binaryData' in call.body)
        )
    ).toBe(true);
    for (const path of [replica, motorReplica]) {
      const lastReplicaWrite = calls.findLastIndex(
        (call) => call.path === path && call.method === 'PUT'
      );
      expect(calls[lastReplicaWrite + 1]).toMatchObject({ path, method: 'GET' });
    }
  });

  describe.each([replica, motorReplica])('replica %s', (path) => {
    it.each(['missing', 'denied', 'readback'] as const)(
      'fails closed on a %s replica and retries the current CA',
      async (failure) => {
        const { configMap, objects, fail } = stores(path);
        fail(failure);
        await expect(configMap.write('PUBLIC-CA')).rejects.toThrow();
        fail(null);
        await configMap.write('CURRENT-CA');
        expect(objects.get(path).data).toEqual({ 'ca.crt': 'CURRENT-CA' });
      }
    );
  });
});

describe('storage CA projection bootstrap and least privilege', () => {
  const loader = 'system:serviceaccount:lifemodel-system:loader';
  const admissions = documents('deploy/platform/a0/admission-policies.yaml');
  const policy = (name: string) =>
    admissions.find(
      (item) => item.kind === 'ValidatingAdmissionPolicy' && item.metadata.name === name
    )?.spec;

  it.each(['lifemodel', 'lifemodel-motor'])(
    'precreates the %s replica and fixed-name loader binding in A0, before readiness',
    (namespace) => {
      const configMap = documents('deploy/platform/a0/pki-configmap.yaml').find(
        (item) => item.metadata.namespace === namespace && item.metadata.name === 'lifemodel-ca'
      );
      expect(configMap).toMatchObject({
        kind: 'ConfigMap',
        data: {},
        metadata: {
          annotations: {
            'kustomize.toolkit.fluxcd.io/ssa': 'IfNotPresent',
            'kustomize.toolkit.fluxcd.io/prune': 'disabled',
          },
        },
      });
      const rbac = documents('deploy/platform/a0/service-account.yaml');
      const role = rbac.find(
        (item) => item.kind === 'Role' && item.metadata.namespace === namespace
      );
      expect(role?.rules).toEqual([
        {
          apiGroups: [''],
          resources: ['configmaps'],
          resourceNames: ['lifemodel-ca'],
          verbs: ['get', 'update'],
        },
      ]);
      const binding = rbac.find(
        (item) => item.kind === 'RoleBinding' && item.metadata.namespace === namespace
      );
      expect(binding?.subjects).toEqual([
        { kind: 'ServiceAccount', name: 'loader', namespace: 'lifemodel-system' },
      ]);
      expect(binding?.roleRef).toEqual({
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: role?.metadata.name,
      });
      const instanceNamespace = documents('deploy/platform/instance/namespace-app.yaml').find(
        (item) => item.kind === 'Namespace' && item.metadata.name === namespace
      );
      expect(instanceNamespace?.metadata.labels).toEqual({
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
        'pod-security.kubernetes.io/warn': 'restricted',
      });
      expect(
        documents('deploy/platform/a/applications.yaml').some(
          (item) => item.kind === 'Namespace' && item.metadata.name === namespace
        )
      ).toBe(false);
      expect(documents('deploy/platform/instance/kustomization.yaml')[0].resources).toContain(
        'namespace-app.yaml'
      );
      const a0 = documents('deploy/platform/a0-reconciler.yaml')[0];
      expect(a0.spec.dependsOn).toEqual([{ name: 'platform-instance' }]);
      expect(documents('deploy/platform/a0/kustomization.yaml')[0].resources).toEqual(
        expect.arrayContaining([
          'service-account.yaml',
          'pki-configmap.yaml',
          'admission-policies.yaml',
        ])
      );
    }
  );

  it.each(['lifemodel', 'lifemodel-motor'])(
    'admits only the named %s replica UPDATE for loader, never a key or binaryData',
    (namespace) => {
      const admission = policy('loader-configmap-admission');
      expect(admission.failurePolicy).toBe('Fail');
      expect(admission.matchConstraints.namespaceSelector.matchExpressions[0].values).toContain(
        namespace
      );
      const permits = (
        name: string,
        targetNamespace: string,
        operation: string,
        data: Record<string, string> | undefined = { 'ca.crt': 'PUBLIC-CA' },
        binaryData?: Record<string, string>
      ) =>
        admission.validations.every((validation: any) =>
          evaluate(validation.expression, {
            request: {
              name,
              namespace: targetNamespace,
              operation,
              userInfo: { username: loader },
            },
            object: {
              metadata: { name },
              ...(data === undefined ? {} : { data }),
              ...(binaryData === undefined ? {} : { binaryData }),
            },
          })
        );
      expect(permits('lifemodel-ca', namespace, 'UPDATE')).toBe(true);
      for (const operation of ['CREATE', 'DELETE'])
        expect(permits('lifemodel-ca', namespace, operation)).toBe(false);
      expect(permits('other', namespace, 'UPDATE')).toBe(false);
      expect(permits('lifemodel-ca', 'unrelated', 'UPDATE')).toBe(false);
      for (const data of [{}, { 'tls.key': 'KEY' }, { 'ca.crt': 'PUBLIC', 'tls.key': 'KEY' }])
        expect(permits('lifemodel-ca', namespace, 'UPDATE', data)).toBe(false);
      expect(
        permits('lifemodel-ca', namespace, 'UPDATE', { 'ca.crt': 'PUBLIC' }, { 'tls.key': 'S0VZ' })
      ).toBe(false);
    }
  );

  it.each(['lifemodel', 'lifemodel-motor'])(
    'reserves %s replica updates to loader and forbids deletion without a new object',
    (namespace) => {
      const ownership = policy('storage-ca-ownership-admission');
      expect(ownership).toBeDefined();
      expect(ownership.failurePolicy).toBe('Fail');
      expect(ownership.matchConstraints.namespaceSelector.matchExpressions).toEqual([
        {
          key: 'kubernetes.io/metadata.name',
          operator: 'In',
          values: ['lifemodel', 'lifemodel-motor'],
        },
      ]);
      expect(ownership.matchConstraints.resourceRules[0]).toEqual({
        apiGroups: [''],
        apiVersions: ['v1'],
        operations: ['UPDATE', 'DELETE'],
        resources: ['configmaps'],
      });
      for (const username of [
        loader,
        'system:serviceaccount:lifemodel:core',
        'system:serviceaccount:lifemodel-system:storage-module',
        'system:serviceaccount:lifemodel-motor:lifemodel-motor-applier',
      ]) {
        for (const operation of ['UPDATE', 'DELETE']) {
          const request = { namespace, name: 'lifemodel-ca', operation, userInfo: { username } };
          expect(evaluate(ownership.matchConditions[0].expression, { request })).toBe(true);
          for (const excluded of [
            { ...request, name: 'other' },
            { ...request, namespace: 'unrelated' },
          ])
            expect(evaluate(ownership.matchConditions[0].expression, { request: excluded })).toBe(
              false
            );
          expect(evaluate(ownership.validations[0].expression, { request })).toBe(
            username === loader && operation === 'UPDATE'
          );
        }
      }
      expect(
        admissions.some(
          (item) =>
            item.kind === 'ValidatingAdmissionPolicyBinding' &&
            item.spec.policyName === 'storage-ca-ownership-admission' &&
            item.spec.validationActions.includes('Deny')
        )
      ).toBe(true);
    }
  );

  it('mounts only the public ca.crt read-only into core with no Secret, subPath or API token', () => {
    const core = documents('deploy/platform/applications/lifemodel/core.yaml').find(
      (item) => item.kind === 'StatefulSet'
    );
    const pod = core.spec.template.spec;
    const container = pod.containers[0];
    expect(container.env).toContainEqual({
      name: 'LIFEMODEL_STORAGE_CONTROL_CA_FILE',
      value: '/var/run/secrets/lifemodel-storage-ca/ca.crt',
    });
    expect(container.volumeMounts).toContainEqual({
      name: 'storage-ca',
      mountPath: '/var/run/secrets/lifemodel-storage-ca',
      readOnly: true,
    });
    expect(pod.volumes).toContainEqual({
      name: 'storage-ca',
      configMap: {
        name: 'lifemodel-ca',
        optional: true,
        items: [{ key: 'ca.crt', path: 'ca.crt' }],
      },
    });
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(
      pod.initContainers[0].volumeMounts.some((mount: any) => mount.name === 'storage-ca')
    ).toBe(false);
  });
});
