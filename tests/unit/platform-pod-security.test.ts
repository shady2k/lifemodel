import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  LOGS_CLAIM_NAME,
  LOGS_CLAIM_NAMESPACE,
  LOGS_VOLUME_NAME,
} from '../../loader/src/logs-volume-claim.js';
import {
  LOGS_EVICTOR_NAME,
  LOGS_EVICTOR_NAMESPACE,
  LOGS_EVICTOR_PATH,
} from '../../loader/src/logs-evictor-status.js';
import { renderStep } from '../helpers/kustomize-config-maps.js';

// ADR-016 §1, §5, §7 and check L13: the collector's namespace is the one
// privileged exception, it holds exactly one workload, and its two host mounts
// are the only ones the platform grants. The store is a restricted single-pod
// Deployment on its own retained local volume. Both log steps run at
// wait: false so a broken log pod cannot hold the platform's readiness.

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const vectorDigest = 'sha256:f6c23b5a7e16fb2838d33619ef7acf4bad2289a7cf22bc90efc2371f520c4ea2';
const vectorImage = `docker.io/timberio/vector@${vectorDigest}`;
const storeDigest = 'sha256:251121fa882af99b95ba0c230a4a2f412ea602d2698c64a96c58dc9842bb755d';
const storeImage = `docker.io/victoriametrics/victoria-logs@${storeDigest}`;
// The collector's configuration is the logs step's generator input, mounted as
// vector.yaml (deploy/platform/logs/kustomization.yaml).
const collectorConfig = (): Record<string, any> =>
  YAML.parse(readFileSync(join(platformRoot, 'logs/config/vector.yaml'), 'utf8'));

// The store's defaults are the store step's generator input, read by envFrom.
const storeDefaults = (): Record<string, any> =>
  renderStep(join(platformRoot, 'logs-store')).generated.find(
    (item) => item.baseName === 'lifemodel-logs-settings-defaults'
  )!.object.data;

const workloadKinds = new Set([
  'DaemonSet',
  'Deployment',
  'StatefulSet',
  'ReplicaSet',
  'Job',
  'CronJob',
  'Pod',
]);

type Resource = { file: string; object: Record<string, any> };

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Vendored Helm charts are Go templates, not standalone Kubernetes YAML.
      return entry.name === 'charts' ? [] : yamlFiles(path);
    }
    return entry.name.endsWith('.yaml') && entry.name !== 'kustomization.yaml' ? [path] : [];
  });
}

let cachedObjects: Resource[] | undefined;

function platformObjects(): Resource[] {
  // Twelve tests read the same platform tree; parsing the large rendered
  // charts once keeps this file from competing with the installer harness
  // tests that share the second worker.
  if (cachedObjects) return cachedObjects;
  cachedObjects = yamlFiles(platformRoot).flatMap((file) => {
    const documents = YAML.parseAllDocuments(readFileSync(file, 'utf8'));
    expect(
      documents.flatMap((document) => document.errors),
      `invalid YAML in ${file}`
    ).toEqual([]);
    return documents
      .map((document) => document.toJSON() as Record<string, any> | null)
      .filter((object): object is Record<string, any> => Boolean(object))
      .map((object) => ({ file, object }));
  });
  return cachedObjects;
}

function find(resources: Resource[], kind: string, name: string): Resource {
  const found = resources.find(
    (resource) => resource.object.kind === kind && resource.object.metadata?.name === name
  );
  expect(found, `missing ${kind}/${name}`).toBeDefined();
  return found!;
}

function collectorPodSpec(resources: Resource[]): Record<string, any> {
  const daemonset = find(resources, 'DaemonSet', 'logs-collector').object;
  return daemonset.spec.template.spec;
}

