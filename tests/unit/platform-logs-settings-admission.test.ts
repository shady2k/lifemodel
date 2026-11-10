/**
 * The two admission lists the retention setting needs, and the Deployment clamp
 * (ADR-016 §5, N6; check L08).
 *
 * The loader's rights alone are not enough: the A0 policies decide which
 * ConfigMap names may exist in `lifemodel-system` and who may own them. Both
 * lists now carry `lifemodel-logs-settings`, the loader may create and update
 * it, another identity may not, and the store's Deployment accepts a change to
 * its two revision annotation maps from nobody but the loader and to nothing
 * else.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import YAML from 'yaml';
import { evaluate } from '@marcbachmann/cel-js';
import {
  LOGS_PARTITION_KEY_REVISION_ANNOTATION,
  LOGS_SETTINGS_CONFIGMAP,
  LOGS_SETTINGS_REVISION_ANNOTATION,
  LOGS_STORE_DEPLOYMENT,
} from '../../loader/src/logs-settings-cluster.js';

const root = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const resources = YAML.parse(readFileSync(join(root, 'a0/kustomization.yaml'), 'utf8'))
  .resources as string[];
const objects = resources.flatMap((resource) =>
  YAML.parseAllDocuments(readFileSync(join(root, 'a0', resource), 'utf8')).map((doc) =>
    doc.toJSON()
  )
);

const LOADER = 'system:serviceaccount:lifemodel-system:loader';
const CNPG = 'system:serviceaccount:cnpg-system:cloudnative-pg';

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

/**
 * The apiserver's decision: the resource rules and the conditions select the
 * request, then the validation decides. `matched: false` means the policy does
 * not apply at all, which is not the same answer as a refusal.
 */
function decision(
  policyObject: any,
  context: { request: { operation?: string }; object: unknown; oldObject?: unknown }
): { matched: boolean; allowed: boolean } {
  const operations: string[] = policyObject.spec.matchConstraints.resourceRules[0].operations ?? [];
  const conditions = (policyObject.spec.matchConditions ?? []) as { expression: string }[];
  const matched =
    (context.request.operation === undefined || operations.includes(context.request.operation)) &&
    conditions.every((condition) => Boolean(evaluate(condition.expression, context as never)));
  if (!matched) return { matched: false, allowed: false };
  return {
    matched: true,
    allowed: Boolean(evaluate(policyObject.spec.validations[0].expression, context as never)),
  };
}

/** The same, for a policy whose rules always apply to the request under test. */
function admits(
  policyObject: any,
  context: { request: unknown; object: unknown; oldObject?: unknown }
): boolean {
  const answer = decision(policyObject, context as never);
  if (!answer.matched) throw new Error('the policy does not apply to this request');
  return answer.allowed;
}

const settingsConfigMap = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: LOGS_SETTINGS_CONFIGMAP, namespace: 'lifemodel-system' },
  data: {
    VL_retentionPeriod: '7d',
    VL_retention_maxDiskSpaceUsageBytes: '1073741824',
    VL_storage_minFreeDiskSpaceBytes: '805306368',
  },
};

