import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import YAML from 'yaml';
import { evaluate } from '@marcbachmann/cel-js';

const root = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const loaderSource = readFileSync(
  fileURLToPath(new URL('../../loader/src/gitea.ts', import.meta.url)),
  'utf8'
);
const applicationSource = readFileSync(join(root, 'a/applications.yaml'), 'utf8');
const resources = YAML.parse(readFileSync(join(root, 'a0/kustomization.yaml'), 'utf8'))
  .resources as string[];
const objects = resources.flatMap((resource) =>
  YAML.parseAllDocuments(readFileSync(join(root, 'a0', resource), 'utf8')).map((doc) =>
    doc.toJSON()
  )
);

function policy(name: string): any {
  return objects.find(
    (item: any) => item.kind === 'ValidatingAdmissionPolicy' && item.metadata.name === name
  );
}

function binding(policyName: string): any {
  return objects.find(
    (item: any) =>
      item.kind === 'ValidatingAdmissionPolicyBinding' && item.spec.policyName === policyName
  );
}

describe('platform admission policies', () => {
  it('renders both policies with Deny bindings in A0', () => {
    expect(policy('loader-secret-admission')).toBeDefined();
    expect(policy('application-kustomization-admission')).toBeDefined();
    for (const name of ['loader-secret-admission', 'application-kustomization-admission']) {
      expect(binding(name)?.spec.validationActions).toEqual(['Deny']);
    }
    expect(policy('loader-configmap-admission')).toBeDefined();
    expect(policy('platform-settings-ownership-admission')).toBeDefined();
    expect(
      objects
        .filter((item: any) => item.kind === 'ValidatingAdmissionPolicy')
        .map((item: any) => item.metadata.name)
        .sort()
    ).toEqual([
      'application-kustomization-admission',
      'loader-configmap-admission',
      'loader-secret-admission',
      'platform-settings-ownership-admission',
      'storage-ca-ownership-admission',
    ]);
    expect(
      objects
        .filter((item: any) => item.kind === 'ValidatingAdmissionPolicyBinding')
        .map((item: any) => item.metadata.name)
        .sort()
    ).toEqual([
      'application-kustomization-admission',
      'loader-configmap-admission',
      'loader-secret-admission',
      'platform-settings-ownership-admission',
      'storage-ca-ownership-admission',
    ]);
  });

  it('limits loader Secret writes to the names used by the loader', () => {
    const loaderNames = [...loaderSource.matchAll(/(?:ADMIN_SECRET = |name = )'([^']+)'/g)].map(
      (match) => match[1]
    );
    const applicationNames = [
      ...applicationSource.matchAll(/name: (deploy-source-credential)/g),
    ].map((match) => match[1]);
    const codeNames = [
      ...new Set([...loaderNames.filter((name) => name === 'gitea-admin'), ...applicationNames]),
    ].sort();
    expect(codeNames).toEqual(['deploy-source-credential', 'gitea-admin']);
    const policyObject = policy('loader-secret-admission');
    const expression = [...policyObject.spec.matchConditions, ...policyObject.spec.validations]
      .map((item: any) => item.expression)
      .join(' ');
    for (const fragment of [
      'request.userInfo.username',
      'request.namespace',
      'object.metadata.name',
      "request.operation != 'DELETE'",
      'lifemodel-git',
      'gitea-admin',
      'lifemodel',
      'lifemodel-motor',
      'deploy-source-credential',
    ]) {
      expect(expression).toContain(fragment);
    }
    expect(policyObject.spec.matchConstraints.resourceRules[0].operations).toEqual([
      'CREATE',
      'UPDATE',
      'DELETE',
    ]);
    expect(policyObject.spec.matchConditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expression:
            "request.userInfo.username == 'system:serviceaccount:lifemodel-system:loader'",
        }),
      ])
    );
  });

  it('requires application Kustomizations to use only local platform authority', () => {
    const policyObject = policy('application-kustomization-admission');
    expect(policyObject.spec.matchConstraints.resourceRules[0]).toMatchObject({
      apiGroups: ['kustomize.toolkit.fluxcd.io'],
      resources: ['kustomizations'],
      operations: ['CREATE', 'UPDATE', 'DELETE'],
    });
    const expression = policyObject.spec.validations.map((item: any) => item.expression).join(' ');
    for (const fragment of [
      'serviceAccountName',
      'applier',
      'sourceRef',
      'GitRepository',
      'kubeConfig',
      'targetNamespace',
      'dependsOn',
      'request.namespace',
    ]) {
      expect(expression).toContain(fragment);
    }
    expect(expression).toContain(
      'has(object.spec.targetNamespace) && object.spec.targetNamespace == request.namespace'
    );
    expect(expression).toContain(
      "request.userInfo.username != 'system:serviceaccount:lifemodel-system:loader' ||"
    );
    expect(expression).toContain("request.operation != 'DELETE'");
    expect(expression).toContain(
      'has(object.metadata.name) && object.metadata.name == request.namespace'
    );
    expect(expression).toContain(
      "has(object.spec.path) && object.spec.path == './deploy/platform/applications/' + request.namespace"
    );
    const applications = [
      ...loaderSource.matchAll(
        /namespace: '(lifemodel(?:-motor)?)',[\s\S]*?path: '(\.\/deploy\/platform\/applications\/[^']+)'/g
      ),
    ];
    expect(applications).toHaveLength(2);
    for (const [, namespace, path] of applications) {
      expect(path).toBe(`./deploy/platform/applications/${namespace}`);
      expect(namespace).toBe(namespace === 'lifemodel' ? 'lifemodel' : 'lifemodel-motor');
    }
    const rules = policyObject.spec.validations;
    const platformRule = rules[0].expression;
    const loaderRule = rules[1].expression;
    const valid = {
      metadata: { name: 'lifemodel' },
      spec: {
        serviceAccountName: 'lifemodel-applier',
        sourceRef: { kind: 'GitRepository', name: 'lifemodel' },
        targetNamespace: 'lifemodel',
        path: './deploy/platform/applications/lifemodel',
      },
    };
    const ordinaryRequest = {
      operation: 'CREATE',
      namespace: 'lifemodel',
      userInfo: { username: 'system:serviceaccount:lifemodel:applier' },
    };
    expect(evaluate(platformRule, { request: ordinaryRequest, object: valid })).toBe(true);
    expect(
      evaluate(platformRule, {
        request: ordinaryRequest,
        object: { ...valid, spec: { ...valid.spec, targetNamespace: 'lifemodel-state' } },
      })
    ).toBe(false);
    const loaderRequest = {
      ...ordinaryRequest,
      userInfo: { username: 'system:serviceaccount:lifemodel-system:loader' },
    };
    expect(evaluate(loaderRule, { request: loaderRequest, object: valid })).toBe(true);
    expect(
      evaluate(loaderRule, {
        request: loaderRequest,
        object: { ...valid, metadata: { name: 'extra' } },
      })
    ).toBe(false);
    expect(
      evaluate(loaderRule, {
        request: loaderRequest,
        object: { ...valid, spec: { ...valid.spec, path: '.' } },
      })
    ).toBe(false);
    for (const objectName of [
      'loader-secret-admission',
      'loader-configmap-admission',
      'application-kustomization-admission',
    ]) {
      expect(policy(objectName).spec.failurePolicy).toBe('Fail');
    }
    const guardedAccesses = [
      ['has(object.spec.serviceAccountName)', 'object.spec.serviceAccountName =='],
      ['has(object.spec.sourceRef)', 'object.spec.sourceRef.kind'],
      ['has(object.spec.sourceRef)', 'object.spec.sourceRef.name'],
      ['!has(object.spec.sourceRef.namespace)', 'object.spec.sourceRef.namespace =='],
      ['!has(object.spec.kubeConfig)', '!has(object.spec.kubeConfig)'],
      ['has(object.spec.targetNamespace)', 'object.spec.targetNamespace =='],
      ['!has(object.spec.dependsOn)', 'object.spec.dependsOn.all'],
      ['has(object.metadata.name)', 'object.metadata.name =='],
      ['has(object.spec.path)', 'object.spec.path =='],
      ['!has(dependency.namespace)', 'dependency.namespace =='],
    ];
    for (const [guard, access] of guardedAccesses) {
      expect(expression.indexOf(guard), `missing guard: ${guard}`).toBeGreaterThanOrEqual(0);
      expect(expression.indexOf(access), `missing field access: ${access}`).toBeGreaterThanOrEqual(
        expression.indexOf(guard)
      );
    }
    expect(policyObject.spec.matchConstraints.namespaceSelector.matchExpressions[0].values).toEqual(
      ['lifemodel', 'lifemodel-motor']
    );
  });

  it('limits loader ConfigMap writes to the platform settings projection', () => {
    const policyObject = policy('loader-configmap-admission');
    expect(policyObject.spec.matchConstraints.resourceRules[0]).toMatchObject({
      apiGroups: [''],
      resources: ['configmaps'],
      operations: ['CREATE', 'UPDATE', 'DELETE'],
    });
    const expression = policyObject.spec.validations[0].expression;
    const request = {
      operation: 'CREATE',
      namespace: 'lifemodel',
      userInfo: { username: 'system:serviceaccount:lifemodel-system:loader' },
    };
    const projection = {
      metadata: { name: 'lifemodel-platform-settings', namespace: 'lifemodel' },
    };
    expect(evaluate(expression, { request, object: projection })).toBe(true);
    expect(
      evaluate(expression, {
        request: { ...request, namespace: 'lifemodel-motor' },
        object: { metadata: { name: 'lifemodel-platform-settings' } },
      })
    ).toBe(false);
    expect(
      evaluate(expression, {
        request,
        object: { metadata: { name: 'unrelated', namespace: 'lifemodel' } },
      })
    ).toBe(false);
    expect(
      evaluate(expression, {
        request: { ...request, operation: 'DELETE' },
        object: projection,
      })
    ).toBe(false);
    expect(binding('loader-configmap-admission')?.spec.validationActions).toEqual(['Deny']);
  });

  it('reserves the platform settings ConfigMap for the loader against every requester', () => {
    const policyObject = policy('platform-settings-ownership-admission');
    expect(policyObject.spec.failurePolicy).toBe('Fail');
    expect(policyObject.spec.matchConstraints.resourceRules[0]).toMatchObject({
      apiGroups: [''],
      resources: ['configmaps'],
      operations: ['CREATE', 'UPDATE', 'DELETE'],
    });
    const [condition] = policyObject.spec.matchConditions as Array<{ expression: string }>;
    // The exact resource, matched on request fields so a DELETE - which carries
    // no new object - is covered too.
    expect(condition.expression).toContain("request.namespace == 'lifemodel'");
    expect(condition.expression).toContain("request.name == 'lifemodel-platform-settings'");
    expect(condition.expression).not.toContain('object');
    const validation = policyObject.spec.validations[0].expression as string;
    // A shipped non-loader identity with cluster-wide ConfigMap write RBAC
    // (the cloudnative-pg operator service account).
    const cnpgRequest = {
      name: 'lifemodel-platform-settings',
      namespace: 'lifemodel',
      operation: 'CREATE',
      userInfo: { username: 'system:serviceaccount:cnpg-system:cloudnative-pg' },
    };
    const settings = {
      metadata: { name: 'lifemodel-platform-settings', namespace: 'lifemodel' },
    };
    // The policy matches the exact resource for that principal...
    expect(evaluate(condition.expression, { request: cnpgRequest, object: settings })).toBe(true);
    // ...and refuses its create, update and delete of the projection.
    expect(evaluate(validation, { request: cnpgRequest, object: settings })).toBe(false);
    expect(
      evaluate(validation, { request: { ...cnpgRequest, operation: 'UPDATE' }, object: settings })
    ).toBe(false);
    expect(
      evaluate(validation, { request: { ...cnpgRequest, operation: 'DELETE' }, object: null })
    ).toBe(false);
    // The loader passes the guard; the separate loader clamp still forbids its delete.
    const loaderRequest = {
      ...cnpgRequest,
      userInfo: { username: 'system:serviceaccount:lifemodel-system:loader' },
    };
    expect(evaluate(validation, { request: loaderRequest, object: settings })).toBe(true);
    expect(
      evaluate(validation, { request: { ...loaderRequest, operation: 'DELETE' }, object: null })
    ).toBe(true);
    // The core's own identity is refused like any other requester: it reads
    // the projection through its mounted volume, never through the API.
    const coreRequest = {
      ...cnpgRequest,
      userInfo: { username: 'system:serviceaccount:lifemodel:core' },
    };
    expect(evaluate(condition.expression, { request: coreRequest, object: settings })).toBe(true);
    expect(evaluate(validation, { request: coreRequest, object: settings })).toBe(false);
    expect(
      evaluate(validation, { request: { ...coreRequest, operation: 'UPDATE' }, object: settings })
    ).toBe(false);
    expect(
      evaluate(validation, { request: { ...coreRequest, operation: 'DELETE' }, object: null })
    ).toBe(false);
    // An unrelated ConfigMap never matches the guard, so other actors keep working.
    const unrelated = { ...cnpgRequest, name: 'kube-root-ca.crt' };
    expect(
      evaluate(condition.expression, {
        request: unrelated,
        object: { metadata: { name: 'kube-root-ca.crt', namespace: 'lifemodel' } },
      })
    ).toBe(false);
    expect(binding('platform-settings-ownership-admission')?.spec.validationActions).toEqual([
      'Deny',
    ]);
  });
});