function assertCollectorPodSecurity(podSpec: Record<string, any>): void {
  const pod = podSpec.securityContext ?? {};
  if (pod.runAsUser !== 0) throw new Error('collector pod must run as uid 0');
  if (pod.seccompProfile?.type !== 'RuntimeDefault')
    throw new Error('collector pod must use the RuntimeDefault seccomp profile');

  const container = (podSpec.containers ?? []).find(
    (candidate: any) => candidate.name === 'logs-collector'
  );
  if (!container) throw new Error('missing logs-collector container');
  const context = container.securityContext ?? {};
  if (context.privileged === true) throw new Error('collector must not be privileged');
  if (context.allowPrivilegeEscalation !== false)
    throw new Error('collector must not allow privilege escalation');
  if (context.readOnlyRootFilesystem !== true)
    throw new Error('collector root filesystem must be read-only');
  if ((context.capabilities?.add ?? []).length > 0)
    throw new Error('collector must not add a capability');
  if (context.capabilities?.drop?.includes('ALL') !== true)
    throw new Error('collector must drop every capability');
  if (context.runAsUser !== 0) throw new Error('collector container must run as uid 0');
  if (context.seccompProfile?.type !== 'RuntimeDefault')
    throw new Error('collector container must use the RuntimeDefault seccomp profile');

  const hostPathVolumes = (podSpec.volumes ?? []).filter((volume: any) => volume.hostPath);
  const paths = hostPathVolumes.map((volume: any) => [volume.name, volume.hostPath.path]);
  if (
    JSON.stringify(paths) !==
    JSON.stringify([
      ['pods', '/var/log/pods'],
      ['checkpoints', '/var/lib/lifemodel-logs-collector'],
    ])
  )
    throw new Error('collector must mount exactly the two host paths of ADR-016 §1');

  const mounts = (container.volumeMounts ?? []).filter((mount: any) =>
    ['pods', 'checkpoints'].includes(mount.name)
  );
  const podMount = mounts.find((mount: any) => mount.name === 'pods');
  const checkpointMount = mounts.find((mount: any) => mount.name === 'checkpoints');
  if (!podMount || podMount.mountPath !== '/var/log/pods' || podMount.readOnly !== true)
    throw new Error('collector must mount /var/log/pods read-only');
  if (
    !checkpointMount ||
    checkpointMount.mountPath !== '/var/lib/lifemodel-logs-collector' ||
    checkpointMount.readOnly === true
  )
    throw new Error('collector must mount its checkpoint directory read-write');
}

function egressRulePorts(policy: Record<string, any>): any[] {
  return (policy.spec.egress ?? []).flatMap((rule: any) => rule.ports ?? []);
}

function egressPeers(policy: Record<string, any>): any[] {
  return (policy.spec.egress ?? []).flatMap((rule: any) => rule.to ?? []);
}

describe('platform pod security (ADR-016 L13)', () => {
  it('is the only privileged namespace and holds exactly the collector DaemonSet', () => {
    const resources = platformObjects();
    const namespaces = resources.filter((resource) => resource.object.kind === 'Namespace');
    expect(namespaces.length).toBeGreaterThan(0);
    for (const { object } of namespaces) {
      const levels = ['enforce', 'audit', 'warn'].map(
        (level) => object.metadata.labels?.[`pod-security.kubernetes.io/${level}`]
      );
      if (object.metadata.name === 'lifemodel-logs') {
        expect(levels).toEqual(['privileged', 'privileged', 'privileged']);
      } else {
        expect(levels).toEqual(['restricted', 'restricted', 'restricted']);
      }
    }

    const workloads = resources
      .filter(
        (resource) =>
          workloadKinds.has(resource.object.kind) &&
          resource.object.metadata?.namespace === 'lifemodel-logs'
      )
      .map((resource) => `${resource.object.kind}/${resource.object.metadata.name}`);
    expect(workloads).toEqual(['DaemonSet/logs-collector']);
  });

  it('grants the collector uid 0 with no capability and exactly two host mounts', () => {
    const resources = platformObjects();
    const podSpec = collectorPodSpec(resources);
    expect(() => assertCollectorPodSecurity(podSpec)).not.toThrow();
  });

  it('gives the collector read-only metadata access and nothing else', () => {
    const resources = platformObjects();
    const role = find(resources, 'ClusterRole', 'logs-collector').object;
    expect(role.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['pods', 'namespaces', 'nodes'],
        verbs: ['get', 'list', 'watch'],
      },
    ]);
    const binding = find(resources, 'ClusterRoleBinding', 'logs-collector').object;
    expect(binding.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: 'logs-collector',
    });
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'logs-collector', namespace: 'lifemodel-logs' },
    ]);
    expect(find(resources, 'ServiceAccount', 'logs-collector').object.metadata.namespace).toBe(
      'lifemodel-logs'
    );
  });

  it('writes newline-delimited JSON to the store with the insert fields of §3', () => {
    const config = collectorConfig();
    expect(config.transforms.normalize.type).toBe('remap');
    const sink = config.sinks['logs-store'];
    expect(sink.uri).toBe(
      'http://logs-store.lifemodel-system.svc:9428/insert/jsonline?_stream_fields=module,namespace,level,untrusted&_msg_field=message&_time_field=timestamp'
    );
    expect(sink.framing).toEqual({ method: 'newline_delimited' });
    expect(sink.encoding).toEqual({ codec: 'json' });
    expect(sink.batch).toEqual({ max_events: 2000, timeout_secs: 1 });
    expect(sink.buffer).toEqual({ type: 'memory', max_events: 500000, when_full: 'block' });
  });

  it('fails when a third host mount is added, and passes again once it is reverted', () => {
    const resources = platformObjects();
    const podSpec = collectorPodSpec(resources);
    const mutated = structuredClone(podSpec);
    mutated.volumes.push({ name: 'extra', hostPath: { path: '/var/log' } });
    mutated.containers
      .find((container: any) => container.name === 'logs-collector')
      .volumeMounts.push({ name: 'extra', mountPath: '/var/log', readOnly: true });
    expect(() => assertCollectorPodSecurity(mutated)).toThrow(/two host paths/);
    // The mutation was in memory only: the committed manifest still passes.
    expect(() => assertCollectorPodSecurity(collectorPodSpec(resources))).not.toThrow();
  });

  it('fails when the persistent checkpoint mount is removed', () => {
    const resources = platformObjects();
    const mutated = structuredClone(collectorPodSpec(resources));
    mutated.volumes = mutated.volumes.filter((volume: any) => volume.name !== 'checkpoints');
    mutated.containers.find((container: any) => container.name === 'logs-collector').volumeMounts =
      mutated.containers
        .find((container: any) => container.name === 'logs-collector')
        .volumeMounts.filter((mount: any) => mount.name !== 'checkpoints');
    expect(() => assertCollectorPodSecurity(mutated)).toThrow(/two host paths|checkpoint/);
  });
});

