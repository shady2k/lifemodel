/**
 * The log evictor in the platform (ADR-016 §5, §7; check L16).
 *
 * These checks pin what the manifests say: the CronJob's schedule, its
 * concurrency and deadlines, its history limits, the restricted security
 * context with no API token, its entry point on the loader image pinned by the
 * same release digest as the loader, the log volume mounted read-write, the
 * partition key as a `secretKeyRef` on the job and as a file on the store, the
 * store's one added route, and the evictor's own two destinations.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const stepRoot = join(platformRoot, 'logs-store');
const loaderImage = 'ghcr.io/shady2k/lifemodel-loader';
const KEY_SECRET = 'lifemodel-logs-partition-key';
const KEY_FILE_PATH = '/etc/vl/partition-key';

function documents(path: string): Record<string, any>[] {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8'))
    .map((document) => document.toJSON() as Record<string, any> | null)
    .filter(
      (document): document is Record<string, any> =>
        typeof document === 'object' && document !== null
    );
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'charts' ? [] : yamlFiles(path);
    return entry.name.endsWith('.yaml') ? [path] : [];
  });
}

const kustomization = YAML.parse(readFileSync(join(stepRoot, 'kustomization.yaml'), 'utf8')) as {
  resources: string[];
  images: Record<string, any>[];
};
const step = documents(join(stepRoot, 'evictor.yaml'));
const cronJob = step.find((item) => item.kind === 'CronJob');
const jobPod = cronJob?.spec.jobTemplate.spec.template.spec;
const jobContainer = jobPod?.containers?.[0];
const storeStep = documents(join(stepRoot, 'logs-store.yaml'));
const store = storeStep.find((item) => item.kind === 'Deployment');
const storePod = store?.spec.template.spec;
const storeContainer = storePod?.containers?.[0];
const policies = documents(join(stepRoot, 'network-policy.yaml'));
const byName = (items: Record<string, any>[], kind: string, name: string) =>
  items.find((item) => item.kind === kind && item.metadata?.name === name);

describe('the logs-evictor CronJob (ADR-016 §5)', () => {
  it('ships in the log store step with the schedule and limits the ADR fixes', () => {
    expect(kustomization.resources).toEqual(
      expect.arrayContaining(['evictor.yaml', 'partition-key.yaml'])
    );
    expect(cronJob?.metadata).toMatchObject({
      name: 'logs-evictor',
      namespace: 'lifemodel-system',
    });
    expect(cronJob?.spec).toMatchObject({
      schedule: '* * * * *',
      concurrencyPolicy: 'Forbid',
      startingDeadlineSeconds: 55,
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 1,
    });
    expect(cronJob?.spec.jobTemplate.spec).toMatchObject({
      activeDeadlineSeconds: 60,
      backoffLimit: 0,
      template: { spec: { restartPolicy: 'Never' } },
    });
  });

  it("runs the loader image's own entry point, pinned by the loader digest", () => {
    expect(jobContainer?.image).toBe(`${loaderImage}:release-placeholder`);
    expect(jobContainer?.command).toEqual(['node', '/opt/lifemodel/loader/dist/log-evictor.js']);
    expect(kustomization.images).toEqual([
      {
        name: loaderImage,
        newName: loaderImage,
        digest: `sha256:${'0'.repeat(64)}`,
      },
    ]);
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    // The pin step runs between the pushed loader digest and the artifact push.
    const pin = workflow.slice(
      workflow.indexOf('scripts/release/set-loader-digest.sh'),
      workflow.indexOf('Install Flux CLI')
    );
    expect(pin).toContain('deploy/platform/logs-store/kustomization.yaml');
  });

  it('runs as 1000:1000 under the restricted level and mounts no API token', () => {
    expect(cronJob?.spec.jobTemplate.spec.template.metadata.labels).toMatchObject({
      'app.kubernetes.io/name': 'logs-evictor',
    });
    expect(jobPod?.automountServiceAccountToken).toBe(false);
    expect(jobPod?.serviceAccountName).toBeUndefined();
    expect(jobPod?.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(jobContainer?.securityContext).toEqual({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(jobContainer?.resources).toEqual({
      requests: { cpu: '20m', memory: '32Mi' },
    });
    expect(jobContainer?.volumeMounts).toEqual([{ name: 'data', mountPath: '/data' }]);
    expect(jobPod?.volumes).toEqual([
      { name: 'data', persistentVolumeClaim: { claimName: 'logs-store' } },
    ]);
  });

  it('reads the partition key as a secretKeyRef and carries no value', () => {
    expect(jobContainer?.env).toEqual([
      {
        name: 'LIFEMODEL_LOGS_STORE_URL',
        value: 'http://logs-store.lifemodel-system.svc:9428',
      },
      { name: 'LIFEMODEL_LOGS_VOLUME_PATH', value: '/data' },
      {
        name: 'LIFEMODEL_LOGS_PARTITION_KEY',
        valueFrom: { secretKeyRef: { name: KEY_SECRET, key: 'partition-key' } },
      },
    ]);
  });
});

describe('the store side of the partition key (ADR-016 §5)', () => {
  it('reads the key from the one file path ADR-016 names', () => {
    const args: string[] = [...(storeContainer?.command ?? []), ...(storeContainer?.args ?? [])];
    expect(args).toEqual(
      expect.arrayContaining([`-partitionManageAuthKey=file://${KEY_FILE_PATH}`])
    );
    expect(storeContainer?.volumeMounts).toEqual(
      expect.arrayContaining([{ name: 'partition-key', mountPath: '/etc/vl', readOnly: true }])
    );
    expect(storePod?.volumes).toEqual(
      expect.arrayContaining([{ name: 'partition-key', secret: { secretName: KEY_SECRET } }])
    );
  });

  it('declares the Secret empty and never lets a reconcile revert it', () => {
    const secrets = documents(join(stepRoot, 'partition-key.yaml'));
    expect(secrets).toHaveLength(1);
    const secret = secrets[0]!;
    expect(secret).toMatchObject({
      kind: 'Secret',
      metadata: {
        name: KEY_SECRET,
        namespace: 'lifemodel-system',
        annotations: {
          'kustomize.toolkit.fluxcd.io/ssa': 'IfNotPresent',
          'kustomize.toolkit.fluxcd.io/prune': 'disabled',
        },
      },
      data: { 'partition-key': '' },
    });
  });

  it('names the Secret only where it is read or granted, and no manifest holds a key', () => {
    const holders = yamlFiles(platformRoot)
      .filter((file) => readFileSync(file, 'utf8').includes(KEY_SECRET))
      .map((file) => relative(platformRoot, file))
      .sort();
    // The two consumers, the object itself, and the loader's by-name right to
    // fill the value once (ADR-016 §5): no other workload mounts or names it.
    expect(holders).toEqual([
      'a/loader-settings-rbac.yaml',
      'logs-store/evictor.yaml',
      'logs-store/logs-store.yaml',
      'logs-store/partition-key.yaml',
    ]);
    // Every Secret of that name in the artifact is empty: the key itself is
    // never in a manifest.
    for (const file of yamlFiles(platformRoot)) {
      for (const document of documents(file)) {
        if (document.kind !== 'Secret' || document.metadata?.name !== KEY_SECRET) continue;
        for (const value of Object.values(document.data ?? {})) expect(value).toBe('');
      }
    }
  });
});

describe("the evictor's network policy and the store route (ADR-016 §7)", () => {
  it('permits it the store and cluster DNS, and nothing reaches it', () => {
    const policy = byName(policies, 'NetworkPolicy', 'logs-evictor-access');
    expect(policy?.metadata?.namespace).toBe('lifemodel-system');
    expect(policy?.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'logs-evictor' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
              },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'logs-store' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 9428 }],
        },
      ],
    });
  });

  it("admits the evictor's job pods to the store, and the store to nothing", () => {
    const access = byName(policies, 'NetworkPolicy', 'logs-store-access');
    expect(access?.spec.ingress).toHaveLength(1);
    const from = access?.spec.ingress[0].from ?? [];
    expect(from).toEqual(
      expect.arrayContaining([
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
          },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'logs-evictor' } },
        },
      ])
    );
    expect(access?.spec.egress).toEqual([]);
    // The evictor's own policy is the only one that selects its pods.
    const selecting = [policies, documents(join(stepRoot, 'logs-store.yaml'))]
      .flat()
      .filter(
        (item) =>
          item.kind === 'NetworkPolicy' &&
          item.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'logs-evictor'
      );
    expect(selecting).toHaveLength(1);
  });
});
