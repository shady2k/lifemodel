/**
 * The retention setting's rendered manifests (ADR-016 §5, N6; check L08).
 *
 * The store starts from the defaults ConfigMap with the loader's absent, no
 * manifest declares the revision annotation, the Deployment passes no retention
 * argument of its own, the loader's rights on the projection and the Deployment
 * are exactly the ones the code uses, and nothing Flux applies owns the
 * loader's ConfigMap.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  configMapLogData,
  LOGS_SETTINGS_CONFIGMAP,
  LOGS_SETTINGS_CONFIGMAP_COLLECTION,
  LOGS_SETTINGS_CONFIGMAP_PATH,
  LOGS_SETTINGS_REVISION_ANNOTATION,
  LOGS_STORE_DEPLOYMENT,
  LOGS_STORE_DEPLOYMENT_PATH,
  LOGS_STORE_PODS_PATH,
} from '../../loader/src/logs-settings-cluster.js';
import { LOGS_CLAIM_NAME, LOGS_VOLUME_NAME } from '../../loader/src/logs-volume-claim.js';
import {
  LOGS_RETENTION_DEFAULT_DAYS,
  LOGS_RETENTION_DEFAULT_MAX_BYTES,
  marginBytesOf,
  parseKubernetesQuantity,
  retentionLimits,
  storeFlagsOf,
} from '../../loader/src/logs-retention.js';

const deployRoot = fileURLToPath(new URL('../../deploy/', import.meta.url));
const platformRoot = join(deployRoot, 'platform/');

type Resource = Record<string, any>;

function yamlFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return name.endsWith('.yaml') ? [path] : [];
  });
}

function documents(path: string): Resource[] {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8'))
    .map((doc) => doc.toJSON())
    .filter((doc): doc is Resource => typeof doc === 'object' && doc !== null);
}

function find(resources: Resource[], kind: string, name: string): Resource {
  const found = resources.find(
    (resource) => resource.kind === kind && resource.metadata?.name === name
  );
  if (found === undefined) throw new Error(`no ${kind} named ${name}`);
  return found;
}

const storeResources = [
  'volume.yaml',
  'settings-defaults.yaml',
  'partition-key.yaml',
  'logs-store.yaml',
  'evictor.yaml',
  'network-policy.yaml',
].flatMap((name) => documents(join(platformRoot, 'logs-store', name)));

const rbacResources = documents(join(platformRoot, 'a/loader-settings-rbac.yaml'));

describe('the store boots from the defaults with the loader absent', () => {
  it('lists the loader ConfigMap after the defaults, optional, and passes no retention argument', () => {
    const deployment = find(storeResources, 'Deployment', LOGS_STORE_DEPLOYMENT);
    const container = deployment.spec.template.spec.containers[0];
    expect(container.envFrom).toEqual([
      { configMapRef: { name: 'lifemodel-logs-settings-defaults' } },
      { configMapRef: { name: LOGS_SETTINGS_CONFIGMAP, optional: true } },
    ]);
    // The second entry wins once it exists; a first start runs the defaults.
    const args: string[] = container.args;
    for (const flag of [
      '-retentionPeriod',
      '-retention.maxDiskSpaceUsageBytes',
      '-storage.minFreeDiskSpaceBytes',
      '-delete.enable',
    ])
      expect(args.some((arg) => arg.startsWith(flag)), flag).toBe(false);
    // The env prefix is what makes the mapping work at all (F3).
    expect(args).toContain('-envflag.enable');
    expect(args).toContain('-envflag.prefix=VL_');
  });

  it('declares no revision annotation anywhere in the release manifest', () => {
    for (const resource of storeResources) {
      const text = JSON.stringify(resource);
      expect(text).not.toContain(LOGS_SETTINGS_REVISION_ANNOTATION);
    }
    // Flux owns the Deployment; the loader adds the annotation by patch and a
    // reconcile never reverts a field the artifact does not declare.
    const deployment = find(storeResources, 'Deployment', LOGS_STORE_DEPLOYMENT);
    expect(deployment.metadata.annotations).toBeUndefined();
    expect(deployment.spec.template.metadata.annotations).toBeUndefined();
  });

  it('carries the defaults the loader computes for the volume it ships', () => {
    const defaults = find(storeResources, 'ConfigMap', 'lifemodel-logs-settings-defaults');
    expect(defaults.metadata.namespace).toBe('lifemodel-system');
    const claim = find(storeResources, 'PersistentVolumeClaim', 'logs-store');
    const volumeBytes = parseKubernetesQuantity(claim.spec.resources.requests.storage);
    expect(volumeBytes).not.toBeNull();
    const limits = retentionLimits(volumeBytes as number);
    expect(defaults.data).toEqual(
      configMapLogData(
        storeFlagsOf(
          { days: LOGS_RETENTION_DEFAULT_DAYS, maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES },
          limits
        )
      )
    );
    // The ADR's numbers: a 3 GiB volume, a 1.5 GiB threshold, a 1.5 GiB bound.
    expect(defaults.data).toEqual({
      VL_retentionPeriod: '14d',
      VL_retention_maxDiskSpaceUsageBytes: '1610612736',
      VL_storage_minFreeDiskSpaceBytes: '805306368',
    });
    expect(limits.evictorThresholdBytes).toBe(1_610_612_736);
    expect(limits.largestMaxBytes).toBe(LOGS_RETENTION_DEFAULT_MAX_BYTES);
    expect(marginBytesOf(limits.volumeBytes)).toBe(805_306_368);
  });

  it('has no manifest that would let Flux own the loader ConfigMap', () => {
    const owners = yamlFiles(deployRoot)
      .flatMap(documents)
      .filter((resource) => resource.kind === 'ConfigMap')
      .filter((resource) => resource.metadata?.name === LOGS_SETTINGS_CONFIGMAP);
    expect(owners).toEqual([]);
    // The Volume the claim names is the one the code reads, and it is retained.
    const volume = find(storeResources, 'PersistentVolume', LOGS_VOLUME_NAME);
    expect(volume.spec.persistentVolumeReclaimPolicy).toBe('Retain');
    const claim = find(storeResources, 'PersistentVolumeClaim', LOGS_CLAIM_NAME);
    expect(claim.spec.volumeName).toBe(LOGS_VOLUME_NAME);
  });
});

/** The loader's rights on the projection and the store, exactly as declared. */
function assertLogsSettingsRbac(resources: Resource[]): void {
  const expected = [
    {
      apiGroups: [''],
      resources: ['configmaps'],
      resourceNames: [LOGS_SETTINGS_CONFIGMAP],
      verbs: ['get', 'update'],
    },
    { apiGroups: [''], resources: ['configmaps'], verbs: ['create'] },
    {
      apiGroups: ['apps'],
      resources: ['deployments'],
      resourceNames: [LOGS_STORE_DEPLOYMENT],
      verbs: ['get', 'patch'],
    },
    { apiGroups: [''], resources: ['pods'], verbs: ['list'] },
  ];
  const role = find(resources, 'Role', 'loader-logs-settings');
  if (JSON.stringify(role.rules) !== JSON.stringify(expected))
    throw new Error(
      `the loader's log settings grant is not exactly the four named rules: ${JSON.stringify(role.rules)}`
    );
  const binding = find(resources, 'RoleBinding', 'loader-logs-settings');
  if (binding.metadata.namespace !== 'lifemodel-system') throw new Error('binding is in another namespace');
  if (binding.roleRef.name !== 'loader-logs-settings' || binding.roleRef.kind !== 'Role')
    throw new Error('binding names another role');
  const subjects = JSON.stringify(binding.subjects);
  if (subjects !== JSON.stringify([{ kind: 'ServiceAccount', name: 'loader', namespace: 'lifemodel-system' }]))
    throw new Error(`binding grants another identity: ${subjects}`);
}

