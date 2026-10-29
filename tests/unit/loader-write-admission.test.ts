import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { evaluate } from '@marcbachmann/cel-js';
import { SOURCE_NAMESPACE, CAPTURE_SECRET_NAME, TARGETS } from '../../loader/src/postgres.js';
import {
  SOURCE_NAMESPACE as VALKEY_NAMESPACE,
  SECRET_NAME as VALKEY_SECRET,
  TARGET_NAMESPACE as VALKEY_TARGET,
} from '../../loader/src/valkey.js';
import { ADMIN_SECRET, APPLICATIONS, SOURCE_CREDENTIAL_SECRET } from '../../loader/src/gitea.js';
import { SECRET_NAME as PHASE_SECRET } from '../../loader/src/platform-bootstrap.js';
import { SECRET as BAO_SECRET } from '../../loader/src/openbao.js';
import { ZOT_IDENTITY_SECRET } from '../../loader/src/zot-custody.js';
import { S3_IDENTITY_SECRET } from '../../loader/src/storage-custody.js';
import {
  LOADER_TLS_SECRET,
  STORAGE_TLS_SECRET,
  MODEL_GATEWAY_TLS_SECRET,
  CORE_TLS_SECRET,
  CA_CONFIGMAP,
  STATUS_CONFIGMAP,
} from '../../loader/src/pki-kubernetes.js';
import { SETTINGS_PROJECTION_TARGETS } from '../../loader/src/settings/projection.js';

const root = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
function manifests(directory: string): any[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'charts' ? [] : manifests(path);
    if (!entry.name.endsWith('.yaml') || entry.name === 'kustomization.yaml') return [];
    return YAML.parseAllDocuments(readFileSync(path, 'utf8')).map((document) => {
      expect(document.errors, path).toEqual([]);
      return document.toJSON();
    });
  });
}
const objects = manifests(root);
const loader = 'system:serviceaccount:lifemodel-system:loader';
type WriteTarget = {
  namespace: string;
  name: string;
  resource: 'secrets' | 'configmaps';
  create: boolean;
};
// Names come from the constants/targets actually used for the API paths and
// payloads, not a second hand-maintained list of credential Secret names.
const secretTargets: WriteTarget[] = [
  { namespace: SOURCE_NAMESPACE, name: CAPTURE_SECRET_NAME, create: true },
  ...TARGETS,
  { namespace: VALKEY_NAMESPACE, name: VALKEY_SECRET, create: true },
  { namespace: VALKEY_TARGET, name: VALKEY_SECRET, create: true },
  { namespace: 'lifemodel-git', name: ADMIN_SECRET, create: true },
  ...APPLICATIONS.map(({ namespace }) => ({
    namespace,
    name: SOURCE_CREDENTIAL_SECRET,
    create: true,
  })),
  ...[
    PHASE_SECRET,
    BAO_SECRET,
    ZOT_IDENTITY_SECRET,
    S3_IDENTITY_SECRET,
    LOADER_TLS_SECRET,
    STORAGE_TLS_SECRET,
    MODEL_GATEWAY_TLS_SECRET,
  ].map((name) => ({ namespace: 'lifemodel-system', name, create: false })),
  { namespace: 'lifemodel', name: CORE_TLS_SECRET, create: false },
].map((target) => ({ ...target, resource: 'secrets' }));
const configMapTargets: WriteTarget[] = [
  ...SETTINGS_PROJECTION_TARGETS.map((target) => ({ ...target, create: true })),
  ...['lifemodel-system', 'lifemodel', 'lifemodel-motor'].map((namespace) => ({
    namespace,
    name: CA_CONFIGMAP,
    create: false,
  })),
  { namespace: 'lifemodel-system', name: STATUS_CONFIGMAP, create: false },
].map((target) => ({ ...target, resource: 'configmaps' }));

function policy(resource: WriteTarget['resource']): any {
  const name = resource === 'secrets' ? 'loader-secret-admission' : 'loader-configmap-admission';
  const found = objects.find(
    (item) => item?.kind === 'ValidatingAdmissionPolicy' && item.metadata.name === name
  );
  expect(found, name).toBeDefined();
  expect(found.spec.failurePolicy).toBe('Fail');
  expect(
    objects.find(
      (item) => item?.kind === 'ValidatingAdmissionPolicyBinding' && item.spec.policyName === name
    )?.spec.validationActions
  ).toEqual(['Deny']);
  return found;
}

