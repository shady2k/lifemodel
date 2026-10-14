import { describe, expect, it } from 'vitest';
import {
  createGiteaBootstrap,
  type GiteaApi,
  type GiteaCredentials,
} from '../../loader/src/gitea.js';
import {
  createPlatformPhaseRunner,
  type PlatformPhase,
  type PlatformPhaseStore,
} from '../../loader/src/platform-bootstrap.js';
import { createNodeRunner } from '../../loader/src/exec.js';
import {
  createGiteaHttpApi,
  createKubernetesApplicationBootstrap,
  createKubernetesGiteaAdminSecret,
} from '../../loader/src/gitea.js';
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
      ensureReadOnlySource: async () => {},
      ensureApplicationObjects: async () => {},
    };
    const phases: PlatformPhase[] = [];
    const bootstrap = createGiteaBootstrap({
      api,
      runPhases: async (work) => {
        phases.push(...work);
        for (const phase of work) {
          await phase.beforeRun?.();
          await phase.run();
        }
      },
    });
    await bootstrap.runInitial();
    expect(events).toEqual([
      'secret',
      'ready',
      'secret',
      'ready',
      'login:admin',
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
      'gitea-source-credentials',
      'gitea-application-kustomizations',
    ]);
  });

  it('does not rehydrate credentials when every durable Gitea phase is complete', async () => {
    const calls: string[] = [];
    const phases: PlatformPhaseStore = {
      read: async () => ({ phase: 'gitea-application-kustomizations', status: 'complete' }),
      write: async () => {
        throw new Error('completed Gitea work must be skipped');
      },
    };
    const api: GiteaApi = {
      ensureAdminSecret: async () => {
        calls.push('secret');
        return { username: 'admin', password: 'pw' };
      },
      waitReady: async () => {
        calls.push('ready');
      },
      verifyAdmin: async () => {
        calls.push('login');
      },
      ensureRepository: async () => {
        calls.push('repository');
      },
      seedBundle: async () => {},
      ensureDeployBranch: async () => {},
      protectBranch: async () => {},
      ensureReadOnlySource: async () => {},
      ensureApplicationObjects: async () => {},
    };
    const bootstrap = createGiteaBootstrap({ api, runPhases: createPlatformPhaseRunner(phases) });

    await bootstrap.runInitial();

    expect(calls).toEqual([]);
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
      ensureReadOnlySource: async () => {},
      ensureApplicationObjects: async () => {},
    };
    const bootstrap = createGiteaBootstrap({
      api,
      runPhases: async (phases) => {
        for (const phase of phases) {
          await phase.beforeRun?.();
          await phase.run();
        }
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
    const bare = join(root, 'gitea.git');
    const runner = createNodeRunner();
    const run = async (args: string[], cwd?: string) => {
      const result = await runner.run('git', args, { cwd, timeoutMs: 10_000 });
      expect(result.code, result.stderr).toBe(0);
    };
    const preparerRoot = join(root, 'prepared');
    await mkdir(join(preparerRoot, 'scripts/release'), { recursive: true });
    await mkdir(join(preparerRoot, 'loader'));
    await writeFile(
      join(preparerRoot, 'scripts/release/prepare-loader-context.sh'),
      await readFile('scripts/release/prepare-loader-context.sh', 'utf8')
    );
    await run(['init', '-b', 'main', preparerRoot]);
    await run(['config', 'user.email', 'test@example.invalid'], preparerRoot);
    await run(['config', 'user.name', 'test'], preparerRoot);
    await writeFile(join(preparerRoot, 'history.txt'), 'release one\n');
    await run(['add', 'history.txt'], preparerRoot);
    await run(['commit', '-m', 'release one'], preparerRoot);
    await writeFile(join(preparerRoot, 'history.txt'), 'release two\n');
    await run(['commit', '-am', 'release two'], preparerRoot);
    const prepared = await runner.run(
      'sh',
      [join(preparerRoot, 'scripts/release/prepare-loader-context.sh')],
      { timeoutMs: 10_000 }
    );
    expect(prepared.code, prepared.stderr).toBe(0);
    const productionBundle = join(preparerRoot, '.docker-context/seed.bundle');
    await run(['init', '--bare', '-b', 'main', bare]);
    const seen: string[] = [];
    const protections = new Map<string, Record<string, unknown>>();
    let protectionReadbackDrift = false;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const route = `${req.method} ${req.url}`;
        seen.push(route);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const protection = req.url?.match(/branch_protections\/([^/]+)$/);
        if (req.method === 'GET' && req.url === '/api/v1/version') {
          res.statusCode = 200;
          res.end('{}');
        } else if (req.method === 'GET' && req.url === '/api/v1/user') {
          res.statusCode = 200;
          res.end('{"login":"admin"}');
        } else if (req.method === 'GET' && req.url === '/api/v1/repos/admin/lifemodel') {
          res.statusCode = 404;
          res.end('{}');
        } else if (req.method === 'POST' && req.url === '/api/v1/admin/users/admin/repos') {
          res.statusCode = 201;
          res.end('{}');
        } else if (req.method === 'GET' && req.url === '/api/v1/repos/admin/lifemodel/branches/deploy') {
          res.statusCode = 404;
          res.end('{}');
        } else if (req.method === 'POST' && req.url === '/api/v1/repos/admin/lifemodel/branches') {
          res.statusCode = 201;
          res.end('{}');
        } else if (req.method === 'GET' && protection) {
          const value = protections.get(decodeURIComponent(protection[1]));
          const observed = value && protectionReadbackDrift ? { ...value, enable_push: false } : value;
          res.statusCode = value ? 200 : 404;
          res.end(JSON.stringify(observed ?? {}));
        } else if (req.method === 'POST' && req.url === '/api/v1/repos/admin/lifemodel/branch_protections') {
          const rule = body as Record<string, unknown>;
          protections.set(String(rule['rule_name']), rule);
          res.statusCode = 201;
          res.end(JSON.stringify(rule));
        } else if (req.method === 'PATCH' && protection) {
          const rule = body as Record<string, unknown>;
          protections.set(decodeURIComponent(protection[1]), rule);
          res.statusCode = 200;
          res.end(JSON.stringify(rule));
        } else {
          // Unsupported methods/routes deliberately fail like Gitea instead of
          // making a bad client route look successful.
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('fake Gitea server has no TCP port');
    const makeApi = () => {
      const api = createGiteaHttpApi({
        address: `http://127.0.0.1:${address.port}`,
        seedBundle: productionBundle,
        runner,
        gitRemote: bare,
      });
      api.ensureAdminSecret = async () => ({ username: 'admin', password: 'test-password' });
      return api;
    };
    const api = makeApi();
    try {
      await api.waitReady();
      await api.verifyAdmin({ username: 'admin', password: 'test-password' });
      await api.ensureRepository();
      await api.seedBundle();
      await api.ensureDeployBranch();
      await api.protectBranch('main');
      await api.protectBranch('deploy');
      // Simulate a process cut after POST succeeded but before phase completion.
      const durablePhase = { phase: 'gitea-main-protection', status: 'running' };
      const resumedApi = makeApi();
      await resumedApi.verifyAdmin({ username: 'admin', password: 'test-password' });
      await resumedApi.protectBranch('main');
      expect(durablePhase).toEqual({ phase: 'gitea-main-protection', status: 'running' });
      protectionReadbackDrift = true;
      await expect(resumedApi.protectBranch('main')).rejects.toThrow(/read-back mismatch/);
      const remoteHead = (
        await runner.run('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'])
      ).stdout.trim();
      expect(remoteHead).toBe((await runner.run('git', ['rev-parse', 'HEAD'], { cwd: preparerRoot })).stdout.trim());
      expect((await runner.run('git', ['rev-list', '--count', 'refs/heads/main'], { cwd: bare })).stdout.trim()).toBe('2');
      expect(seen).toContain('GET /api/v1/repos/admin/lifemodel/branch_protections/main');
      expect(seen).toContain('POST /api/v1/repos/admin/lifemodel/branch_protections');
      expect(seen).toContain('PATCH /api/v1/repos/admin/lifemodel/branch_protections/main');
      expect(seen).toContain('POST /api/v1/repos/admin/lifemodel/branch_protections');
      expect(seen).toContain('GET /api/v1/repos/admin/lifemodel/branch_protections/deploy');
      expect(seen.filter((call) => call === 'GET /api/v1/repos/admin/lifemodel/branch_protections/main')).toHaveLength(6);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reports a missing git binary before trying to clone the seed bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitea-missing-git-'));
    try {
      const server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('fake Gitea server has no TCP port');
      const api = createGiteaHttpApi({
        address: `http://127.0.0.1:${address.port}`,
        seedBundle: join(root, 'seed.bundle'),
        runner: createNodeRunner(),
        gitPath: join(root, 'missing-git'),
      });
      try {
        await api.verifyAdmin({ username: 'admin', password: 'test-password' });
        await expect(api.seedBundle()).rejects.toThrow(/git binary is unavailable/);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it.each(['after user creation', 'after collaborator assignment'])(
    'resumes source-user setup after a cut %s using the persisted credential',
    async (cut) => {
      const root = await mkdtemp(join(tmpdir(), 'gitea-source-user-'));
      const token = join(root, 'token');
      await writeFile(token, 'service-token');
      const sourcePassword = 'persisted-source-password';
      const users = new Map<string, string>();
      const collaborators = new Set<string>();
      const calls: string[] = [];
      let armedCut: string = cut;
      let adminCredentials = { username: 'admin', password: 'admin-secret' };
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const route = `${req.method} ${req.url}`;
          calls.push(route);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
          const auth = req.headers.authorization;
          const isSource = auth === `Basic ${Buffer.from(`lifemodel-source:${sourcePassword}`).toString('base64')}`;
          const isAdmin = auth === `Basic ${Buffer.from(`${adminCredentials.username}:${adminCredentials.password}`).toString('base64')}`;
          if (req.method === 'GET' && req.url === '/api/v1/user' && isAdmin) {
            res.statusCode = 200;
            res.end('{\"login\":\"admin\"}');
          } else if (req.method === 'GET' && req.url === '/api/v1/users/lifemodel-source' && isAdmin) {
            const password = users.get('lifemodel-source');
            res.statusCode = password === undefined ? 404 : 200;
            res.end(password === undefined ? '{}' : JSON.stringify({ login: 'lifemodel-source', username: 'lifemodel-source', is_admin: false }));
          } else if (req.method === 'POST' && req.url === '/api/v1/admin/users' && isAdmin) {
            users.set(String(body['username']), String(body['password']));
            res.statusCode = 201;
            res.end('{}');
          } else if (req.method === 'PUT' && req.url === '/api/v1/repos/admin/lifemodel/collaborators/lifemodel-source' && isAdmin) {
            collaborators.add('lifemodel-source');
            if (armedCut === 'after user creation') {
              armedCut = 'done';
              res.statusCode = 500;
              res.end('{}');
            } else {
              res.statusCode = 204;
              res.end();
              if (armedCut === 'after collaborator assignment') armedCut = 'cut-auth';
            }
          } else if (req.method === 'GET' && req.url === '/api/v1/user' && isSource) {
            if (armedCut === 'none' && cut === 'after user creation') {
              armedCut = 'done';
            }
            if (armedCut === 'cut-auth') {
              armedCut = 'done';
              res.statusCode = 500;
              res.end('{}');
            } else {
              res.statusCode = 200;
              res.end('{"login":"lifemodel-source"}');
            }
          } else if (req.method === 'GET' && req.url === '/api/v1/repos/admin/lifemodel' && isSource && collaborators.has('lifemodel-source')) {
            res.statusCode = 200;
            res.end('{"permissions":{"pull":true,"push":false}}');
          } else {
            // The unsupported admin-user GET and all other unknown API routes fail closed.
            res.statusCode = 404;
            res.end('{}');
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing test server address');
      const newApi = () => {
        const api = createGiteaHttpApi({
          address: `http://127.0.0.1:${address.port}`,
          seedBundle: '',
          runner: createNodeRunner(),
          kubernetes: { apiServer: 'https://kubernetes.test', tokenFile: token, caFile: join(root, 'no-ca'), request: kubernetesRequest },
        });
        api.ensureAdminSecret = async () => adminCredentials;
        return api;
      };
      // The test seam reads the exact same durable Secret on both attempts.
      const kubernetesRequest = async (url: URL, method: string, auth: string) => {
        if (auth !== 'service-token') throw new Error('unexpected Kubernetes credential');
        if (method === 'GET' && url.pathname.endsWith('/deploy-source-credential')) {
          return {
            status: 200,
            body: JSON.stringify({ data: {
              username: Buffer.from('lifemodel-source').toString('base64'),
              password: Buffer.from(sourcePassword).toString('base64'),
            } }),
          };
        }
        return { status: 404, body: '{}' };
      };
      try {
        const first = newApi();
        await first.verifyAdmin(adminCredentials);
        await expect(first.ensureReadOnlySource()).rejects.toThrow();
        const resumed = newApi();
        await resumed.verifyAdmin(adminCredentials);
        await resumed.ensureReadOnlySource();
        expect(users.get('lifemodel-source')).toBe(sourcePassword);
        expect(calls.filter((value) => value === 'POST /api/v1/admin/users')).toHaveLength(1);
        expect(calls).toContain('GET /api/v1/users/lifemodel-source');
        expect(calls).toContain('PUT /api/v1/repos/admin/lifemodel/collaborators/lifemodel-source');
        expect(calls).toContain('GET /api/v1/user');
        expect(calls).toContain('GET /api/v1/repos/admin/lifemodel');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('accepts Flux defaults in Kustomization read-back but rejects drift in owned fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitea-kustomization-'));
    const token = join(root, 'token');
    await writeFile(token, 'service-token');
    const makeApi = (mutate: (spec: Record<string, unknown>) => void) => {
      return createKubernetesApplicationBootstrap({
        tokenFile: token,
        apiServer: 'https://kubernetes.test',
        request: async (url, method, auth) => {
          expect(auth).toBe('service-token');
          if (method !== 'GET') return { status: 404, body: '{}' };
          const path = url.pathname;
          if (path.includes('/gitrepositories/')) return { status: 200, body: '{}' };
          const namespace = path.includes('/lifemodel-motor/') ? 'lifemodel-motor' : 'lifemodel';
          const spec: Record<string, unknown> = {
            interval: '1m',
            path: namespace === 'lifemodel' ? './deploy/platform/applications/lifemodel' : './deploy/platform/applications/lifemodel-motor',
            prune: true,
            force: false,
            serviceAccountName: `${namespace}-applier`,
            sourceRef: { kind: 'GitRepository', name: namespace },
            targetNamespace: namespace,
            deletionPolicy: 'MirrorPrune',
          };
          mutate(spec);
          return { status: 200, body: JSON.stringify({ spec }) };
        },
      });
    };
    try {
      await makeApi(() => {}).ensureApplicationObjects();
      await expect(
        makeApi((spec) => { spec['targetNamespace'] = 'default'; }).ensureApplicationObjects()
      ).rejects.toThrow(/differs from the pinned platform bootstrap spec/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('rehydrates admin credentials into a fresh HTTP client for every persisted Gitea phase cut', async () => {
    const secret = { username: 'admin', password: 'durable-secret' };
    const phases = createGiteaBootstrap({
      api: {
        ensureAdminSecret: async () => secret,
        waitReady: async () => {},
        verifyAdmin: async () => {},
        ensureRepository: async () => {},
        seedBundle: async () => {},
        ensureDeployBranch: async () => {},
        protectBranch: async () => {},
        ensureReadOnlySource: async () => {},
        ensureApplicationObjects: async () => {},
      },
      runPhases: async () => {},
    }).phases();
    const cuts = phases.map(({ name }) => ({ phase: name, status: 'running' as const }));
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const auth = req.headers.authorization;
      const accepted = auth === `Basic ${Buffer.from('admin:durable-secret').toString('base64')}`;
      seen.push(`${req.method} ${req.url} ${accepted ? 'admin' : 'no-auth'}`);
      if (req.method === 'GET' && req.url === '/api/v1/version') {
        res.statusCode = 200;
        res.end('{}');
      } else if (req.method === 'GET' && req.url === '/api/v1/user' && accepted) {
        res.statusCode = 200;
        res.end('{"login":"admin"}');
      } else if (req.method === 'GET' && req.url === '/api/v1/repos/admin/lifemodel' && accepted) {
        res.statusCode = 200;
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test server address');
    try {
      for (const durableRecord of cuts) {
        // Every simulated restart constructs an entirely new API client while
        // reading the same durable phase record and Secret.
        const api = createGiteaHttpApi({
          address: `http://127.0.0.1:${address.port}`,
          seedBundle: '',
          runner: createNodeRunner(),
        });
        api.ensureAdminSecret = async () => secret;
        const bootstrap = createGiteaBootstrap({
          api,
          runPhases: async (work) => {
            expect(durableRecord.status).toBe('running');
            await work.find(({ name }) => name === 'gitea-repository-seed')?.beforeRun?.();
            await api.ensureRepository();
          },
        });
        await bootstrap.runInitial();
      }
      expect(seen.filter((entry) => entry.startsWith('GET /api/v1/user admin'))).toHaveLength(cuts.length);
      expect(seen.filter((entry) => entry.startsWith('GET /api/v1/repos/admin/lifemodel admin'))).toHaveLength(cuts.length);
      expect(seen.some((entry) => entry.includes('no-auth') && !entry.startsWith('GET /api/v1/version'))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

});