describe("the loader's rights on the projection and the store (N6)", () => {
  it('are exactly the four named rules, and the code reads the paths they allow', () => {
    expect(() => assertLogsSettingsRbac(rbacResources)).not.toThrow();
    // The names the code uses are the ones the manifests declare.
    expect(LOGS_SETTINGS_CONFIGMAP).toBe('lifemodel-logs-settings');
    expect(LOGS_STORE_DEPLOYMENT).toBe('logs-store');
    expect(LOGS_SETTINGS_REVISION_ANNOTATION).toBe('lifemodel.dev/logs-settings-revision');
    expect(LOGS_SETTINGS_CONFIGMAP_PATH).toBe(
      '/api/v1/namespaces/lifemodel-system/configmaps/lifemodel-logs-settings'
    );
    expect(LOGS_SETTINGS_CONFIGMAP_COLLECTION).toBe('/api/v1/namespaces/lifemodel-system/configmaps');
    expect(LOGS_STORE_DEPLOYMENT_PATH).toBe(
      '/apis/apps/v1/namespaces/lifemodel-system/deployments/logs-store'
    );
    // A labelled read of the store's pods is a collection read: `list`.
    expect(LOGS_STORE_PODS_PATH).toBe(
      '/api/v1/namespaces/lifemodel-system/pods?labelSelector=app.kubernetes.io%2Fname%3Dlogs-store'
    );
  });

  it('fails when the grant is widened in any way', () => {
    const role = () => find(structuredClone(rbacResources), 'Role', 'loader-logs-settings');
    const cases: [string, (rules: any[]) => void][] = [
      ['an extra verb', (rules) => rules[0].verbs.push('delete')],
      ['an extra ConfigMap name', (rules) => rules[0].resourceNames.push('other')],
      ['no ConfigMap name', (rules) => delete rules[0].resourceNames],
      ['another verb on the Deployment', (rules) => rules[2].verbs.push('update')],
      ['no Deployment name', (rules) => delete rules[2].resourceNames],
      ['another API group', (rules) => rules[3].apiGroups.push('apps')],
      ['a pod get as well as a list', (rules) => rules[3].verbs.push('get')],
      ['configmaps clustered', (rules) => rules.push({ apiGroups: [''], resources: ['configmaps'], verbs: ['get'] })],
    ];
    for (const [reason, mutate] of cases) {
      const resources = structuredClone(rbacResources);
      mutate(find(resources, 'Role', 'loader-logs-settings').rules);
      expect(() => assertLogsSettingsRbac(resources), reason).toThrow(/not exactly/);
    }
    // The committed manifests still pass: the mutations were in memory only.
    expect(() => assertLogsSettingsRbac(role() ? rbacResources : [])).not.toThrow();
  });
});