describe('the loader ConfigMap clamp admits the log settings projection (N6)', () => {
  it('admits its create and its update, in the store namespace, for the loader only', () => {
    const clamp = policy('loader-configmap-admission');
    const create = {
      request: {
        operation: 'CREATE',
        namespace: 'lifemodel-system',
        userInfo: { username: LOADER },
      },
      object: settingsConfigMap,
    };
    expect(admits(clamp, create)).toBe(true);
    expect(
      admits(clamp, {
        request: { ...create.request, operation: 'UPDATE' },
        object: settingsConfigMap,
      })
    ).toBe(true);
    // Another identity is not the clamp's subject: its own denial is the
    // ownership list below, and the clamp refuses no deletion for anyone.
    expect(
      admits(clamp, {
        request: { ...create.request, operation: 'DELETE' },
        object: settingsConfigMap,
      })
    ).toBe(false);
    // A ConfigMap the projection does not name is refused for the loader too.
    for (const name of ['lifemodel-logs-settings-copy', 'lifemodel-storage-settings-2', 'other']) {
      expect(
        admits(clamp, {
          request: create.request,
          object: { metadata: { name, namespace: 'lifemodel-system' } },
        }),
        name
      ).toBe(false);
    }
    // And the same name in another namespace is not this projection.
    expect(
      admits(clamp, {
        request: { ...create.request, namespace: 'lifemodel' },
        object: {
          ...settingsConfigMap,
          metadata: { ...settingsConfigMap.metadata, namespace: 'lifemodel' },
        },
      })
    ).toBe(false);
  });

  it('reserves the projection to the loader against every other identity', () => {
    const ownership = policy('platform-settings-ownership-admission');
    expect(
      admits(ownership, {
        request: {
          operation: 'CREATE',
          namespace: 'lifemodel-system',
          name: LOGS_SETTINGS_CONFIGMAP,
          userInfo: { username: LOADER },
        },
        object: settingsConfigMap,
      })
    ).toBe(true);
    expect(
      admits(ownership, {
        request: {
          operation: 'UPDATE',
          namespace: 'lifemodel-system',
          name: LOGS_SETTINGS_CONFIGMAP,
          userInfo: { username: LOADER },
        },
        object: settingsConfigMap,
      })
    ).toBe(true);
    for (const operation of ['CREATE', 'UPDATE', 'DELETE']) {
      expect(
        admits(ownership, {
          request: {
            operation,
            namespace: 'lifemodel-system',
            name: LOGS_SETTINGS_CONFIGMAP,
            userInfo: { username: CNPG },
          },
          object: operation === 'DELETE' ? null : settingsConfigMap,
        }),
        `${operation} by the operator`
      ).toBe(false);
    }
    // The list still names both projections: the storage module's as before.
    const condition = ownership.spec.matchConditions[0].expression as string;
    expect(condition).toContain('lifemodel-storage-settings');
    expect(condition).toContain(LOGS_SETTINGS_CONFIGMAP);
  });
});

