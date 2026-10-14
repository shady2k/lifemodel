import { describe, expect, it } from 'vitest';
import {
  createGiteaBootstrap,
  type GiteaApi,
  type GiteaCredentials,
} from '../../loader/src/gitea.js';
import type { PlatformPhase } from '../../loader/src/platform-bootstrap.js';
import { createNodeRunner } from '../../loader/src/exec.js';
import { createGiteaHttpApi, createKubernetesGiteaAdminSecret } from '../../loader/src/gitea.js';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Gitea first-start bootstrap', () => {
  it('creates the admin secret before readiness, verifies login, seeds history, and protects both branches', async () => {
    const events: string[] = [];
    const api: GiteaApi = {
      ensureAdminSecret: async () => {
        events.push('secret');
        return { username: 'admin', password: 'generated' };
      },
      waitReady: async () => {
        events.push('ready');
      },
      verifyAdmin: async (credentials) => {
        events.push(`login:${credentials.username}`);
      },
      ensureRepository: async () => {
        events.push('repository');
      },
      seedBundle: async () => {
        events.push('seed');
      },
      ensureDeployBranch: async () => {
        events.push('deploy-branch');
      },
      protectBranch: async (branch) => {
        events.push(`protect:${branch}`);
      },
    };
    const phases: PlatformPhase[] = [];
    const bootstrap = createGiteaBootstrap({
      api,
      runPhases: async (work) => {
        phases.push(...work);
        for (const phase of work) await phase.run();
      },
    });
    await bootstrap.runInitial();
    expect(events).toEqual([
      'secret',
      'ready',
      'secret',
      'login:admin',
      'repository',
      'seed',
      'deploy-branch',
      'protect:main',
      'protect:deploy',
    ]);
    expect(phases.map(({ name }) => name)).toEqual([
      'gitea-admin-secret',
      'gitea-ready',
      'gitea-admin-login',
      'gitea-repository-seed',
      'gitea-deploy-branch',
      'gitea-main-protection',
      'gitea-deploy-protection',
    ]);
  });

  it('requires a real seed bundle and leaves the admin Secret in place for the chart reference', async () => {
    const events: string[] = [];
    const api: GiteaApi = {
      ensureAdminSecret: async () => ({ username: 'admin', password: 'kept' }),
      waitReady: async () => {},
      verifyAdmin: async () => {},
      ensureRepository: async () => {},
      seedBundle: async () => {
        events.push('seed');
      },
      ensureDeployBranch: async () => {},
      protectBranch: async () => {},
    };
    const bootstrap = createGiteaBootstrap({
      api,
      runPhases: async (phases) => {
        for (const phase of phases) await phase.run();
      },
    });
    await bootstrap.runInitial();
    expect(events).toEqual(['seed']);
    expect(Object.keys(api)).not.toContain('deleteAdminSecret');
  });

  it('creates the named admin Secret once, reuses its password, and never deletes the chart reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gitea-admin-secret-test-'));
    const token = join(directory, 'token');
    await writeFile(token, 'service-token');
    let stored: Record<string, any> | null = null;
    const calls: string[] = [];
    const ensure = createKubernetesGiteaAdminSecret({
      apiServer: 'https://kubernetes.test',
      tokenFile: token,
      caFile: join(directory, 'no-ca'),
      request: async (url, method, auth, body) => {
        expect(auth).toBe('service-token');
        calls.push(`${method} ${url.pathname}`);
        if (method === 'GET')
          return stored === null
            ? { status: 404, body: '' }
            : { status: 200, body: JSON.stringify(stored) };
        expect(method).toBe('POST');
        stored = JSON.parse(body ?? '{}') as Record<string, any>;
        return { status: 201, body: JSON.stringify(stored) };
      },
    });
    try {
      const first = await ensure();
      const second = await ensure();
      expect(first.username).toBe('admin');
      expect(first.password).not.toBe('');
      expect(second).toEqual(first);
      expect((stored?.['metadata'] as Record<string, any>)['name']).toBe('gitea-admin');
      expect(calls).toEqual([
        'GET /api/v1/namespaces/lifemodel-git/secrets/gitea-admin',
        'POST /api/v1/namespaces/lifemodel-git/secrets',
        'GET /api/v1/namespaces/lifemodel-git/secrets/gitea-admin',
      ]);
      expect(calls.some((call) => call.startsWith('DELETE '))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses a fake Gitea API and real git to push the release bundle history into a temporary repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitea-bootstrap-test-'));
    const bundle = join(root, 'seed.bundle');
    const bare = join(root, 'gitea.git');
    const source = join(root, 'source');
    await mkdir(source);
    const runner = createNodeRunner();
    const run = async (args: string[], cwd?: string) => {
      const result = await runner.run('git', args, { cwd, timeoutMs: 10_000 });
      expect(result.code, result.stderr).toBe(0);
    };
    await run(['init', '-b', 'main', source]);
    await run(['config', 'user.email', 'test@example.invalid'], source);
    await run(['config', 'user.name', 'test'], source);
    await writeFile(join(source, 'history.txt'), 'release history\n');
    await run(['add', 'history.txt'], source);
    await run(['commit', '-m', 'release seed'], source);
    await run(['bundle', 'create', bundle, '--all'], source);
    await run(['init', '--bare', '-b', 'main', bare]);
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const missing =
        req.method === 'GET' &&
        (req.url?.endsWith('/repos/admin/lifemodel') || req.url?.endsWith('/branches/deploy'));
      res.statusCode = missing ? 404 : req.method === 'POST' ? 201 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ authenticated: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('fake Gitea server has no TCP port');
    const api = createGiteaHttpApi({
      address: `http://127.0.0.1:${address.port}`,
      seedBundle: bundle,
      runner,
      gitRemote: bare,
    });
    api.ensureAdminSecret = async () => ({ username: 'admin', password: 'test-password' });
    try {
      await api.waitReady();
      await api.verifyAdmin({ username: 'admin', password: 'test-password' });
      await api.ensureRepository();
      await api.seedBundle();
      await api.ensureDeployBranch();
      await api.protectBranch('main');
      const sourceHead = (
        await runner.run('git', ['rev-parse', 'HEAD'], { cwd: source })
      ).stdout.trim();
      const remoteHead = (
        await runner.run('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'])
      ).stdout.trim();
      expect(remoteHead).toBe(sourceHead);
      expect(seen).toContain('PUT /api/v1/repos/admin/lifemodel/branch_protections/main');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(root, { recursive: true, force: true });
    }
  });
});