describe('the log platform steps (ADR-016 §1, §5)', () => {
  it('runs both steps after platform-instance with wait: false', () => {
    const steps = [
      ['logs-store-reconciler.yaml', 'platform-logs-store', './logs-store'],
      ['logs-reconciler.yaml', 'platform-logs', './logs'],
    ] as const;
    for (const [file, name, path] of steps) {
      const documents = YAML.parseAllDocuments(readFileSync(join(platformRoot, file), 'utf8')).map(
        (document) => document.toJSON()
      );
      expect(documents).toHaveLength(1);
      const reconciler = documents[0] as Record<string, any>;
      expect(reconciler.kind).toBe('Kustomization');
      expect(reconciler.metadata.name).toBe(name);
      expect(reconciler.spec.path).toBe(path);
      expect(reconciler.spec.prune).toBe(true);
      expect(reconciler.spec.wait).toBe(false);
      expect(reconciler.spec.dependsOn).toEqual([{ name: 'platform-instance' }]);
      expect(reconciler.spec.sourceRef).toEqual({
        kind: 'OCIRepository',
        name: 'platform',
      });
    }
    const root = YAML.parse(readFileSync(join(platformRoot, 'kustomization.yaml'), 'utf8'));
    expect(root.resources).toEqual(
      expect.arrayContaining(['logs-store-reconciler.yaml', 'logs-reconciler.yaml'])
    );
  });

  it('pins both images by digest only', () => {
    const resources = platformObjects();
    const collector = find(resources, 'DaemonSet', 'logs-collector').object;
    expect(collector.spec.template.spec.containers[0].image).toBe(vectorImage);
    const store = find(resources, 'Deployment', 'logs-store').object;
    expect(store.spec.template.spec.containers[0].image).toBe(storeImage);
    for (const image of [vectorImage, storeImage]) {
      expect(image).toMatch(/^[^@]+@sha256:[0-9a-f]{64}$/);
      // A tag must not stand beside the digest: the reference is digest-only.
      expect(image.split('@')[0]).not.toMatch(/:[^/]+$/);
    }
  });

  it('places both vendor image references only in the log step manifests', () => {
    const resources = platformObjects();
    const holders = (needle: string) =>
      resources
        .filter((resource) => JSON.stringify(resource.object).includes(needle))
        .map((resource) => relative(platformRoot, resource.file))
        .sort();
    expect(holders('timberio/vector')).toEqual(['logs/vector.yaml']);
    expect(holders('victoriametrics/victoria-logs')).toEqual(['logs-store/logs-store.yaml']);
  });

  it('declares no retention argument and never enables deletion', () => {
    const resources = platformObjects();
    const store = find(resources, 'Deployment', 'logs-store').object;
    const container = store.spec.template.spec.containers[0];
    const args: string[] = [...(container.command ?? []), ...(container.args ?? [])];
    expect(args).toEqual(expect.arrayContaining(['-envflag.enable', '-envflag.prefix=VL_']));
    for (const argument of args) {
      expect(argument).not.toMatch(/^-retention/);
      expect(argument).not.toBe('-delete.enable');
      expect(argument).not.toMatch(/^-delete\.enable/);
    }
    // The retention values arrive through the defaults ConfigMap and the
    // loader's later ConfigMap, never as a second competing argument.
    expect(container.envFrom).toEqual([
      { configMapRef: { name: 'lifemodel-logs-settings-defaults' } },
      { configMapRef: { name: 'lifemodel-logs-settings', optional: true } },
    ]);
    expect(storeDefaults()).toEqual({
      VL_retentionPeriod: '14d',
      VL_retention_maxDiskSpaceUsageBytes: '1610612736',
      VL_storage_minFreeDiskSpaceBytes: '805306368',
    });
  });

  it('runs the store as 1000:1000 on its own retained local volume', () => {
    const resources = platformObjects();
    const store = find(resources, 'Deployment', 'logs-store').object;
    const pod = store.spec.template.spec;
    expect(store.spec.strategy.type).toBe('Recreate');
    expect(store.spec.replicas).toBe(1);
    expect(pod.securityContext.runAsUser).toBe(1000);
    expect(pod.securityContext.runAsGroup).toBe(1000);
    expect(pod.securityContext.fsGroup).toBe(1000);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.securityContext.seccompProfile?.type).toBe('RuntimeDefault');
    const container = pod.containers[0];
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toContain('ALL');

    const pv = find(resources, 'PersistentVolume', 'lifemodel-logs').object;
    expect(pv.spec.local.path).toBe('/var/lib/lifemodel-logs/data');
    expect(pv.spec.storageClassName).toBe('');
    expect(pv.spec.persistentVolumeReclaimPolicy).toBe('Retain');
    expect(pv.spec.accessModes).toEqual(['ReadWriteOnce']);
    expect(pv.spec.nodeAffinity).toBeDefined();

    const pvc = find(resources, 'PersistentVolumeClaim', 'logs-store').object;
    expect(pvc.metadata.namespace).toBe('lifemodel-system');
    expect(pvc.spec.volumeName).toBe('lifemodel-logs');
    expect(pvc.spec.storageClassName).toBe('');
    expect(pvc.spec.accessModes).toEqual(['ReadWriteOnce']);

    const dataMount = container.volumeMounts.find((mount: any) => mount.name === 'data');
    expect(dataMount.mountPath).toBe('/data');
    expect(pod.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'data',
          persistentVolumeClaim: { claimName: 'logs-store' },
        }),
      ])
    );
    expect(container.args).toEqual(expect.arrayContaining(['-storageDataPath=/data']));
  });
});

