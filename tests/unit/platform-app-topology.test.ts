import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  createGiteaBootstrap,
  createKubernetesApplicationBootstrap,
  type GiteaApi,
} from '../../loader/src/gitea.js';

const docs = (path: string) =>
  YAML.parseAllDocuments(readFileSync(path, 'utf8'))
    .map((doc) => doc.toJSON() as any)
    .filter(Boolean);

describe('per-namespace application topology', () => {
  it('declares isolated target and release namespaces with appliers and local GitRepositories', () => {
    const objects = ['deploy/platform/a/applications.yaml'].flatMap(docs);
    const namespaces = objects.filter((o) => o.kind === 'Namespace').map((o) => o.metadata.name);
    expect(namespaces).toEqual(
      expect.arrayContaining([
        'lifemodel',
        'lifemodel-motor',
        'lifemodel-releases',
        'lifemodel-motor-releases',
      ])
    );
    for (const ns of ['lifemodel', 'lifemodel-motor']) {
      expect(objects).toContainEqual(
        expect.objectContaining({
          kind: 'ServiceAccount',
          metadata: expect.objectContaining({ name: `${ns}-applier`, namespace: ns }),
        })
      );
      const source = objects.find((o) => o.kind === 'GitRepository' && o.metadata.namespace === ns);
      expect(source?.spec.url).toBe(
        'http://gitea-http.lifemodel-git.svc.cluster.local:3000/admin/lifemodel.git'
      );
      expect(source?.spec.secretRef.name).toBe(`deploy-source-credential`);
    }
    for (const ns of ['lifemodel-releases', 'lifemodel-motor-releases']) {
      const policy = objects.find((o) => o.kind === 'NetworkPolicy' && o.metadata.namespace === ns);
      expect(policy?.spec.ingress).toEqual([]);
      expect(policy?.spec.egress).toEqual([]);
    }
    const targets = ['lifemodel', 'lifemodel-motor'];
    for (const ns of targets) {
      const role = objects.find((o) => o.kind === 'Role' && o.metadata.namespace === ns);
      expect(role?.rules.some((r: any) => r.resources.includes('secrets'))).toBe(false);
    }
    const storageBindings = objects.filter(
      (o) =>
        o.kind === 'RoleBinding' &&
        ['lifemodel-releases', 'lifemodel-motor-releases'].includes(o.metadata.namespace)
    );
    expect(storageBindings).toHaveLength(2);
    expect(storageBindings.map((o) => o.subjects[0].namespace)).toEqual(targets);
    for (const ns of targets) {
      const source = objects.find((o) => o.kind === 'GitRepository' && o.metadata.namespace === ns);
      expect(source?.spec.ref.branch).toBe('deploy');
      const storageRole = objects.find(
        (o) => o.kind === 'Role' && o.metadata.namespace === `${ns}-releases`
      );
      expect(storageRole?.rules).toEqual([
        {
          apiGroups: [''],
          resources: ['secrets'],
          verbs: ['get', 'list', 'watch', 'create', 'update', 'delete'],
        },
      ]);
    }
    const loaderRoles = ['deploy/platform/a/loader-app-rbac.yaml']
      .flatMap(docs)
      .filter((o) => o.kind === 'Role');
    expect(loaderRoles).toHaveLength(2);
    for (const role of loaderRoles) {
      const secretGrants = role.rules.filter((rule: any) => rule.resources.includes('secrets'));
      expect(secretGrants).toEqual([
        { apiGroups: [''], resources: ['secrets'], verbs: ['create'] },
        {
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: ['deploy-source-credential'],
          verbs: ['get', 'update'],
        },
      ]);
      expect(
        role.rules.some(
          (rule: any) =>
            rule.resources.includes('roles') || rule.resources.includes('serviceaccounts')
        )
      ).toBe(false);
    }
    for (const ns of targets) {
      const application = readFileSync(
        `deploy/platform/applications/${ns}/kustomization.yaml`,
        'utf8'
      );
      expect(YAML.parse(application).resources).toEqual(ns === 'lifemodel' ? ['core.yaml'] : []);
    }
  });

  it('writes only the two named credential Secrets and two Kustomizations, then resumes idempotently', async () => {
    const objects = new Map<string, any>();
    const writes: string[] = [];
    let cutSecondSecret = true;
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = mkdtempSync(join(tmpdir(), 'app-bootstrap-'));
    const tokenPath = join(directory, 'token');
    writeFileSync(tokenPath, 'test-token');
    // Use the same fake client boundary with a real token file.
    const api = createKubernetesApplicationBootstrap({
      apiServer: 'https://kubernetes.test',
      tokenFile: tokenPath,
      caFile: join(directory, 'missing'),
      request: async (url, method, token, body) => {
        expect(token).toBe('test-token');
        const path = url.pathname;
        if (path.includes('/gitrepositories/')) return { status: 200, body: '{}' };
        if (method === 'POST') {
          const item = JSON.parse(body ?? '{}');
          if (
            item.kind === 'Secret' &&
            item.metadata.namespace === 'lifemodel-motor' &&
            cutSecondSecret
          ) {
            cutSecondSecret = false;
            return { status: 500, body: 'simulated cut' };
          }
          writes.push(`${item.kind}:${item.metadata.namespace}/${item.metadata.name}`);
          const suffix =
            item.kind === 'Secret'
              ? `/secrets/${item.metadata.name}`
              : `/kustomizations/${item.metadata.name}`;
          objects.set(path.replace(/\/(?:secrets|kustomizations)$/, '') + suffix, item);
          return { status: 201, body: JSON.stringify(item) };
        }
        const item = objects.get(path);
        return item === undefined
          ? { status: 404, body: '' }
          : { status: 200, body: JSON.stringify(item) };
      },
    });
    try {
      await expect(api.ensureCredentials()).rejects.toThrow('simulated cut');
      const first = await api.ensureCredentials();
      expect(first.username).toBe('lifemodel-source');
      await api.ensureApplicationObjects();
      const writesAfterFirst = writes.length;
      await api.ensureCredentials();
      await api.ensureApplicationObjects();
      expect(writes).toHaveLength(writesAfterFirst);
      for (const ns of ['lifemodel', 'lifemodel-motor']) {
        const k = objects.get(
          `/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${ns}/kustomizations/${ns}`
        );
        expect(k.spec).toMatchObject({
          path: `./deploy/platform/applications/${ns}`,
          prune: true,
          serviceAccountName: `${ns}-applier`,
          sourceRef: { kind: 'GitRepository', name: ns },
          targetNamespace: ns,
        });
      }
      expect(writes.sort()).toEqual(
        [
          'Kustomization:lifemodel/lifemodel',
          'Kustomization:lifemodel-motor/lifemodel-motor',
          'Secret:lifemodel/deploy-source-credential',
          'Secret:lifemodel-motor/deploy-source-credential',
        ].sort()
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bootstraps read-only source access then verifies local sources and creates two local Kustomizations', async () => {
    const calls: string[] = [];
    const api: GiteaApi = {
      ensureAdminSecret: async () => ({ username: 'admin', password: 'pw' }),
      waitReady: async () => {},
      verifyAdmin: async () => {},
      ensureRepository: async () => {},
      seedBundle: async () => {},
      ensureDeployBranch: async () => {},
      protectBranch: async () => {},
      ensureReadOnlySource: async () => {
        calls.push('readonly');
      },
      ensureApplicationObjects: async () => {
        calls.push('applications');
      },
    };
    const phases: string[] = [];
    await createGiteaBootstrap({
      api,
      runPhases: async (all) => {
        phases.push(...all.map((p) => p.name));
        for (const p of all) await p.run();
      },
    }).runInitial();
    expect(phases.slice(-2)).toEqual([
      'gitea-source-credentials',
      'gitea-application-kustomizations',
    ]);
    expect(calls).toEqual(['readonly', 'applications']);
  });
});
