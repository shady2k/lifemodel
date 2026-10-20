/**
 * The platform's model gateway (ADR-013 D1, D3, D5, D7, D8).
 *
 * The gateway is a platform-owned Deployment in `lifemodel-system` running the
 * loader image's separate entry point. These checks pin what the manifests say:
 * its own identity and no loader volume or Secret, its two listeners, both
 * sides of the network rules that make it the core's only model egress, and the
 * one pushed loader digest the release flow writes to A0 and step A alike.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const loaderImage = 'ghcr.io/shady2k/lifemodel-loader';

/** Follow local Kustomize resources and Flux reconciler paths, not a source inventory. */
function appliedResources(path: string, seen = new Set<string>()): Set<string> {
  const file = statSync(path).isDirectory() ? join(path, 'kustomization.yaml') : path;
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const doc of documents(file)) {
    if (!doc) continue;
    if (doc.kind === 'Kustomization' && doc.apiVersion.startsWith('kustomize.config.')) {
      for (const resource of doc.resources ?? [])
        appliedResources(resolve(dirname(file), resource), seen);
    } else if (
      doc.kind === 'Kustomization' &&
      doc.apiVersion.startsWith('kustomize.toolkit.') &&
      doc.spec?.path &&
      doc.spec.sourceRef?.kind === 'OCIRepository' &&
      doc.spec.sourceRef?.name === 'platform'
    ) {
      appliedResources(resolve(platformRoot, doc.spec.path), seen);
    }
  }
  return seen;
}

function documents(path: string): Record<string, any>[] {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8')).map(
    (document) => document.toJSON() as Record<string, any>
  );
}

const gateway = documents(join(platformRoot, 'a/model-gateway.yaml'));
const gatewayAccount = documents(join(platformRoot, 'a/model-gateway-service-account.yaml'));
const deployment = gateway.find((item) => item.kind === 'Deployment');
const service = gateway.find((item) => item.kind === 'Service');
const pod = deployment?.spec.template.spec;
const container = pod?.containers?.[0];

const stepANetworkPolicies = documents(join(platformRoot, 'a/network-policy.yaml'));
const openbaoAccess = stepANetworkPolicies.find(
  (item) => item.metadata.name === 'openbao-server-access'
);
const gatewayAccess = stepANetworkPolicies.find(
  (item) => item.metadata.name === 'model-gateway-access'
);
const a0Policies = [
  ...documents(join(platformRoot, 'a0/namespace-default-deny.yaml')),
  ...documents(join(platformRoot, 'a0/network-policy.yaml')),
];
const applications = documents(join(platformRoot, 'a/applications.yaml'));
const byName = (items: Record<string, any>[], name: string): Record<string, any> | undefined =>
  items.find((item) => item.metadata?.name === name);

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
const modelException = {
  to: [
    {
      ipBlock: {
        cidr: '0.0.0.0/0',
        except: ['10.42.0.0/16', '10.43.0.0/16', '169.254.0.0/16'],
      },
    },
  ],
};

