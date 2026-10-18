import { describe, expect, it } from 'vitest';
import { createKubernetesBaoCustody } from '../../loader/src/openbao.js';
import {
  createKubernetesPhaseStore,
  createPlatformPhaseRunner,
  type PlatformPhaseRecord,
  type PlatformPhaseStore,
} from '../../loader/src/platform-bootstrap.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { join } from 'node:path';

describe('platform bootstrap phases', () => {
  it('writes and reads back each phase before and after its side effect, then resumes without repeating completed work', async () => {
    const events: string[] = [];
    let record: { phase: string; status: 'running' | 'complete' } | null = null;
    const store: PlatformPhaseStore = {
      read: async () => {
        events.push('read');
        return record;
      },
      write: async (next) => {
        events.push(`write:${next.phase}:${next.status}`);
        record = next;
      },
    };
    const run = createPlatformPhaseRunner(store);
    const effects: string[] = [];
    await run([
      {
        name: 'custody',
        run: async () => {
          events.push('effect:custody');
          effects.push('custody');
        },
      },
      {
        name: 'unseal',
        run: async () => {
          events.push('effect:unseal');
          effects.push('unseal');
        },
      },
    ]);
    expect(events).toEqual([
      'read',
      'write:custody:running',
      'read',
      'effect:custody',
      'write:custody:complete',
      'read',
      'read',
      'write:unseal:running',
      'read',
      'effect:unseal',
      'write:unseal:complete',
      'read',
    ]);
    events.length = 0;
    await run([
      {
        name: 'custody',
        run: async () => {
          effects.push('custody');
        },
      },
      {
        name: 'unseal',
        run: async () => {
          effects.push('unseal');
        },
      },
      {
        name: 'gitea',
        run: async () => {
          effects.push('gitea');
        },
      },
    ]);
    expect(effects).toEqual(['custody', 'unseal', 'gitea']);
    expect(record).toEqual({ phase: 'gitea', status: 'complete' });
  });

  it('resumes a running phase after a crash without repeating earlier completed effects', async () => {
    let record: { phase: string; status: 'running' | 'complete' } | null = null;
    const effects: string[] = [];
    const store: PlatformPhaseStore = {
      read: async () => record,
      write: async (next) => {
        record = next;
      },
    };
    const run = createPlatformPhaseRunner(store);
    const custody = {
      name: 'custody',
      run: async () => {
        effects.push('custody');
      },
    };
    await run([custody]);
    const unstable = {
      name: 'unseal',
      run: async () => {
        effects.push('unseal');
        throw new Error('crash');
      },
    };
    await expect(run([custody, unstable])).rejects.toThrow('crash');
    await run([
      custody,
      {
        name: 'unseal',
        run: async () => {
          effects.push('unseal');
        },
      },
    ]);
    expect(effects).toEqual(['custody', 'unseal', 'unseal']);
    expect(record).toEqual({ phase: 'unseal', status: 'complete' });
  });

  it('stores phase records in only the named in-cluster Secret and verifies API read-back', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    let secret: Record<string, unknown> | null = {
      metadata: {
        name: 'loader-bootstrap-state',
        namespace: 'lifemodel-system',
        resourceVersion: '1',
        labels: { 'kustomize.toolkit.fluxcd.io/name': 'platform-a0', keep: 'yes' },
        annotations: {
          'kustomize.toolkit.fluxcd.io/prune': 'disabled',
          'kustomize.toolkit.fluxcd.io/ssa': 'IfNotPresent',
        },
      },
      data: {},
    };
    // Filesystem access is the real ServiceAccount-token boundary.
    const directory = await mkdtemp(join(tmpdir(), 'loader-platform-'));
    const tokenPath = join(directory, 'token');
    await writeFile(tokenPath, 'service-token');
    const client = createKubernetesPhaseStore({
      apiServer: 'https://kubernetes.test',
      tokenFile: tokenPath,
      caFile: '/missing-ca',
      request: async (url, method, token, body) => {
        expect(token).toBe('service-token');
        calls.push({ path: url.pathname, method });
        if (method === 'GET')
          return secret === null
            ? { status: 404, body: '' }
            : { status: 200, body: JSON.stringify(secret) };
        expect(method).toBe('PUT');
        secret = JSON.parse(body ?? '{}') as Record<string, unknown>;
        const metadata = secret['metadata'] as Record<string, unknown>;
        metadata['resourceVersion'] = '2';
        return { status: 200, body: JSON.stringify(secret) };
      },
    });
    try {
      await client.write({ phase: 'custody', status: 'running' });
      expect(await client.read()).toEqual({ phase: 'custody', status: 'running' });
      expect((secret['metadata'] as Record<string, any>).labels.keep).toBe('yes');
      expect(
        (secret['metadata'] as Record<string, any>).annotations['kustomize.toolkit.fluxcd.io/prune']
      ).toBe('disabled');
      expect(
        calls.every(
          ({ path }) =>
            path === '/api/v1/namespaces/lifemodel-system/secrets/loader-bootstrap-state'
        )
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes, reads back and scopes OpenBao key custody to the pre-created Secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'loader-bao-custody-'));
    const tokenPath = join(directory, 'token');
    await writeFile(tokenPath, 'service-token');
    let secret: Record<string, unknown> = {
      metadata: {
        name: 'openbao-unseal-custody',
        namespace: 'lifemodel-system',
        resourceVersion: '1',
        labels: { keep: 'yes' },
        annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
      },
      data: {},
    };
    const paths: string[] = [];
    const custody = createKubernetesBaoCustody({
      apiServer: 'https://kubernetes.test',
      tokenFile: tokenPath,
      caFile: '/missing-ca',
      request: async (url, method, token, body) => {
        expect(token).toBe('service-token');
        paths.push(`${method}:${url.pathname}`);
        if (method === 'GET') return { status: 200, body: JSON.stringify(secret) };
        secret = JSON.parse(body ?? '{}') as Record<string, unknown>;
        (secret['metadata'] as Record<string, unknown>)['resourceVersion'] = '2';
        return { status: 200, body: JSON.stringify(secret) };
      },
    });
    try {
      const value = { keys: ['share'], rootToken: 'root' };
      await custody.write(value);
      expect(await custody.read()).toEqual(value);
      await custody.write({ keys: ['share'], rootToken: null });
      expect(await custody.read()).toEqual({ keys: ['share'], rootToken: null });
      expect((secret['metadata'] as Record<string, any>).labels.keep).toBe('yes');
      expect(
        (secret['metadata'] as Record<string, any>).annotations['kustomize.toolkit.fluxcd.io/prune']
      ).toBe('disabled');
      expect(paths).toEqual([
        'GET:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
        'PUT:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
        'GET:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
        'GET:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
        'GET:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
        'PUT:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
        'GET:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
        'GET:/api/v1/namespaces/lifemodel-system/secrets/openbao-unseal-custody',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records a failed phase so startup retries that phase after a transient error', async () => {
    let record: PlatformPhaseRecord | null = null;
    const store: PlatformPhaseStore = {
      read: async () => record,
      write: async (next) => {
        record = next;
      },
    };
    const run = createPlatformPhaseRunner(store);
    await expect(
      run([
        {
          name: 'bao',
          run: async () => {
            throw new Error('unavailable');
          },
        },
      ])
    ).rejects.toThrow('unavailable');
    expect(record).toEqual({ phase: 'bao', status: 'failed' });
    await run([{ name: 'bao', run: async () => {} }]);
    expect(record).toEqual({ phase: 'bao', status: 'complete' });
  });

  it('allows DNS, k3s API, OpenBao, gateway status, model checks and Gitea only', async () => {
    const policy = await readFile('deploy/platform/a0/network-policy.yaml', 'utf8');
    const egress = policy.split('  egress:\n')[1] ?? '';
    expect(egress).toContain('k8s-app: kube-dns');
    expect(egress).toContain('protocol: UDP\n          port: 53');
    expect(egress).toContain('protocol: TCP\n          port: 53');
    expect(egress).toContain('cidr: 0.0.0.0/0');
    expect(egress).toContain('port: 6443');
    expect(policy).toContain('k3s DNATs the in-cluster API Service to the node address');
    expect(policy).toContain('The API port is the only egress restriction');
    expect(policy).toContain(
      'The Kubernetes API server authenticates the projected ServiceAccount token'
    );
    expect(egress).toContain('kubernetes.io/metadata.name: openbao');
    expect(egress).toContain('port: 8200');
    const parsed = YAML.parse(policy);
    expect(parsed.spec.egress).toHaveLength(7);
    expect(
      parsed.spec.egress
        .flatMap((rule: any) =>
          (rule.ports ?? []).map((port: any) => `${port.protocol}/${port.port}`)
        )
        .sort()
    ).toEqual(['TCP/11434', 'TCP/3000', 'TCP/53', 'TCP/6443', 'TCP/8081', 'TCP/8200', 'UDP/53']);
    expect(egress).toContain(
      '# No port restriction: owner endpoints may use LAN Ollama 11434 or custom HTTPS ports.'
    );
    expect(parsed.spec.egress[4].ports).toBeUndefined();
    expect(parsed.spec.egress[4].to[0].ipBlock.except).toEqual([
      '10.42.0.0/16',
      '10.43.0.0/16',
      '169.254.0.0/16',
    ]);
    // The unported rule admits 192.168.1.20:11434; its exceptions deny cluster and metadata ranges.
    expect(parsed.spec.egress[4].to[0].ipBlock.except).toContain('169.254.0.0/16');
    expect(parsed.spec.egress[1].to).toEqual([{ ipBlock: { cidr: '0.0.0.0/0' } }]);
    expect(parsed.spec.egress[4].to[0].ipBlock.except).toEqual([
      '10.42.0.0/16',
      '10.43.0.0/16',
      '169.254.0.0/16',
    ]);
    expect(
      parsed.spec.egress[5].to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name']
    ).toBe('ollama');
    expect(parsed.spec.egress[1].ports).toEqual([{ protocol: 'TCP', port: 6443 }]);
  });

  it('declares only phase and custody Secret grants for the loader ServiceAccount and mounts its token', async () => {
    const [role, binding, account] = await Promise.all([
      readFile('deploy/platform/a0/service-account.yaml', 'utf8'),
      readFile('deploy/platform/a0/service-account.yaml', 'utf8'),
      readFile('deploy/platform/a0/service-account.yaml', 'utf8'),
    ]);
    expect(role).toContain("resources: ['secrets']");
    expect(role).toContain('- loader-bootstrap-state');
    expect(role).toContain('- openbao-unseal-custody');
    expect(role).toContain('- lifemodel-tls');
    expect(role).toContain('resourceNames:');
    expect(role).toContain('- lifemodel-ca');
    expect(role).not.toMatch(/pods|kustomizations|gitrepositories|roles|serviceaccounts/);
    expect(role).toContain("verbs: ['get', 'update']");
    expect(role).not.toContain('create');
    expect(binding).toContain('kind: ServiceAccount');
    expect(binding).toContain('name: loader');
    expect(account).toContain('automountServiceAccountToken: true');
    const deployment = YAML.parse(await readFile('deploy/platform/a0/deployment.yaml', 'utf8'));
    expect(deployment.spec.template.spec.serviceAccountName).toBe('loader');
    expect(deployment.spec.template.spec.automountServiceAccountToken).not.toBe(false);
    // The settings read the gateway's own health listener (ADR-013 D5/D6).
    expect(deployment.spec.template.spec.containers[0].env).toContainEqual({
      name: 'LIFEMODEL_MODEL_GATEWAY_STATUS_URL',
      value: 'http://model-gateway.lifemodel-system.svc:8081/status',
    });
  });
});
