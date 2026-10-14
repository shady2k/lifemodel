import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const loaderSource = readFileSync(fileURLToPath(new URL('../../loader/src/gitea.ts', import.meta.url)), 'utf8');
const applicationSource = readFileSync(join(root, 'a/applications.yaml'), 'utf8');
const resources = YAML.parse(readFileSync(join(root, 'a0/kustomization.yaml'), 'utf8')).resources as string[];
const objects = resources.flatMap((resource) => YAML.parseAllDocuments(readFileSync(join(root, 'a0', resource), 'utf8')).map((doc) => doc.toJSON()));

function policy(name: string): any {
  return objects.find((item: any) => item.kind === 'ValidatingAdmissionPolicy' && item.metadata.name === name);
}

function binding(policyName: string): any {
  return objects.find((item: any) => item.kind === 'ValidatingAdmissionPolicyBinding' && item.spec.policyName === policyName);
}

describe('platform admission policies', () => {
  it('renders both policies with Deny bindings in A0', () => {
    expect(policy('loader-secret-admission')).toBeDefined();
    expect(policy('application-kustomization-admission')).toBeDefined();
    for (const name of ['loader-secret-admission', 'application-kustomization-admission']) {
      expect(binding(name)?.spec.validationActions).toEqual(['Deny']);
    }
    expect(objects.filter((item: any) => item.kind === 'ValidatingAdmissionPolicy').map((item: any) => item.metadata.name).sort()).toEqual(['application-kustomization-admission', 'loader-secret-admission']);
    expect(objects.filter((item: any) => item.kind === 'ValidatingAdmissionPolicyBinding').map((item: any) => item.metadata.name).sort()).toEqual(['application-kustomization-admission', 'loader-secret-admission']);
  });

  it('limits loader Secret writes to the names used by the loader', () => {
    const loaderNames = [...loaderSource.matchAll(/(?:ADMIN_SECRET = |name = )'([^']+)'/g)].map((match) => match[1]);
    const applicationNames = [...applicationSource.matchAll(/name: (deploy-source-credential)/g)].map((match) => match[1]);
    const codeNames = [...new Set([...loaderNames.filter((name) => name === 'gitea-admin'), ...applicationNames])].sort();
    expect(codeNames).toEqual(['deploy-source-credential', 'gitea-admin']);
    const policyObject = policy('loader-secret-admission');
    const expression = [...policyObject.spec.matchConditions, ...policyObject.spec.validations].map((item: any) => item.expression).join(' ');
    for (const fragment of ["request.userInfo.username", "request.namespace", "object.metadata.name", "request.operation != 'DELETE'", 'lifemodel-git', 'gitea-admin', 'lifemodel', 'lifemodel-motor', 'deploy-source-credential']) {
      expect(expression).toContain(fragment);
    }
    expect(policyObject.spec.matchConstraints.resourceRules[0].operations).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    expect(policyObject.spec.matchConditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ expression: "request.userInfo.username == 'system:serviceaccount:lifemodel-system:loader'" }),
    ]));
  });

  it('requires application Kustomizations to use only local platform authority', () => {
    const policyObject = policy('application-kustomization-admission');
    expect(policyObject.spec.matchConstraints.resourceRules[0]).toMatchObject({
      apiGroups: ['kustomize.toolkit.fluxcd.io'],
      resources: ['kustomizations'],
      operations: ['CREATE', 'UPDATE'],
    });
    const expression = policyObject.spec.validations.map((item: any) => item.expression).join(' ');
    for (const fragment of ['serviceAccountName', 'applier', 'sourceRef', 'GitRepository', 'kubeConfig', 'targetNamespace', 'dependsOn', 'request.namespace']) {
      expect(expression).toContain(fragment);
    }
    for (const objectName of ['loader-secret-admission', 'application-kustomization-admission']) {
      expect(policy(objectName).spec.failurePolicy).toBe('Fail');
    }
    const guardedAccesses = [
      ['has(object.spec.serviceAccountName)', 'object.spec.serviceAccountName =='],
      ['has(object.spec.sourceRef)', 'object.spec.sourceRef.kind'],
      ['has(object.spec.sourceRef)', 'object.spec.sourceRef.name'],
      ['!has(object.spec.sourceRef.namespace)', 'object.spec.sourceRef.namespace =='],
      ['!has(object.spec.kubeConfig)', '!has(object.spec.kubeConfig)'],
      ['!has(object.spec.targetNamespace)', 'object.spec.targetNamespace =='],
      ['!has(object.spec.dependsOn)', 'object.spec.dependsOn.all'],
      ['!has(dependency.namespace)', 'dependency.namespace =='],
    ];
    for (const [guard, access] of guardedAccesses) {
      expect(expression.indexOf(guard), `missing guard: ${guard}`).toBeGreaterThanOrEqual(0);
      expect(expression.indexOf(access), `missing field access: ${access}`).toBeGreaterThanOrEqual(expression.indexOf(guard));
    }
    expect(policyObject.spec.matchConstraints.namespaceSelector.matchExpressions[0].values).toEqual(['lifemodel', 'lifemodel-motor']);
    // No CEL evaluator is shipped in the test dependencies. These assertions pin the CEL contract structurally;
    // the coordinator's Kubernetes 1.35 VM acceptance evaluates admission against a live API server.
    const lockfile = readFileSync(fileURLToPath(new URL('../../package-lock.json', import.meta.url)), 'utf8');
    expect(lockfile).not.toMatch(/"node_modules\/(?:@kubernetes|cel-js)/);
  });
});