describe('the log network policies (ADR-016 §7)', () => {
  it('permits the collector only DNS, TCP 6443 and the store, and no ingress', () => {
    const resources = platformObjects();
    const collector = find(resources, 'NetworkPolicy', 'logs-collector-access').object;
    expect(collector.metadata.namespace).toBe('lifemodel-logs');
    expect(collector.spec.ingress).toEqual([]);
    expect(collector.spec.policyTypes).toEqual(expect.arrayContaining(['Ingress', 'Egress']));
    expect(egressRulePorts(collector)).toEqual([
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
      { protocol: 'TCP', port: 6443 },
      { protocol: 'TCP', port: 9428 },
    ]);
    const peers = egressPeers(collector);
    expect(peers).toEqual(
      expect.arrayContaining([
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
        { ipBlock: { cidr: '0.0.0.0/0' } },
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' } },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'logs-store' } },
        },
      ])
    );
    const defaultDeny = find(resources, 'NetworkPolicy', 'lifemodel-logs-default-deny').object;
    expect(defaultDeny.metadata.namespace).toBe('lifemodel-logs');
    expect(defaultDeny.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    });
  });

  it('admits only the collector and the loader to the store, with no store egress', () => {
    const resources = platformObjects();
    const access = find(resources, 'NetworkPolicy', 'logs-store-access').object;
    expect(access.metadata.namespace).toBe('lifemodel-system');
    expect(access.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-logs' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'logs-collector' } },
          },
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
          },
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'logs-evictor' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 9428 }],
      },
    ]);
    expect(access.spec.egress).toEqual([]);
    const deny = find(resources, 'NetworkPolicy', 'logs-store-deny').object;
    expect(deny.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'logs-store' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    });
    const loader = find(resources, 'NetworkPolicy', 'loader-access').object;
    const storeRoute = (loader.spec.egress ?? []).find((rule: any) =>
      (rule.to ?? []).some(
        (peer: any) => peer.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'logs-store'
      )
    );
    expect(storeRoute?.ports).toEqual([{ protocol: 'TCP', port: 9428 }]);
  });
});