describe("the store Deployment's clamp (N6)", () => {
  const revision = '3-9f8e7d6c5b4a';
  const current = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: LOGS_STORE_DEPLOYMENT, namespace: 'lifemodel-system', generation: 4 },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': 'logs-store' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'logs-store' } },
        spec: {
          containers: [
            {
              name: 'logs-store',
              image: 'registry.example/logs@sha256:abc',
              args: ['-envflag.enable', '-envflag.prefix=VL_'],
            },
          ],
        },
      },
    },
    status: { observedGeneration: 4 },
  };
  const bumped = () => {
    const next = structuredClone(current);
    next.metadata.annotations = { [LOGS_SETTINGS_REVISION_ANNOTATION]: revision };
    next.spec.template.metadata.annotations = { [LOGS_SETTINGS_REVISION_ANNOTATION]: revision };
    next.metadata.generation = 5;
    return next;
  };
  const update = (object: unknown, oldObject: unknown = current, username = LOADER) => ({
    request: {
      operation: 'UPDATE',
      namespace: 'lifemodel-system',
      name: LOGS_STORE_DEPLOYMENT,
      userInfo: { username },
    },
    object,
    oldObject,
  });

  it('admits the two annotation maps and nothing else', () => {
    const clamp = policy('loader-logs-store-deployment-admission');
    expect(binding('loader-logs-store-deployment-admission')?.spec.validationActions).toEqual([
      'Deny',
    ]);
    expect(binding('loader-logs-store-deployment-admission')?.spec.policyName).toBe(
      'loader-logs-store-deployment-admission'
    );
    expect(admits(clamp, update(bumped()))).toBe(true);
  });

  it('refuses every other field of that Deployment', () => {
    const clamp = policy('loader-logs-store-deployment-admission');
    const mutations: [string, (next: any) => void][] = [
      ['another replica count', (next) => (next.spec.replicas = 2)],
      ['another strategy', (next) => (next.spec.strategy = { type: 'RollingUpdate' })],
      ['another selector', (next) => (next.spec.selector.matchLabels.extra = 'x')],
      ['another image', (next) => (next.spec.template.spec.containers[0].image = 'other')],
      [
        'another argument',
        (next) => next.spec.template.spec.containers[0].args.push('-retentionPeriod=9d'),
      ],
      ['another pod label', (next) => (next.spec.template.metadata.labels.extra = 'x')],
      ['another object label', (next) => (next.metadata.labels = { extra: 'x' })],
      ['another name', (next) => (next.metadata.name = 'logs-store-2')],
      ['an annotation on one map only', (next) => delete next.spec.template.metadata.annotations],
      [
        'two different revisions',
        (next) =>
          (next.spec.template.metadata.annotations[LOGS_SETTINGS_REVISION_ANNOTATION] = '1-old'),
      ],
    ];
    for (const [reason, mutate] of mutations) {
      const next = bumped();
      mutate(next);
      expect(admits(clamp, update(next)), reason).toBe(false);
    }
  });

  it('does not apply to another identity, another object or a create', () => {
    const clamp = policy('loader-logs-store-deployment-admission');
    // The clamp's subject is the loader: another identity's update of that
    // object is not selected by it at all.
    expect(decision(clamp, update(bumped(), current, CNPG)).matched).toBe(false);
    expect(
      decision(clamp, {
        ...update(bumped()),
        request: { ...update(bumped()).request, name: 'another-deployment' },
      }).matched
    ).toBe(false);
    expect(
      decision(clamp, {
        ...update(bumped()),
        request: { ...update(bumped()).request, namespace: 'lifemodel' },
      }).matched
    ).toBe(false);
    // Nor does a create of the object: only an update is matched.
    expect(
      decision(clamp, {
        ...update(bumped()),
        request: { ...update(bumped()).request, operation: 'CREATE' },
      }).matched
    ).toBe(false);
    const rules = clamp.spec.matchConstraints.resourceRules[0];
    expect(rules).toMatchObject({
      apiGroups: ['apps'],
      resources: ['deployments'],
      operations: ['UPDATE'],
    });
    // The policies are Deny-bound, so a refusal is an answer, never a warning.
    expect(clamp.spec.failurePolicy).toBe('Fail');
  });
});
describe("the store Deployment's clamp and the partition key's annotation", () => {
  const keyRevision = '1-1111222233334444';
  const current = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: LOGS_STORE_DEPLOYMENT, namespace: 'lifemodel-system', generation: 4 },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': 'logs-store' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'logs-store' } },
        spec: {
          containers: [
            {
              name: 'logs-store',
              image: 'registry.example/logs@sha256:abc',
              args: ['-envflag.enable', '-envflag.prefix=VL_'],
            },
          ],
        },
      },
    },
    status: { observedGeneration: 4 },
  };
  const keyed = (annotations: Record<string, string>) => {
    const next = structuredClone(current);
    next.metadata.annotations = { ...annotations };
    next.spec.template.metadata.annotations = { ...annotations };
    next.metadata.generation = 5;
    return next;
  };
  const update = (object: unknown, oldObject: unknown = current) => ({
    request: {
      operation: 'UPDATE',
      namespace: 'lifemodel-system',
      name: LOGS_STORE_DEPLOYMENT,
      userInfo: { username: LOADER },
    },
    object,
    oldObject,
  });

  it('admits the key revision alone, and beside the settings revision', () => {
    const clamp = policy('loader-logs-store-deployment-admission');
    // A first install: the store has never had retention written, so the
    // settings annotation is not there yet and the key patch is the first one.
    expect(
      admits(clamp, update(keyed({ [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: keyRevision })))
    ).toBe(true);
    expect(
      admits(
        clamp,
        update(
          keyed({
            [LOGS_SETTINGS_REVISION_ANNOTATION]: '3-9f8e7d6c5b4a',
            [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: keyRevision,
          })
        )
      )
    ).toBe(true);
    // The settings patch after a key was written: both maps keep the key.
    const settings = keyed({ [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: keyRevision });
    const patch = structuredClone(settings);
    patch.metadata.annotations[LOGS_SETTINGS_REVISION_ANNOTATION] = '4-aaaa';
    patch.spec.template.metadata.annotations[LOGS_SETTINGS_REVISION_ANNOTATION] = '4-aaaa';
    expect(admits(clamp, update(patch, settings))).toBe(true);
  });

  it('refuses the key annotation anywhere but in both maps, together and unchanged elsewhere', () => {
    const clamp = policy('loader-logs-store-deployment-admission');
    const mutations: [string, (next: any) => void][] = [
      [
        'a key revision on the object only',
        (next) => {
          next.spec.template.metadata.annotations = {};
        },
      ],
      [
        'a key revision on the template only',
        (next) => {
          next.metadata.annotations = {};
        },
      ],
      [
        'two different key revisions',
        (next) => {
          next.spec.template.metadata.annotations[LOGS_PARTITION_KEY_REVISION_ANNOTATION] = '1-old';
        },
      ],
      [
        'neither revision',
        (next) => {
          next.metadata.annotations = {};
          next.spec.template.metadata.annotations = {};
        },
      ],
      [
        'another image while the key is bumped',
        (next) => {
          next.spec.template.spec.containers[0].image = 'other';
        },
      ],
      [
        'another replica count while the key is bumped',
        (next) => {
          next.spec.replicas = 2;
        },
      ],
      [
        'another pod label while the key is bumped',
        (next) => {
          next.spec.template.metadata.labels.extra = 'x';
        },
      ],
      [
        'another argument while the key is bumped',
        (next) => {
          next.spec.template.spec.containers[0].args.push('-retentionPeriod=9d');
        },
      ],
    ];
    for (const [reason, mutate] of mutations) {
      const next = keyed({ [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: keyRevision });
      mutate(next);
      expect(admits(clamp, update(next)), reason).toBe(false);
    }
  });
});

/**
 * The clamp compares the whole object, not a list of named fields (N6). A
 * merge patch the loader did not write can carry any field beside the
 * revision annotation - `spec.paused` above all - and a named-field list
 * admitted whatever it forgot to name. So the test drives a Deployment as the
 * apiserver returns it: status, managed fields and a resource version the
 * apiserver changes, and one patch the loader really sends beside each field
 * the object must refuse.
 */
describe("the store Deployment's clamp compares the whole object (N6)", () => {
  const revision = '7-9f8e7d6c5b4a';
  const previousRevision = '6-1a2b3c4d5e6f';
  const current = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: LOGS_STORE_DEPLOYMENT,
      namespace: 'lifemodel-system',
      uid: '3c1d0f52-2b7e-4a6f-9c1d-7e5a4b3c2d1e',
      creationTimestamp: '2026-11-01T00:00:00Z',
      resourceVersion: '9001',
      generation: 7,
      labels: { 'app.kubernetes.io/name': 'logs-store' },
      annotations: {
        [LOGS_SETTINGS_REVISION_ANNOTATION]: previousRevision,
        'lifemodel.dev/owner': 'platform',
      },
      managedFields: [{ manager: 'flux', operation: 'Apply' }],
    },
    spec: {
      replicas: 1,
      paused: false,
      minReadySeconds: 0,
      revisionHistoryLimit: 10,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': 'logs-store' } },
      template: {
        metadata: {
          labels: { 'app.kubernetes.io/name': 'logs-store' },
          annotations: {
            [LOGS_SETTINGS_REVISION_ANNOTATION]: previousRevision,
            'lifemodel.dev/owner': 'platform',
          },
        },
        spec: {
          containers: [
            {
              name: 'logs-store',
              image: 'registry.example/logs@sha256:abc',
              args: ['-envflag.enable', '-envflag.prefix=VL_'],
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 7,
      replicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    },
  };
  /** The object the apiserver answers with after the loader's own merge patch. */
  const patched = () => {
    const next = structuredClone(current);
    next.metadata.annotations[LOGS_SETTINGS_REVISION_ANNOTATION] = revision;
    next.spec.template.metadata.annotations[LOGS_SETTINGS_REVISION_ANNOTATION] = revision;
    next.metadata.generation = 8;
    next.metadata.resourceVersion = '9002';
    next.metadata.managedFields.push({ manager: 'loader', operation: 'Update' });
    next.status.observedGeneration = 8;
    return next;
  };
  const update = (object: unknown, oldObject: unknown = current) => ({
    request: {
      operation: 'UPDATE',
      namespace: 'lifemodel-system',
      name: LOGS_STORE_DEPLOYMENT,
      userInfo: { username: LOADER },
    },
    object,
    oldObject,
  });
  const clamp = () => policy('loader-logs-store-deployment-admission');

  it('admits the loader revision patch, with the fields the apiserver rewrites', () => {
    expect(admits(clamp(), update(patched()))).toBe(true);
    // The partition key's pair travels the same way, on top of the settings one.
    const keyed = patched();
    keyed.metadata.annotations[LOGS_PARTITION_KEY_REVISION_ANNOTATION] = '1-0000111122223333';
    keyed.spec.template.metadata.annotations[LOGS_PARTITION_KEY_REVISION_ANNOTATION] =
      '1-0000111122223333';
    expect(admits(clamp(), update(keyed, patched()))).toBe(true);
    // An identical resend is no change, and so not a change of anything else.
    expect(admits(clamp(), update(patched(), patched()))).toBe(true);
  });

  it('admits the stranded-day ledger atomically with a rollout and resource version change', () => {
    const annotation = 'lifemodel.dev/logs-stranded-days';
    const next = patched();
    next.metadata.annotations[annotation] = '20261109';
    next.spec.template.metadata.annotations[annotation] = '20261109';
    expect(admits(clamp(), update(next))).toBe(true);
    expect(admits(clamp(), update(next, next))).toBe(true);
    const appended = structuredClone(next);
    appended.metadata.annotations[annotation] = '20261108,20261109';
    appended.spec.template.metadata.annotations[annotation] = '20261108,20261109';
    appended.metadata.resourceVersion = '9003';
    expect(admits(clamp(), update(appended, next))).toBe(true);

    for (const mutate of [
      (object: typeof next) => delete object.metadata.annotations[annotation],
      (object: typeof next) => delete object.spec.template.metadata.annotations[annotation],
      (object: typeof next) => {
        object.spec.template.metadata.annotations[annotation] = '20261108';
      },
      (object: typeof next) => {
        object.spec.paused = true;
      },
      (object: typeof next) => {
        object.metadata.annotations['lifemodel.dev/extra'] = 'x';
      },
    ]) {
      const invalid = structuredClone(next);
      mutate(invalid);
      expect(admits(clamp(), update(invalid))).toBe(false);
    }
  });

  it('refuses spec.paused set in the same patch', () => {
    const paused = patched();
    paused.spec.paused = true;
    expect(admits(clamp(), update(paused))).toBe(false);
    // The store stops replacing its pod for good: a later retention or
    // partition-key rollout then never takes effect.
    const onlyPaused = structuredClone(current);
    onlyPaused.spec.paused = true;
    expect(admits(clamp(), update(onlyPaused))).toBe(false);
  });

  it('refuses a field of the spec or the template that the clamp does not name', () => {
    const mutations: [string, (next: ReturnType<typeof patched>) => void][] = [
      ['another minimum ready time', (next) => (next.spec.minReadySeconds = 5)],
      ['another revision history limit', (next) => (next.spec.revisionHistoryLimit = 2)],
      [
        'a strategy that keeps the old pod',
        (next) => {
          next.spec.strategy = { type: 'RollingUpdate' };
        },
      ],
      [
        'another template field',
        (next) => {
          (next.spec.template.spec as any).hostNetwork = true;
        },
      ],
      [
        'another container beside the store',
        (next) => {
          next.spec.template.spec.containers.push({
            name: 'sidecar',
            image: 'registry.example/sidecar@sha256:def',
            args: [],
          });
        },
      ],
    ];
    for (const [reason, mutate] of mutations) {
      const next = patched();
      mutate(next);
      expect(admits(clamp(), update(next)), reason).toBe(false);
    }
  });

  it('refuses another annotation key, or another value under a kept key', () => {
    const mutations: [string, (next: ReturnType<typeof patched>) => void][] = [
      [
        'an annotation added on the object',
        (next) => {
          next.metadata.annotations['lifemodel.dev/extra'] = 'x';
        },
      ],
      [
        'an annotation added on the pod template',
        (next) => {
          next.spec.template.metadata.annotations['lifemodel.dev/extra'] = 'x';
        },
      ],
      [
        'an annotation kept on the object alone',
        (next) => {
          delete next.spec.template.metadata.annotations['lifemodel.dev/owner'];
        },
      ],
      [
        'a changed value under another key',
        (next) => {
          next.metadata.annotations['lifemodel.dev/owner'] = 'someone';
          next.spec.template.metadata.annotations['lifemodel.dev/owner'] = 'someone';
        },
      ],
      [
        'a removed annotation',
        (next) => {
          delete next.metadata.annotations['lifemodel.dev/owner'];
          delete next.spec.template.metadata.annotations['lifemodel.dev/owner'];
        },
      ],
    ];
    for (const [reason, mutate] of mutations) {
      const next = patched();
      mutate(next);
      expect(admits(clamp(), update(next)), reason).toBe(false);
    }
  });
});
