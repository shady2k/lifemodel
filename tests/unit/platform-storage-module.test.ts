/**
 * SeaweedFS and the storage module in the platform (ADR-015 S-D1, S-D7).
 *
 * These checks pin what the manifests say: the pinned release digest, one
 * `weed mini` StatefulSet on a retained volume with authentication required
 * and the unneeded services off, one Service for the S3 port, the module's own
 * ServiceAccount and entry point, and both sides of every network route that
 * makes the module the only way to the store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { STORAGE_HEALTH_DEFAULTS } from '../../loader/src/storage-health.js';
import {
  S3_IDENTITY_KEY,
  S3_IDENTITY_SECRET,
  STORAGE_BUCKET,
  STORAGE_IDENTITY_NAME,
  renderS3IdentityConfig,
} from '../../loader/src/storage-custody.js';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const seaweedImage =
  'chrislusf/seaweedfs@sha256:aba492e2a4e4c90bff795745e8e660affa1f09e7650f5981bd7bccd1a06cd931';

function documents(path: string): Record<string, any>[] {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8')).map(
    (document) => document.toJSON() as Record<string, any>
  );
}
const seaweed = documents(join(platformRoot, 'a/seaweedfs.yaml'));
const statefulSet = seaweed.find((item) => item.kind === 'StatefulSet');
const seaweedService = seaweed.find((item) => item.kind === 'Service');
const seaweedPod = statefulSet?.spec.template.spec;
const seaweedContainer = seaweedPod?.containers?.[0];
const module = documents(join(platformRoot, 'a/storage-module.yaml'));
const moduleDeployment = module.find((item) => item.kind === 'Deployment');
const moduleService = module.find((item) => item.kind === 'Service');
const modulePod = moduleDeployment?.spec.template.spec;
const moduleContainer = modulePod?.containers?.[0];
const policies = documents(join(platformRoot, 'a/network-policy.yaml'));
const stepAPolicies = documents(join(platformRoot, 'a0/network-policy.yaml'));
const byName = (items: Record<string, any>[], name: string): Record<string, any> | undefined =>
  items.find((item) => item.metadata?.name === name);
const kustomization = YAML.parse(
  readFileSync(join(platformRoot, 'a/kustomization.yaml'), 'utf8')
) as { resources: string[]; images: Record<string, any>[] };

describe('the SeaweedFS StatefulSet', () => {
  it('runs one pinned weed mini pod on a retained volume in lifemodel-system', () => {
    expect(statefulSet?.metadata).toMatchObject({
      name: 'seaweedfs',
      namespace: 'lifemodel-system',
    });
    expect(statefulSet?.spec).toMatchObject({
      replicas: 1,
      serviceName: 'seaweedfs',
      podManagementPolicy: 'OrderedReady',
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
    });
    // One writer, one claim: a rollout never puts two pods on the volume.
    expect(statefulSet?.spec.updateStrategy).toEqual({ type: 'RollingUpdate' });
    expect(statefulSet?.spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: 'data' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'local-path',
          resources: { requests: { storage: '10Gi' } },
        },
      },
    ]);
    expect(seaweedContainer?.image).toBe(seaweedImage);
    expect(seaweedContainer?.image).not.toMatch(/:(latest|4\.48)$/);
    // The image's entrypoint fixes volume ownership as root: the restricted
    // namespace forbids that, so the process is started directly.
    expect(seaweedContainer?.command).toEqual(['/usr/bin/weed']);
    expect(seaweedContainer?.command.join(' ')).not.toContain('entrypoint');
  });

  it('keeps data, filer metadata and configuration under the one claim', () => {
    expect(seaweedContainer?.args).toEqual(
      expect.arrayContaining(['mini', '-dir=/data', '-ip=127.0.0.1', '-ip.bind=0.0.0.0'])
    );
    expect(
      (seaweedContainer?.volumeMounts ?? []).find(
        (mount: Record<string, any>) => mount.name === 'data'
      )
    ).toEqual({ name: 'data', mountPath: '/data' });
    // No emptyDir holds state: the only one is the process's socket directory.
    const volumes = seaweedPod?.volumes ?? [];
    for (const volume of volumes.filter((item: Record<string, any>) => item.emptyDir))
      expect(volume.name).toBe('tmp');
  });

  it('requires S3 authentication and disables every service the platform does not use', () => {
    const args: string[] = seaweedContainer?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        '-s3=true',
        '-s3.port=8333',
        '-s3.config=/etc/seaweedfs/s3.json',
        '-s3.iam=false',
        '-admin.ui=false',
        '-webdav=false',
        '-s3.port.iceberg=0',
        '-s3.port.lance=0',
        '-master.telemetry=false',
        `-bucket=${STORAGE_BUCKET}`,
      ])
    );
    // No anonymous mode: no flag turns authentication off, and none is missing
    // the identity file it must read.
    expect(args.join(' ')).not.toMatch(/-s3=false|anonymous|--s3\.iam=true/);
    // Every listener it keeps is named, so a default change cannot move it.
    for (const flag of ['-master.port=', '-volume.port=', '-filer.port=', '-s3.port='])
      expect(args.some((arg) => arg.startsWith(flag))).toBe(true);
  });

  it('mounts the S3 identity file, and only this pod does', () => {
    const mount = (seaweedContainer?.volumeMounts ?? []).find(
      (item: Record<string, any>) => item.name === 's3-identity'
    );
    expect(mount).toEqual({
      name: 's3-identity',
      mountPath: '/etc/seaweedfs/s3.json',
      subPath: S3_IDENTITY_KEY,
      readOnly: true,
    });
    expect(
      (seaweedPod?.volumes ?? []).find((item: Record<string, any>) => item.name === 's3-identity')
    ).toEqual({
      name: 's3-identity',
      secret: { secretName: S3_IDENTITY_SECRET, defaultMode: 256 },
    });
    expect(JSON.stringify(moduleDeployment)).not.toContain(S3_IDENTITY_SECRET);
    expect(JSON.stringify(stepAPolicies)).not.toContain('s3.json');
  });

  it('is restricted and mounts no ServiceAccount token', () => {
    expect(seaweedPod?.automountServiceAccountToken).toBe(false);
    expect(seaweedPod?.serviceAccountName).toBeUndefined();
    expect(seaweedPod?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(seaweedContainer?.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(seaweedContainer?.resources.requests).toBeDefined();
    expect(seaweedContainer?.resources.limits).toBeDefined();
  });

  it('exposes the S3 port and nothing else', () => {
    expect(seaweedService?.metadata).toMatchObject({
      name: 'seaweedfs',
      namespace: 'lifemodel-system',
    });
    expect(seaweedService?.spec.ports).toEqual([
      { name: 's3', port: 8333, targetPort: 's3', protocol: 'TCP' },
    ]);
    expect(seaweedContainer?.ports).toEqual([{ name: 's3', containerPort: 8333, protocol: 'TCP' }]);
    expect(seaweedContainer?.readinessProbe).toEqual({
      tcpSocket: { port: 's3' },
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: 3,
    });
    expect(seaweedContainer?.livenessProbe.tcpSocket).toEqual({ port: 's3' });
  });

  it('creates the identity Secret as a pruned-protected placeholder only once', () => {
    const secret = documents(join(platformRoot, 'a/seaweedfs-s3-identity.yaml'));
    expect(secret).toEqual([
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: S3_IDENTITY_SECRET,
          namespace: 'lifemodel-system',
          annotations: {
            'kustomize.toolkit.fluxcd.io/ssa': 'IfNotPresent',
            'kustomize.toolkit.fluxcd.io/prune': 'disabled',
          },
        },
        type: 'Opaque',
        data: { [S3_IDENTITY_KEY]: '' },
      },
    ]);
  });

  it('lets the loader write that Secret and no other in the namespace', () => {
    const rbac = documents(join(platformRoot, 'a/seaweedfs-rbac.yaml'));
    const role = rbac.find((item) => item.kind === 'Role');
    expect(role?.metadata).toMatchObject({
      name: 'loader-seaweed-identity',
      namespace: 'lifemodel-system',
    });
    expect(role?.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['secrets'],
        resourceNames: [S3_IDENTITY_SECRET],
        verbs: ['get', 'update'],
      },
    ]);
    const binding = rbac.find((item) => item.kind === 'RoleBinding');
    expect(binding?.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'loader', namespace: 'lifemodel-system' },
    ]);
    expect(binding?.roleRef).toMatchObject({ kind: 'Role', name: 'loader-seaweed-identity' });
  });
});

describe('the storage module workload', () => {
  it('runs the loader image entry point under its own ServiceAccount', () => {
    expect(moduleDeployment?.metadata).toMatchObject({
      name: 'storage-module',
      namespace: 'lifemodel-system',
    });
    expect(modulePod?.serviceAccountName).toBe('storage-module');
    expect(modulePod?.automountServiceAccountToken).toBe(true);
    expect(documents(join(platformRoot, 'a/storage-module-service-account.yaml'))).toEqual([
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: 'storage-module', namespace: 'lifemodel-system' },
        automountServiceAccountToken: true,
      },
    ]);
    // Never the loader's main.js, never the gateway's entry point.
    expect(moduleContainer?.command).toEqual([
      'node',
      '/opt/lifemodel/loader/dist/storage-module.js',
    ]);
    expect(moduleContainer?.image).toBe('ghcr.io/shady2k/lifemodel-loader:release-placeholder');
    expect(moduleContainer?.env).toEqual([
      { name: 'LIFEMODEL_OPENBAO_ADDRESS', value: 'http://openbao.openbao.svc:8200' },
      {
        name: 'LIFEMODEL_STORAGE_S3_ENDPOINT',
        value: 'http://seaweedfs.lifemodel-system.svc:8333',
      },
      { name: 'LIFEMODEL_STORAGE_BUCKET', value: STORAGE_BUCKET },
    ]);
    // No loader volume, no custody Secret, no key of any kind.
    expect(modulePod?.volumes).toEqual([
      { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '32Mi' } },
    ]);
    expect(JSON.stringify(moduleDeployment)).not.toMatch(/secretKeyRef|accessKey/);
  });

  it('is restricted, read only and bounded', () => {
    expect(modulePod?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(moduleContainer?.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(moduleContainer?.resources).toEqual({
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '500m', memory: '256Mi' },
    });
  });

  it('keeps the probe timeout above the module health deadline', () => {
    // A probe that timed out at the module's own deadline would cut a valid
    // answer; the margin is the difference.
    expect(moduleContainer?.readinessProbe.timeoutSeconds).toBe(5);
    expect(moduleContainer!.readinessProbe.timeoutSeconds * 1000).toBeGreaterThan(
      STORAGE_HEALTH_DEFAULTS.boundMs
    );
  });

  it('takes readiness from the store and liveness from the process', () => {
    expect(moduleContainer?.readinessProbe).toMatchObject({
      httpGet: { path: '/status', port: 'status' },
    });
    expect(moduleContainer?.livenessProbe).toMatchObject({
      httpGet: { path: '/livez', port: 'status' },
    });
    // A stopped store must never restart the process that reports it.
    expect(moduleContainer?.livenessProbe.httpGet.path).not.toBe('/status');
    expect(moduleService?.spec.ports).toEqual([
      { name: 'status', port: 8081, targetPort: 'status', protocol: 'TCP' },
    ]);
    expect(moduleContainer?.ports).toEqual([
      { name: 'status', containerPort: 8081, protocol: 'TCP' },
    ]);
  });
});

describe('the storage network routes', () => {
  const dns = {
    to: [
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };

  it('admits the storage module to SeaweedFS 8333 and nothing else', () => {
    expect(byName(policies, 'seaweedfs-access')).toEqual({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'seaweedfs-access', namespace: 'lifemodel-system' },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'seaweedfs' } },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
                },
                podSelector: { matchLabels: { 'app.kubernetes.io/name': 'storage-module' } },
              },
            ],
            ports: [{ protocol: 'TCP', port: 8333 }],
          },
        ],
        egress: [dns],
      },
    });
  });

  it('lets the module reach DNS, OpenBao and SeaweedFS, and nothing else', () => {
    const access = byName(policies, 'storage-module-access');
    expect(access?.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'storage-module' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 8081 }],
        },
      ],
      egress: [
        dns,
        {
          to: [
            { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'openbao' } } },
          ],
          ports: [{ protocol: 'TCP', port: 8200 }],
        },
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'seaweedfs' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 8333 }],
        },
      ],
    });
    const peers = JSON.stringify(access?.spec.egress ?? []);
    // No Internet, no model route, no store port but the one bucket's S3.
    expect(peers).not.toContain('0.0.0.0/0');
    expect(peers).not.toContain('9333');
    expect(peers).not.toContain('9340');
    expect(peers).not.toContain('8888');
    expect(peers).not.toContain('6443');
  });

  it('admits the module to OpenBao beside the loader and the gateway', () => {
    const openbao = byName(policies, 'openbao-server-access');
    const from = openbao?.spec.ingress[0].from ?? [];
    expect(from.map((peer: Record<string, any>) => peer.podSelector.matchLabels)).toEqual([
      { 'app.kubernetes.io/name': 'loader' },
      { 'app.kubernetes.io/name': 'model-gateway' },
      { 'app.kubernetes.io/name': 'storage-module' },
    ]);
  });

  it('gives the loader the health route on both sides', () => {
    const egress = (byName(stepAPolicies, 'loader-access')?.spec.egress ?? []).find(
      (rule: Record<string, any>) =>
        (rule.to ?? []).some(
          (peer: Record<string, any>) =>
            peer.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'storage-module'
        )
    );
    expect(egress).toEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' } },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'storage-module' } },
        },
      ],
      ports: [{ protocol: 'TCP', port: 8081 }],
    });
    const ingress = (byName(policies, 'storage-module-access')?.spec.ingress ?? []).flatMap(
      (rule: Record<string, any>) => rule.from ?? []
    );
    expect(ingress).toContainEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' } },
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
    });
  });
});

describe('the platform release', () => {
  it('applies every new resource through the platform kustomization', () => {
    for (const file of [
      'seaweedfs-s3-identity.yaml',
      'seaweedfs-rbac.yaml',
      'seaweedfs.yaml',
      'storage-module-service-account.yaml',
      'storage-module.yaml',
    ])
      expect(kustomization.resources).toContain(file);
    // The identity Secret and its RBAC arrive before the pod that mounts it.
    expect(kustomization.resources.indexOf('seaweedfs-s3-identity.yaml')).toBeLessThan(
      kustomization.resources.indexOf('seaweedfs.yaml')
    );
    expect(kustomization.resources.indexOf('openbao/rendered.yaml')).toBeLessThan(
      kustomization.resources.indexOf('storage-module.yaml')
    );
  });

  it('pins the module to the loader image the release flow pins for A0', () => {
    expect(kustomization.images).toContainEqual({
      name: 'ghcr.io/shady2k/lifemodel-loader',
      newName: 'ghcr.io/shady2k/lifemodel-loader',
      digest: `sha256:${'0'.repeat(64)}`,
    });
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('deploy/platform/a/kustomization.yaml');
  });

  it('ships the module entry point in the loader image', () => {
    const dockerfile = readFileSync(join(repoRoot, 'docker/loader/Dockerfile'), 'utf8');
    // The build stage compiles the whole loader program and the runtime keeps
    // all of dist/, so the entry point ships without a second image.
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain('COPY --from=build --chown=root:root /build');
  });

  it('scopes the projected identity file to the one bucket', () => {
    const config = JSON.parse(
      renderS3IdentityConfig({ accessKey: 'A1B2C3D4E5F60718293A', secretKey: 'x'.repeat(40) })
    );
    expect(config.identities[0].name).toBe(STORAGE_IDENTITY_NAME);
    expect(config.identities[0].actions).toEqual([
      `Read:${STORAGE_BUCKET}`,
      `Write:${STORAGE_BUCKET}`,
      `List:${STORAGE_BUCKET}`,
    ]);
    // The bucket the module is configured with is the bucket its actions name.
    const bucketEnv = (moduleContainer?.env ?? []).find(
      (entry: Record<string, any>) => entry.name === 'LIFEMODEL_STORAGE_BUCKET'
    );
    expect(bucketEnv?.value).toBe(STORAGE_BUCKET);
    expect((seaweedContainer?.args ?? []).join(' ')).toContain(`-bucket=${STORAGE_BUCKET}`);
  });
});