/**
 * The pre-flight that reclaims the retained log volume (ADR-016 §5) needs
 * `get` and `patch` on the one PersistentVolume, by name, and `get` on the
 * store's own claim so it can tell the current claim from a previous one.
 * Anything wider - another verb, another volume, a wildcard, or a claim grant
 * that is not by name - fails here.
 */
function loaderRules(resources: Resource[]): { scope: string; rule: Record<string, any> }[] {
  const isLoader = (subjects: any[] | undefined) =>
    (subjects ?? []).some(
      (subject: any) =>
        subject.kind === 'ServiceAccount' &&
        subject.name === 'loader' &&
        subject.namespace === 'lifemodel-system'
    );
  const referenced = new Map<string, Record<string, any>>();
  for (const { object } of resources) {
    if (object.kind !== 'Role' && object.kind !== 'ClusterRole') continue;
    const namespace = object.kind === 'Role' ? object.metadata.namespace : '';
    referenced.set(`${object.kind}/${namespace}/${object.metadata.name}`, object);
  }
  const rules: { scope: string; rule: Record<string, any> }[] = [];
  for (const { object } of resources) {
    if (object.kind !== 'RoleBinding' && object.kind !== 'ClusterRoleBinding') continue;
    if (!isLoader(object.subjects)) continue;
    const role = referenced.get(
      `${object.roleRef.kind}/${object.kind === 'RoleBinding' ? object.metadata.namespace : ''}/${object.roleRef.name}`
    );
    if (!role) throw new Error(`binding ${object.metadata.name} names an absent role`);
    const scope =
      object.kind === 'ClusterRoleBinding' ? 'cluster' : `namespace ${object.metadata.namespace}`;
    for (const rule of role.rules ?? []) rules.push({ scope, rule });
  }
  return rules;
}

function storageRules(resources: Resource[]): { scope: string; rule: Record<string, any> }[] {
  return loaderRules(resources).filter(({ rule }) =>
    (rule.resources ?? []).some(
      (resource: string) => resource === '*' || resource.startsWith('persistentvolume')
    )
  );
}

function assertLogsVolumeRbac(resources: Resource[]): void {
  const volume = find(resources, 'PersistentVolume', 'lifemodel-logs').object;
  const claim = find(resources, 'PersistentVolumeClaim', 'logs-store').object;
  const expected = [
    {
      scope: 'cluster',
      rule: {
        apiGroups: [''],
        resources: ['persistentvolumes'],
        resourceNames: [volume.metadata.name],
        verbs: ['get', 'patch'],
      },
    },
    {
      scope: `namespace ${claim.metadata.namespace}`,
      rule: {
        apiGroups: [''],
        resources: ['persistentvolumeclaims'],
        resourceNames: [claim.metadata.name],
        verbs: ['get'],
      },
    },
  ];
  const actual = storageRules(resources);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `the loader's log volume grant is wider than get/patch on one volume: ${JSON.stringify(actual)}`
    );
}