function admitted(target: WriteTarget, operation: string): boolean {
  const rule = policy(target.resource);
  const namespaces = rule.spec.matchConstraints.namespaceSelector.matchExpressions[0];
  expect(namespaces.key).toBe('kubernetes.io/metadata.name');
  expect(namespaces.operator).toBe('In');
  // System Secrets deliberately do not match the Secret clamp: A0 creates
  // them and fixed-name update-only RBAC is their write boundary.
  if (!namespaces.values.includes(target.namespace)) return true;
  expect(rule.spec.matchConstraints.resourceRules).toEqual([
    {
      apiGroups: [''],
      apiVersions: ['v1'],
      operations: ['CREATE', 'UPDATE', 'DELETE'],
      resources: [target.resource],
    },
  ]);
  const context = {
    request: {
      namespace: target.namespace,
      name: target.name,
      operation,
      userInfo: { username: loader },
    },
    object:
      operation === 'DELETE'
        ? null
        : {
            metadata: { namespace: target.namespace, name: target.name },
            data: target.name === CA_CONFIGMAP ? { 'ca.crt': 'public-ca' } : {},
          },
  };
  for (const condition of rule.spec.matchConditions)
    expect(evaluate(condition.expression, context)).toBe(true);
  return rule.spec.validations.every(
    (validation: any) => evaluate(validation.expression, context) === true
  );
}

function authorized(target: WriteTarget, verb: string): boolean {
  return objects
    .filter(
      (item) =>
        item?.kind === 'RoleBinding' &&
        item.metadata.namespace === target.namespace &&
        item.subjects?.some(
          (subject: any) =>
            subject.kind === 'ServiceAccount' &&
            subject.name === 'loader' &&
            subject.namespace === 'lifemodel-system'
        )
    )
    .some((binding) => {
      expect(binding.roleRef.kind).toBe('Role');
      const role = objects.find(
        (item) =>
          item?.kind === 'Role' &&
          item.metadata.namespace === target.namespace &&
          item.metadata.name === binding.roleRef.name
      );
      expect(role, binding.roleRef.name).toBeDefined();
      return role.rules.some(
        (rule: any) =>
          rule.apiGroups.includes('') &&
          rule.resources.includes(target.resource) &&
          rule.verbs.includes(verb) &&
          (!rule.resourceNames || (verb !== 'create' && rule.resourceNames.includes(target.name)))
      );
    });
}

describe('loader writes versus committed admission and RBAC', () => {
  for (const target of [...secretTargets, ...configMapTargets]) {
    const label = `${target.resource} ${target.namespace}/${target.name}`;
    it(`admits and authorizes ${label}`, () => {
      expect(authorized(target, 'get'), `${label} get RBAC`).toBe(true);
      // Source passwords are created once and only read thereafter.
      const sourcePassword = target.resource === 'secrets' && target.namespace === SOURCE_NAMESPACE;
      for (const operation of [
        ...(target.create ? ['CREATE'] : []),
        ...(!sourcePassword ? ['UPDATE'] : []),
      ]) {
        expect(admitted(target, operation), `${label} ${operation} admission`).toBe(true);
        expect(authorized(target, operation.toLowerCase()), `${label} ${operation} RBAC`).toBe(
          true
        );
      }
      expect(authorized(target, 'delete'), `${label} delete RBAC`).toBe(false);
      if (target.resource === 'configmaps' || target.namespace !== 'lifemodel-system')
        expect(admitted(target, 'DELETE'), `${label} delete admission`).toBe(false);
      if (!target.create) {
        // A precreated target must exist even when create permission exists
        // for another name in the namespace.
        expect(
          objects.some(
            (item) =>
              item?.kind === (target.resource === 'secrets' ? 'Secret' : 'ConfigMap') &&
              item.metadata.namespace === target.namespace &&
              item.metadata.name === target.name
          ),
          `${label} platform placeholder`
        ).toBe(true);
      }
    });
  }

  it('allows only the capture name in state on create/update, never delete or another namespace', () => {
    const target: WriteTarget = {
      namespace: SOURCE_NAMESPACE,
      name: CAPTURE_SECRET_NAME,
      resource: 'secrets',
      create: true,
    };
    expect(admitted(target, 'CREATE')).toBe(true);
    expect(admitted(target, 'UPDATE')).toBe(true);
    expect(admitted(target, 'DELETE')).toBe(false);
    expect(admitted({ ...target, name: `${target.name}-extra` }, 'CREATE')).toBe(false);
    for (const namespace of ['lifemodel', 'lifemodel-motor', 'lifemodel-git']) {
      expect(admitted({ ...target, namespace }, 'CREATE')).toBe(false);
      expect(admitted({ ...target, namespace }, 'UPDATE')).toBe(false);
    }
    expect(admitted({ ...target, name: 'lifemodel-app' }, 'CREATE')).toBe(false);
    expect(admitted({ ...target, namespace: 'lifemodel', name: CORE_TLS_SECRET }, 'CREATE')).toBe(
      false
    );
  });
});
