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
    expect(
      objects
        .filter((item: any) => item.kind === 'ValidatingAdmissionPolicy')
        .map((item: any) => item.metadata.name)
        .sort()
    ).toEqual([
      'application-kustomization-admission',
      'loader-configmap-admission',
      'loader-secret-admission',
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
});