describe('the loader grant on the log volume (ADR-016 §5)', () => {
  it('is exactly get and patch on that one volume, and get on its claim', () => {
    const resources = platformObjects();
    expect(() => assertLogsVolumeRbac(resources)).not.toThrow();
    // The names the code uses are the ones the artifact declares.
    const volume = find(resources, 'PersistentVolume', 'lifemodel-logs').object;
    const claim = find(resources, 'PersistentVolumeClaim', 'logs-store').object;
    expect(volume.metadata.name).toBe(LOGS_VOLUME_NAME);
    expect(claim.metadata.name).toBe(LOGS_CLAIM_NAME);
    expect(claim.metadata.namespace).toBe(LOGS_CLAIM_NAMESPACE);
    const volumeRule = storageRules(resources).find(({ rule }) =>
      rule.resources.includes('persistentvolumes')
    );
    expect(volumeRule?.rule).toEqual({
      apiGroups: [''],
      resources: ['persistentvolumes'],
      resourceNames: ['lifemodel-logs'],
      verbs: ['get', 'patch'],
    });
    const binding = find(resources, 'ClusterRoleBinding', 'loader-logs-volume').object;
    expect(binding.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: 'loader-logs-volume',
    });
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'loader', namespace: 'lifemodel-system' },
    ]);
    const a0 = YAML.parse(
      readFileSync(join(platformRoot, 'a0/kustomization.yaml'), 'utf8')
    ) as Record<string, any>;
    expect(a0.resources).toContain('logs-volume-rbac.yaml');
  });

  it('fails when the grant is widened in any way', () => {
    const resources = platformObjects();
    const clone = (): Resource[] => structuredClone(resources) as Resource[];
    const role = (items: Resource[]) => find(items, 'ClusterRole', 'loader-logs-volume').object;
    const widened = (mutate: (rules: any[]) => void): Resource[] => {
      const items = clone();
      mutate(role(items).rules);
      return items;
    };
    const cases: [string, Resource[]][] = [
      ['an extra verb', widened((rules) => rules[0].verbs.push('delete'))],
      ['an extra volume name', widened((rules) => rules[0].resourceNames.push('lifemodel-logs-2'))],
      ['no name restriction', widened((rules) => delete rules[0].resourceNames)],
      ['another resource', widened((rules) => rules[0].resources.push('persistentvolumeclaims'))],
      [
        'a claim grant without a name',
        (() => {
          const items = clone();
          const rules = find(items, 'Role', 'loader-logs-claim').object.rules;
          delete rules[0].resourceNames;
          return items;
        })(),
      ],
      [
        'a claim grant with another verb',
        (() => {
          const items = clone();
          find(items, 'Role', 'loader-logs-claim').object.rules[0].verbs.push('update');
          return items;
        })(),
      ],
      [
        'a cluster-wide claim grant',
        (() => {
          const items = clone();
          find(items, 'ClusterRole', 'loader-logs-volume').object.rules.push({
            apiGroups: [''],
            resources: ['persistentvolumeclaims'],
            verbs: ['get'],
          });
          return items;
        })(),
      ],
    ];
    for (const [reason, items] of cases) {
      expect(() => assertLogsVolumeRbac(items), reason).toThrow(/wider than/);
    }
    // The committed manifests still pass: the mutations were in memory only.
    expect(() => assertLogsVolumeRbac(platformObjects())).not.toThrow();
  });
});

/**
 * The page names the evictor's last successful run (ADR-016 §5, check L14), so
 * the loader may read that one CronJob's status: `get` on `cronjobs` restricted
 * to `logs-evictor` in `lifemodel-system`. Nothing wider - another verb, no
 * name restriction, another resource, another API group, or a cluster-wide
 * grant - fails here.
 */
function batchRules(resources: Resource[]): { scope: string; rule: Record<string, any> }[] {
  return loaderRules(resources).filter(
    ({ rule }) =>
      (rule.apiGroups ?? []).includes('batch') ||
      (rule.resources ?? []).some((resource: string) =>
        ['jobs', 'cronjobs', '*'].includes(resource)
      )
  );
}

function assertLogsEvictorRbac(resources: Resource[]): void {
  const expected = [
    {
      scope: `namespace ${LOGS_EVICTOR_NAMESPACE}`,
      rule: {
        apiGroups: ['batch'],
        resources: ['cronjobs'],
        resourceNames: [LOGS_EVICTOR_NAME],
        verbs: ['get'],
      },
    },
  ];
  const actual = batchRules(resources);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `the loader's evictor grant is wider than get on one CronJob: ${JSON.stringify(actual)}`
    );
}

