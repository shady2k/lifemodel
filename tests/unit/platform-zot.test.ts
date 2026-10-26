/** The platform registry and the node-side mirror are one fixed authority. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const authority = 'zot.lifemodel-system.svc:5001';
const endpoint = 'http://10.43.0.51:5001';
const image =
  'ghcr.io/project-zot/zot@sha256:96cda11459ce6f8c60da3b03f03e9f67fd11b3ae2d82c4c04c92b3c608996080';
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const docs = (path: string): Record<string, any>[] =>
  YAML.parseAllDocuments(read(path)).map((doc) => doc.toJSON());
const step = YAML.parse(read('deploy/platform/a/kustomization.yaml'));
const resources = docs('deploy/platform/a/zot.yaml');
const statefulSet = resources.find((doc) => doc.kind === 'StatefulSet');
const service = resources.find((doc) => doc.kind === 'Service');
// zot's configuration is a file, hashed into the ConfigMap's name by the
// generator in the step's kustomization (see the roll test below).
const config = JSON.parse(read('deploy/platform/a/zot/config.json'));
const configGenerator = (step.configMapGenerator ?? []).find(
  (generator: any) => generator.name === 'zot-config'
);
const pod = statefulSet?.spec.template.spec;
const container = pod?.containers[0];

describe('the platform zot registry', () => {
  it('arrives in step A with one retained node-local volume and a release digest', () => {
    expect(step.resources).toEqual(expect.arrayContaining(['zot.yaml', 'zot-network-policy.yaml']));
    expect(statefulSet?.metadata).toMatchObject({ name: 'zot', namespace: 'lifemodel-system' });
    expect(statefulSet?.spec).toMatchObject({
      replicas: 1,
      serviceName: 'zot',
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
    });
    expect(statefulSet?.spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: 'data' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'local-path',
          resources: { requests: { storage: '20Gi' } },
        },
      },
    ]);
    expect(container?.image).toBe(image);
    // The GHCR release uses an architecture-specific stacker entrypoint.
    expect(container?.command).toBeUndefined();
    expect(container?.args).toEqual(['serve', '/etc/zot/config.json']);
  });

  it('reclaims stale uploads without deleting digest-only roots or their referenced graph', () => {
    expect(config.storage).toEqual({
      rootDirectory: '/var/lib/registry',
      gc: true,
      gcDelay: '2h',
      gcInterval: '1h',
      dedupe: true,
      retention: {
        policies: [
          {
            repositories: ['lifemodel/workbench'],
            deleteUntagged: false,
            deleteReferrers: false,
          },
        ],
      },
    });
  });

  it('serves the same canonical authority to pods and a stable ClusterIP to the node', () => {
    expect(service?.metadata).toMatchObject({ name: 'zot', namespace: 'lifemodel-system' });
    expect(service?.spec).toMatchObject({ type: 'ClusterIP', clusterIP: '10.43.0.51' });
    expect(service?.spec.ports).toEqual([
      { name: 'registry', port: 5001, targetPort: 'registry', protocol: 'TCP' },
    ]);
    expect(container?.ports).toEqual([{ name: 'registry', containerPort: 5001, protocol: 'TCP' }]);
    expect(pod?.hostNetwork).toBeUndefined();
    expect(container?.ports.some((port: any) => port.hostPort !== undefined)).toBe(false);
    expect(config.http).toMatchObject({ address: '0.0.0.0', port: '5001' });
    expect(container?.readinessProbe.httpGet).toEqual({ path: '/v2/', port: 'registry' });
  });

  it('accepts Docker schema 2 manifests alongside OCI for configurable workbench sources', () => {
    expect(config.http.compat).toEqual(['docker2s2']);
  });

  it('permits anonymous reads only, and only the loader identity may push the workbench', () => {
    expect(config.http.auth).toEqual({ htpasswd: { path: '/etc/zot/auth/htpasswd' } });
    // Exact equality detects the required mutation: an anonymous create/update permission.
    expect(config.http.accessControl).toEqual({
      repositories: {
        'lifemodel/workbench': {
          anonymousPolicy: ['read'],
          policies: [{ users: ['loader'], actions: ['read', 'create', 'update'] }],
        },
      },
    });
    expect(config.extensions).toBeUndefined();
    expect(config.log).toEqual({ level: 'warn' });
  });

  it('replaces zot-0 when its configuration changes, instead of leaving the old one', () => {
    // The mechanism is kustomize's content hash. The generator names the
    // ConfigMap from a hash of zot/config.json, kustomize rewrites the pod
    // template's reference to that name, and the changed template replaces the
    // pod on the next reconcile; the fixed name this replaced left a running
    // zot on its startup configuration, which its reload cannot update for
    // http.compat and the other startup fields. Flux prunes the old name
    // (platform-a sets prune: true).
    expect(configGenerator).toEqual({
      name: 'zot-config',
      namespace: 'lifemodel-system',
      files: ['config.json=zot/config.json'],
    });
    // Turning the hash off would keep the name, and the pod, unchanged.
    expect(step.generatorOptions?.disableNameSuffixHash).not.toBe(true);
    // One configuration object only: a fixed-name ConfigMap beside the
    // generated one could be the object a pod mounts while the hash moves.
    expect(resources.filter((doc) => doc.kind === 'ConfigMap')).toEqual([]);
    // zot reads this name; the hash suffix makes it change with the content.
    expect(pod?.volumes).toContainEqual({ name: 'config', configMap: { name: 'zot-config' } });
    expect(container?.volumeMounts).toContainEqual({
      name: 'config',
      mountPath: '/etc/zot',
      readOnly: true,
    });
    expect(container?.args).toEqual(['serve', '/etc/zot/config.json']);
  });

  it('re-reads the htpasswd Secret live, so an identity rotation needs no replace', () => {
    // v2.1.22 runs HTPasswdWatcher (pkg/api/htpasswd.go) on the configured
    // path. The mount is the htpasswd file's own directory and has no
    // subPath, which is what lets the projected Secret swap under the watched
    // path; a subPath mount would freeze the file it loaded at start.
    const authPath: string = config.http.auth.htpasswd.path;
    // The most specific mount that contains it: /etc/zot/auth, not /etc/zot.
    const mount = [...(container?.volumeMounts ?? [])]
      .filter((candidate: any) => authPath.startsWith(`${candidate.mountPath}/`))
      .sort((a: any, b: any) => b.mountPath.length - a.mountPath.length)[0];
    expect(mount).toEqual({ name: 'htpasswd', mountPath: '/etc/zot/auth', readOnly: true });
    expect(mount?.subPath).toBeUndefined();
  });

  it('mounts the live Secret directory read-only and gives zot no API identity', () => {
    expect(pod?.automountServiceAccountToken).toBe(false);
    expect(pod?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000,
    });
    expect(container?.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(container?.volumeMounts).toContainEqual({
      name: 'htpasswd',
      mountPath: '/etc/zot/auth',
      readOnly: true,
    });
    expect(pod?.volumes).toContainEqual({
      name: 'htpasswd',
      secret: {
        secretName: 'zot-htpasswd',
        defaultMode: 288,
        items: [{ key: 'htpasswd', path: 'htpasswd' }],
      },
    });
    expect(container?.volumeMounts.some((mount: any) => mount.subPath !== undefined)).toBe(false);
    expect(container?.resources.requests).toBeDefined();
    expect(container?.resources.limits).toBeDefined();
  });

  it('allows only loader and core readiness ingress, with no egress or broad IP exception', () => {
    const deny = docs('deploy/platform/a0/namespace-default-deny.yaml').find(
      (doc) => doc.metadata.name === 'lifemodel-system-default-deny'
    );
    expect(deny?.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    });
    const policies = docs('deploy/platform/a/zot-network-policy.yaml');
    expect(policies).toHaveLength(1);
    expect(policies[0]?.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'zot' } },
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
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'core' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 5001 }],
        },
      ],
      egress: [],
    });
    const egress = docs('deploy/platform/a/applications.yaml').find(
      (doc) => doc.kind === 'NetworkPolicy' && doc.metadata.name === 'lifemodel-workbench-egress'
    );
    expect(egress?.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'core' } },
      policyTypes: ['Egress'],
      ingress: [],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'zot' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 5001 }],
        },
      ],
    });
    expect(JSON.stringify(policies)).not.toContain('ipBlock');
    // Node-origin containerd pulls use Kubernetes' implicit same-node ingress exemption.
    expect(read('deploy/platform/a/zot-network-policy.yaml')).toContain('node');
  });
});

describe('the loader import network boundary', () => {
  it('uses existing loader egress without a temporary policy or policy-write permission', () => {
    const a0 = YAML.parse(read('deploy/platform/a0/kustomization.yaml'));
    expect(a0.resources).not.toContain('workbench-import-egress.yaml');
    const role = docs('deploy/platform/a0/service-account.yaml').find(
      (doc) => doc.kind === 'Role' && doc.metadata.name === 'loader-bootstrap'
    );
    expect(role?.rules.some((rule: any) => rule.resources.includes('networkpolicies'))).toBe(false);
  });
});

describe('the installer registry mirror', () => {
  it('renders HTTP trust without credentials, a fixed service CIDR and no upstream fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-zot-render-'));
    try {
      const result = spawnSync(
        'sh',
        [
          join(root, 'scripts/install.sh'),
          '--platform-url',
          'oci://example.test/platform',
          '--tag',
          'v1.0.0',
          '--lan-interface',
          'eth0',
          '--render-only',
          dir,
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, LIFEMODEL_INSTANCE_ENV: join(dir, 'absent.env') },
        }
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(YAML.parse(readFileSync(join(dir, 'k3s/registries.yaml'), 'utf8'))).toEqual({
        mirrors: { [authority]: { endpoint: [endpoint] } },
      });
      expect(
        YAML.parse(readFileSync(join(dir, 'k3s/config.yaml.d/lifemodel-registry.yaml'), 'utf8'))
      ).toEqual({ 'disable-default-registry-endpoint': true, 'service-cidr': '10.43.0.0/16' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