describe('the platform model gateway', () => {
  it('applies default deny and every checked policy through the platform resource graph', () => {
    const applied = appliedResources(join(platformRoot, 'kustomization.yaml'));
    for (const file of [
      'a0/namespace-default-deny.yaml',
      'a0/network-policy.yaml',
      'a/network-policy.yaml',
      'a/applications.yaml',
    ])
      expect([...applied].map((path) => relative(platformRoot, path))).toContain(file);
  });

  it.each([
    ['loader', 'lifemodel-system', 8081],
    ['web', 'lifemodel', 8081],
    ['core', 'lifemodel', 8080],
  ])('permits both ends of %s in %s to gateway TCP %s', (source, namespace, port) => {
    const sourcePolicy =
      source === 'loader'
        ? byName(a0Policies, 'loader-access')
        : byName(applications, source === 'web' ? 'web-access' : 'lifemodel-model-egress');
    expect(sourcePolicy?.spec.egress).toContainEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' } },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
        },
      ],
      ports: [{ protocol: 'TCP', port }],
    });
    const ingress = gatewayAccess?.spec.ingress.find((rule: any) =>
      rule.ports.some((p: any) => p.protocol === 'TCP' && p.port === port)
    );
    expect(ingress?.from).toContainEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
      podSelector: { matchLabels: { 'app.kubernetes.io/name': source } },
    });
  });

  it('runs the loader image entry point under its own ServiceAccount', () => {
    expect(deployment?.metadata).toMatchObject({
      name: 'model-gateway',
      namespace: 'lifemodel-system',
    });
    expect(service?.metadata).toMatchObject({
      name: 'model-gateway',
      namespace: 'lifemodel-system',
    });
    expect(pod?.serviceAccountName).toBe('model-gateway');
    expect(pod?.automountServiceAccountToken).toBe(true);
    expect(gatewayAccount).toEqual([
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: 'model-gateway', namespace: 'lifemodel-system' },
        automountServiceAccountToken: true,
      },
    ]);
    // Never the loader's main.js, and never a tag the platform did not pin.
    expect(container?.command).toEqual(['node', '/opt/lifemodel/loader/dist/model-gateway.js']);
    expect(container?.command.join(' ')).not.toContain('main.js');
    expect(container?.image).toBe(`${loaderImage}:release-placeholder`);
    expect(container?.env).toEqual([
      { name: 'LIFEMODEL_OPENBAO_ADDRESS', value: 'http://openbao.openbao.svc:8200' },
    ]);
  });

  it('carries no loader volume, custody Secret or PKI and is read only', () => {
    expect(pod?.volumes).toEqual([
      { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '32Mi' } },
    ]);
    expect(container?.volumeMounts).toEqual([{ name: 'tmp', mountPath: '/tmp' }]);
    expect(container?.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(pod?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container?.resources.requests).toBeDefined();
    expect(container?.resources.limits).toBeDefined();
    // No Kubernetes API use at all: its ServiceAccount is bound to no role.
    expect(gatewayAccount[0]?.metadata?.name).toBe('model-gateway');
    const rbac = [
      ...documents(join(platformRoot, 'a/service-account.yaml')),
      ...documents(join(platformRoot, 'a/auth-delegator.yaml')),
      ...documents(join(platformRoot, 'a/loader-app-rbac.yaml')),
      ...documents(join(platformRoot, 'a/gitea/loader-rbac.yaml')),
    ];
    for (const binding of rbac.filter(
      (item) => item.kind === 'RoleBinding' || item.kind === 'ClusterRoleBinding'
    )) {
      expect(binding.subjects?.some((subject: any) => subject.name === 'model-gateway')).toBe(
        false
      );
    }
  });

  it('serves the API on 8080 and health on 8081, readiness independent of slots', () => {
    expect(container?.ports).toEqual([
      { name: 'api', containerPort: 8080, protocol: 'TCP' },
      { name: 'status', containerPort: 8081, protocol: 'TCP' },
    ]);
    expect(service?.spec.ports).toEqual([
      { name: 'api', port: 8080, targetPort: 'api', protocol: 'TCP' },
      { name: 'status', port: 8081, targetPort: 'status', protocol: 'TCP' },
    ]);
    // /status answers whatever the slots are: a first start with none is ready.
    expect(container?.readinessProbe).toMatchObject({
      httpGet: { path: '/status', port: 'status' },
    });
    expect(container?.livenessProbe).toMatchObject({
      httpGet: { path: '/status', port: 'status' },
    });
    expect(container?.readinessProbe.httpGet.path).not.toBe('/v1/models');
  });

  it('admits 8080 from core pods only and 8081 from web and loader pods', () => {
    expect(gatewayAccess).toMatchObject({
      metadata: { namespace: 'lifemodel-system' },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
        policyTypes: ['Ingress', 'Egress'],
      },
    });
    expect(gatewayAccess?.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'core' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'web' } },
          },
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8081 }],
      },
    ]);
    // Nothing else is admitted anywhere: no 8080 to the web module, no 8081 to
    // the core, and no port admitted by a pod-less default selector.
    const ports = gatewayAccess?.spec.ingress.flatMap((rule: any) => rule.ports ?? []);
    expect(ports).toEqual([
      { protocol: 'TCP', port: 8080 },
      { protocol: 'TCP', port: 8081 },
    ]);
  });

  it('egresses only DNS, OpenBao and the loader model exception', () => {
    expect(gatewayAccess?.spec.egress).toEqual([
      dns,
      {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'openbao' } } }],
        ports: [{ protocol: 'TCP', port: 8200 }],
      },
      modelException,
      {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ollama' } } }],
        ports: [{ protocol: 'TCP', port: 11434 }],
      },
    ]);
    // The loader's own routes are NOT the gateway's (ADR-013 D5).
    const peers = gatewayAccess?.spec.egress.flatMap((rule: any) => rule.to ?? []);
    expect(JSON.stringify(peers)).not.toContain('6443');
    expect(JSON.stringify(peers)).not.toContain('gitea');
  });

  it('keeps the namespace default deny apart from the loader own permits', () => {
    const defaultDeny = byName(a0Policies, 'lifemodel-system-default-deny');
    const loaderAccess = byName(a0Policies, 'loader-access');
    expect(defaultDeny?.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    });
    expect(defaultDeny?.metadata.namespace).toBe('lifemodel-system');
    expect(loaderAccess?.spec.podSelector).toEqual({
      matchLabels: { 'app.kubernetes.io/name': 'loader' },
    });
    // The loader's API-server and Gitea routes stay the loader's alone.
    expect(JSON.stringify(loaderAccess?.spec.egress)).toContain('6443');
    expect(JSON.stringify(loaderAccess?.spec.egress)).toContain('gitea');
    expect(byName(a0Policies, 'loader-default-deny')).toBeUndefined();
  });

  it('lets OpenBao admit the gateway as well as the loader on 8200', () => {
    expect(openbaoAccess?.spec.ingress).toEqual([
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
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
          },
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'storage-module' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8200 }],
      },
    ]);
  });

  it('gives the core no model egress but the gateway 8080', () => {
    const modelEgress = byName(applications, 'lifemodel-model-egress');
    expect(modelEgress).toMatchObject({
      metadata: { namespace: 'lifemodel' },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'core' } },
        policyTypes: ['Egress'],
      },
    });
    expect(modelEgress?.spec.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
    // No internet, no LAN and no in-cluster Ollama for the core's model traffic.
    const peers = JSON.stringify(modelEgress?.spec.egress ?? []);
    expect(peers).not.toContain('0.0.0.0/0');
    expect(peers).not.toContain('ollama');
    const web = byName(applications, 'web-access');
    expect(web?.spec.egress).toContainEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' } },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
        },
      ],
      ports: [{ protocol: 'TCP', port: 8081 }],
    });
  });

  it('seeds the core with the gateway URL and no key', () => {
    const core = documents(join(platformRoot, 'applications/lifemodel/core.yaml'));
    const statefulSet = core.find((item) => item.kind === 'StatefulSet');
    const env = statefulSet?.spec.template.spec.containers[0].env ?? [];
    expect(env).toContainEqual({
      name: 'LIFEMODEL_MODEL_BASE_URL',
      value: 'http://model-gateway.lifemodel-system.svc:8080/v1',
    });
    // The core's settings carry no key and no model credential, and no
    // placeholder key is sent beside the request (ADR-013 D2/D3).
    expect(env.map((entry: any) => entry.name)).not.toContain('LLM_ENDPOINT_BASE_URL');
    expect(
      env.filter((entry: any) => /MODEL_KEY|LLM_KEY|API_KEY|OPENAI|OPENROUTER/i.test(entry.name))
    ).toEqual([]);
    expect(JSON.stringify(core)).not.toMatch(/sk-|no-key-required|apiKey|Authorization/);
    // The only Secret-backed values are the stores' credentials.
    expect(
      env
        .filter((entry: any) => entry.valueFrom !== undefined)
        .map((entry: any) => entry.name)
        .sort()
    ).toEqual(['LIFEMODEL_DB_PASSWORD', 'LIFEMODEL_DB_USERNAME', 'LIFEMODEL_VALKEY_PASSWORD']);
  });

  it('pins step A to the loader digest the release flow pins for A0', () => {
    const kustomization = YAML.parse(
      readFileSync(join(platformRoot, 'a/kustomization.yaml'), 'utf8')
    );
    expect(kustomization.images).toContainEqual({
      name: loaderImage,
      newName: loaderImage,
      digest: `sha256:${'0'.repeat(64)}`,
    });
    // The gateway arrives after OpenBao, which it logs in to.
    expect(kustomization.resources.indexOf('openbao/rendered.yaml')).toBeLessThan(
      kustomization.resources.indexOf('model-gateway.yaml')
    );
    expect(kustomization.resources.indexOf('model-gateway-service-account.yaml')).toBeLessThan(
      kustomization.resources.indexOf('model-gateway.yaml')
    );
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('scripts/release/set-loader-digest.sh');
    const pin = workflow.slice(workflow.indexOf('scripts/release/set-loader-digest.sh'));
    expect(pin).toContain('$LOADER_DIGEST');
    expect(pin).toContain('deploy/platform/a0/kustomization.yaml');
    expect(pin).toContain('deploy/platform/a/kustomization.yaml');
    expect(workflow.indexOf('set-loader-digest.sh')).toBeLessThan(
      workflow.indexOf('flux push artifact')
    );
    expect(workflow.indexOf('id: loader')).toBeLessThan(workflow.indexOf('set-loader-digest.sh'));
  });

  it('writes the same pushed loader digest into A0 and step A in one run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-digest-'));
    try {
      const a0 = join(directory, 'a0.yaml');
      const stepA = join(directory, 'a.yaml');
      writeFileSync(a0, readFileSync(join(platformRoot, 'a0/kustomization.yaml'), 'utf8'));
      writeFileSync(stepA, readFileSync(join(platformRoot, 'a/kustomization.yaml'), 'utf8'));
      const digest = `sha256:${'c'.repeat(64)}`;
      const result = spawnSync(
        'bash',
        [join(repoRoot, 'scripts/release/set-loader-digest.sh'), digest, a0, stepA],
        { encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      for (const file of [a0, stepA])
        expect(readFileSync(file, 'utf8')).toContain(`digest: ${digest}`);
      // The gateway's image name is the loader image the kustomization pins.
      expect(container?.image.startsWith(`${loaderImage}`)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to pin when either file lacks its single placeholder', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-digest-invalid-'));
    try {
      const a0 = join(directory, 'a0.yaml');
      const stepA = join(directory, 'a.yaml');
      writeFileSync(a0, readFileSync(join(platformRoot, 'a0/kustomization.yaml'), 'utf8'));
      writeFileSync(stepA, 'images: []\n');
      const before = readFileSync(a0, 'utf8');
      const result = spawnSync(
        'bash',
        [
          join(repoRoot, 'scripts/release/set-loader-digest.sh'),
          `sha256:${'d'.repeat(64)}`,
          a0,
          stepA,
        ],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('expected exactly one loader digest placeholder');
      // Input validation finished before any rewrite; write failures are not transactional.
      expect(readFileSync(a0, 'utf8')).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