describe("the loader grant on the evictor's CronJob (ADR-016 §5)", () => {
  it('is exactly get on that one CronJob, and the code reads that path', () => {
    const resources = platformObjects();
    expect(() => assertLogsEvictorRbac(resources)).not.toThrow();
    expect(LOGS_EVICTOR_PATH).toBe(
      `/apis/batch/v1/namespaces/${LOGS_EVICTOR_NAMESPACE}/cronjobs/${LOGS_EVICTOR_NAME}`
    );
    const cronJob = find(resources, 'CronJob', LOGS_EVICTOR_NAME).object;
    expect(cronJob.metadata.namespace).toBe(LOGS_EVICTOR_NAMESPACE);
    const binding = find(resources, 'RoleBinding', 'loader-logs-evictor').object;
    expect(binding.metadata.namespace).toBe(LOGS_EVICTOR_NAMESPACE);
    expect(binding.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: 'loader-logs-evictor',
    });
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'loader', namespace: 'lifemodel-system' },
    ]);
    const a0 = YAML.parse(
      readFileSync(join(platformRoot, 'a0/kustomization.yaml'), 'utf8')
    ) as Record<string, any>;
    expect(a0.resources).toContain('logs-evictor-rbac.yaml');
  });

  it('fails when the grant is widened in any way', () => {
    const resources = platformObjects();
    const clone = (): Resource[] => structuredClone(resources) as Resource[];
    const role = (items: Resource[]) => find(items, 'Role', 'loader-logs-evictor').object;
    const widened = (mutate: (rules: any[]) => void): Resource[] => {
      const items = clone();
      mutate(role(items).rules);
      return items;
    };
    const cases: [string, Resource[]][] = [
      ['an extra verb', widened((rules) => rules[0].verbs.push('list'))],
      ['an extra job name', widened((rules) => rules[0].resourceNames.push('logs-evictor-2'))],
      ['no name restriction', widened((rules) => delete rules[0].resourceNames)],
      ['jobs as well', widened((rules) => rules[0].resources.push('jobs'))],
      ['another API group', widened((rules) => rules[0].apiGroups.push('apps'))],
      [
        'a cluster-wide grant',
        (() => {
          const items = clone();
          find(items, 'ClusterRole', 'loader-logs-volume').object.rules.push({
            apiGroups: ['batch'],
            resources: ['cronjobs'],
            verbs: ['get'],
          });
          return items;
        })(),
      ],
    ];
    for (const [reason, items] of cases) {
      expect(() => assertLogsEvictorRbac(items), reason).toThrow(/wider than/);
    }
    // The committed manifests still pass: the mutations were in memory only.
    expect(() => assertLogsEvictorRbac(platformObjects())).not.toThrow();
  });
});

describe('the collector heartbeat (ADR-016 §4, check L14)', () => {
  it('beats every 30 s and travels the store sink the pod records use', () => {
    const config = collectorConfig();
    expect(config.sources.heartbeat).toEqual({
      type: 'demo_logs',
      format: 'shuffle',
      lines: ['collector heartbeat'],
      interval: 30,
    });
    expect(config.transforms['collector-heartbeat'].inputs).toEqual(['heartbeat']);
    expect(config.sinks['logs-store'].inputs).toEqual(['normalize', 'collector-heartbeat']);
    // The record the store holds names its own module and says which copy it is.
    const program: string = config.transforms['collector-heartbeat'].source;
    for (const field of ['collector-heartbeat', 'heartbeat', 'namespace']) {
      expect(program).toContain(`"${field}"`);
    }
  });

  it('writes a copy to the collector stdout so the file source reads it back', () => {
    const config = collectorConfig();
    // Without this copy the page could not tell a stalled pod-log read from a
    // healthy collector: the store-bound record is written by the process
    // itself and never touches /var/log/pods.
    expect(config.sinks['heartbeat-canary']).toEqual({
      type: 'console',
      target: 'stdout',
      inputs: ['collector-heartbeat'],
      encoding: { codec: 'json' },
    });
    // Only the heartbeat event reaches stdout, so no record can echo itself.
    expect(config.sinks['heartbeat-canary'].inputs).not.toContain('normalize');
    // The read-back line names the heartbeat module only inside the collector's
    // own namespace, so no other pod can forge one.
    const program: string = config.transforms.normalize.source;
    expect(program).toContain('.kubernetes.pod_namespace == "lifemodel-logs"');
    expect(program).toContain('module = "collector-heartbeat"');
  });
});
