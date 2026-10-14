/** Restart-safe Gitea first-start bootstrap (ADR-010 R7-02/R6-05). */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { PlatformPhase } from './platform-bootstrap.js';
import type { CommandRunner } from './exec.js';

export interface GiteaCredentials {
  username: string;
  password: string;
}
export interface GiteaApi {
  ensureAdminSecret(): Promise<GiteaCredentials>;
  waitReady(): Promise<void>;
  verifyAdmin(credentials: GiteaCredentials): Promise<void>;
  ensureRepository(): Promise<void>;
  seedBundle(): Promise<void>;
  ensureDeployBranch(): Promise<void>;
  protectBranch(branch: string): Promise<void>;
  ensureReadOnlySource(): Promise<void>;
  ensureApplicationObjects(): Promise<void>;
}
export interface GiteaBootstrapDeps {
  api: GiteaApi;
  runPhases(phases: PlatformPhase[]): Promise<void>;
}
export function createGiteaBootstrap(deps: GiteaBootstrapDeps): {
  runInitial(): Promise<void>;
  phases(): PlatformPhase[];
} {
  const phases: PlatformPhase[] = [
    {
      name: 'gitea-admin-secret',
      run: async () => {
        await deps.api.ensureAdminSecret();
      },
    },
    { name: 'gitea-ready', run: () => deps.api.waitReady() },
    {
      name: 'gitea-admin-login',
      run: async () => {
        await deps.api.verifyAdmin(await deps.api.ensureAdminSecret());
      },
    },
    {
      name: 'gitea-repository-seed',
      run: async () => {
        await deps.api.ensureRepository();
        await deps.api.seedBundle();
      },
    },
    { name: 'gitea-deploy-branch', run: () => deps.api.ensureDeployBranch() },
    { name: 'gitea-main-protection', run: () => deps.api.protectBranch('main') },
    { name: 'gitea-deploy-protection', run: () => deps.api.protectBranch('deploy') },
    { name: 'gitea-source-credentials', run: () => deps.api.ensureReadOnlySource() },
    { name: 'gitea-application-kustomizations', run: () => deps.api.ensureApplicationObjects() },
  ];
  return { phases: () => phases, runInitial: () => deps.runPhases(phases) };
}

interface KubernetesOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  request?: (
    url: URL,
    method: string,
    token: string,
    body?: string,
    ca?: Buffer
  ) => Promise<{ status: number; body: string }>;
}
const ADMIN_SECRET = 'gitea-admin';
/** Fixed-name Secret access only. RBAC create cannot use resourceNames; the client posts only this name and has no list/delete operation. */
export function createKubernetesGiteaAdminSecret(
  options: KubernetesOptions = {}
): GiteaApi['ensureAdminSecret'] {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const namespace = 'lifemodel-git';
  const base = new URL(`/api/v1/namespaces/${namespace}/secrets`, host);
  const tokenFile = options.tokenFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const caFile = options.caFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
  const call =
    options.request ??
    ((url, method, token, body, ca) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = fn(
          url,
          {
            method,
            ca,
            headers: {
              authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (part: string) => {
              data += part;
            });
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body: data });
            });
          }
        );
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
      }));
  async function send(url: URL, method: string, body?: string) {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    let ca: Buffer | undefined;
    try {
      ca = await readFile(caFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return call(url, method, token, body, ca);
  }
  return async () => {
    const url = new URL(`${base.pathname}/${ADMIN_SECRET}`, base);
    let response = await send(url, 'GET');
    if (response.status === 404) {
      const password = randomBytes(32).toString('base64url');
      const body = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: ADMIN_SECRET,
          namespace,
          annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
        },
        type: 'Opaque',
        data: {
          username: Buffer.from('admin').toString('base64'),
          password: Buffer.from(password).toString('base64'),
        },
      };
      response = await send(base, 'POST', JSON.stringify(body));
      if (response.status === 201) return { username: 'admin', password };
      if (response.status !== 409)
        throw new Error(
          `Gitea admin Secret create failed (${String(response.status)}): ${response.body}`
        );
      response = await send(url, 'GET');
    }
    if (response.status !== 200)
      throw new Error(
        `Gitea admin Secret read failed (${String(response.status)}): ${response.body}`
      );
    const data = (JSON.parse(response.body) as { data?: Record<string, string> }).data;
    if (!data?.['username'] || !data['password'])
      throw new Error('existing gitea-admin Secret has no username/password custody');
    return {
      username: Buffer.from(data['username'], 'base64').toString(),
      password: Buffer.from(data['password'], 'base64').toString(),
    };
  };
}

export interface GiteaHttpOptions {
  address: string;
  seedBundle: string;
  runner: CommandRunner;
  gitRemote?: string;
  timeoutMs?: number;
  kubernetes?: KubernetesOptions;
}
const APPLICATIONS = [
  {
    namespace: 'lifemodel',
    source: 'lifemodel',
    path: './deploy/platform/applications/lifemodel',
    storage: 'lifemodel-releases',
  },
  {
    namespace: 'lifemodel-motor',
    source: 'lifemodel-motor',
    path: './deploy/platform/applications/lifemodel-motor',
    storage: 'lifemodel-motor-releases',
  },
] as const;

/** Kubernetes access is restricted in code to the two named credential Secrets,
 * the two platform GitRepositories, and the two application Kustomizations. */
export function createKubernetesApplicationBootstrap(options: KubernetesOptions = {}): {
  ensureCredentials(): Promise<GiteaCredentials>;
  ensureApplicationObjects(): Promise<void>;
} {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const tokenFile = options.tokenFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const caFile = options.caFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
  const call =
    options.request ??
    ((url, method, token, body, ca) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpsRequest(
          url,
          {
            method,
            ca,
            headers: {
              authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            let response = '';
            res.setEncoding('utf8');
            res.on('data', (part: string) => {
              response += part;
            });
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body: response });
            });
          }
        );
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
      }));
  async function send(
    path: string,
    method = 'GET',
    payload?: unknown
  ): Promise<{ status: number; body: string }> {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined;
    try {
      ca = await readFile(caFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return call(
      new URL(path, host),
      method,
      token,
      payload === undefined ? undefined : JSON.stringify(payload),
      ca
    );
  }
  const secretPath = (namespace: string, name: string) =>
    `/api/v1/namespaces/${namespace}/secrets/${name}`;
  async function readSecret(ns: string, name: string): Promise<GiteaCredentials | null> {
    const result = await send(secretPath(ns, name));
    if (result.status === 404) return null;
    if (result.status !== 200)
      throw new Error(
        `source credential Secret read failed (${String(result.status)}): ${result.body}`
      );
    const data = (JSON.parse(result.body) as { data?: Record<string, string> }).data;
    if (!data?.['username'] || !data['password'])
      throw new Error(`source credential Secret ${ns}/${name} is incomplete`);
    return {
      username: Buffer.from(data['username'], 'base64').toString(),
      password: Buffer.from(data['password'], 'base64').toString(),
    };
  }
  async function ensureCredentials(): Promise<GiteaCredentials> {
    const name = 'deploy-source-credential';
    const existing = await Promise.all(
      APPLICATIONS.map(({ namespace }) => readSecret(namespace, name))
    );
    const saved = existing.find((value) => value !== null) ?? {
      username: 'lifemodel-source',
      password: randomBytes(32).toString('base64url'),
    };
    if (saved.username !== 'lifemodel-source' || !saved.password)
      throw new Error('source credential Secret has unexpected identity');
    for (const [index, app] of APPLICATIONS.entries()) {
      const ns = app.namespace;
      const prior = existing[index];
      if (prior !== null && prior !== undefined) {
        if (prior.username !== saved.username || prior.password !== saved.password)
          throw new Error('target source credential Secrets disagree');
        continue;
      }
      const body = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name,
          namespace: ns,
          annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
        },
        type: 'Opaque',
        data: {
          username: Buffer.from(saved.username).toString('base64'),
          password: Buffer.from(saved.password).toString('base64'),
        },
      };
      const created = await send(`/api/v1/namespaces/${ns}/secrets`, 'POST', body);
      if (created.status === 409) {
        const current = await readSecret(ns, name);
        if (current?.username !== saved.username || current.password !== saved.password)
          throw new Error(`source credential Secret ${ns}/${name} raced with different data`);
      } else if (created.status !== 201)
        throw new Error(
          `source credential Secret create failed (${String(created.status)}): ${created.body}`
        );
      const verified = await readSecret(ns, name);
      if (verified?.username !== saved.username || verified.password !== saved.password)
        throw new Error(`source credential Secret ${ns}/${name} read-back mismatch`);
    }
    return saved;
  }
  async function ensureApplicationObjects(): Promise<void> {
    for (const app of APPLICATIONS) {
      const sourcePath = `/apis/source.toolkit.fluxcd.io/v1/namespaces/${app.namespace}/gitrepositories/${app.source}`;
      const source = await send(sourcePath);
      if (source.status !== 200)
        throw new Error(
          `platform GitRepository ${app.namespace}/${app.source} is missing or unreadable (${String(source.status)})`
        );
      const desired = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: {
          name: app.namespace,
          namespace: app.namespace,
          annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
        },
        spec: {
          interval: '1m',
          path: app.path,
          prune: true,
          serviceAccountName: `${app.namespace}-applier`,
          sourceRef: { kind: 'GitRepository', name: app.source },
          targetNamespace: app.namespace,
        },
      };
      const path = `/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${app.namespace}/kustomizations/${app.namespace}`;
      const current = await send(path);
      if (current.status === 404) {
        const result = await send(
          `/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${app.namespace}/kustomizations`,
          'POST',
          desired
        );
        if (result.status !== 201 && result.status !== 409)
          throw new Error(
            `application Kustomization create failed (${String(result.status)}): ${result.body}`
          );
      } else if (current.status !== 200)
        throw new Error(
          `application Kustomization read failed (${String(current.status)}): ${current.body}`
        );
      else {
        const object = JSON.parse(current.body) as { spec?: unknown };
        if (JSON.stringify(object.spec) !== JSON.stringify(desired.spec))
          throw new Error(
            `application Kustomization ${app.namespace}/${app.namespace} differs from the pinned platform bootstrap spec`
          );
        continue;
      }
      const verified = await send(path);
      if (verified.status !== 200)
        throw new Error(
          `application Kustomization ${app.namespace} read-back failed (${String(verified.status)})`
        );
      const object = JSON.parse(verified.body) as { spec?: unknown };
      if (JSON.stringify(object.spec) !== JSON.stringify(desired.spec))
        throw new Error(`application Kustomization ${app.namespace} read-back mismatch`);
    }
  }
  return { ensureCredentials, ensureApplicationObjects };
}

/** Gitea's scoped bootstrap API; credentials never enter logs or chart values. */
export function createGiteaHttpApi(options: GiteaHttpOptions): GiteaApi {
  const base = new URL(options.address);
  let credentials: GiteaCredentials | undefined;
  const timeout = options.timeoutMs ?? 10_000;
  async function request(
    path: string,
    method = 'GET',
    auth = credentials,
    payload?: unknown,
    allow404 = false
  ): Promise<{ status: number; body: string }> {
    const url = new URL(path, base);
    return new Promise((resolve, reject) => {
      const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = fn(
        url,
        {
          method,
          headers: {
            ...(auth
              ? {
                  authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
                }
              : {}),
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (part: string) => (body += part));
          res.on('end', () => {
            clearTimeout(timer);
            const status = res.statusCode ?? 0;
            if ((status < 200 || status >= 300) && !(allow404 && status === 404))
              reject(new Error(`Gitea ${method} ${path} failed (${String(status)}): ${body}`));
            else resolve({ status, body });
          });
        }
      );
      const timer = setTimeout(
        () => req.destroy(new Error(`Gitea request exceeded ${String(timeout)} ms`)),
        timeout
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(JSON.stringify(payload));
      req.end();
    });
  }
  const repo = '/api/v1/repos/admin/lifemodel';
  const sourceAccount = 'lifemodel-source';
  const kubernetes = createKubernetesApplicationBootstrap(options.kubernetes);
  return {
    ensureAdminSecret: async () => {
      credentials = await createKubernetesGiteaAdminSecret()();
      return credentials;
    },
    waitReady: async () => {
      const end = Date.now() + timeout * 60;
      while (Date.now() < end) {
        try {
          await request('/api/v1/version', 'GET', undefined, undefined);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      throw new Error('Gitea did not become ready before its bootstrap deadline');
    },
    verifyAdmin: async (c) => {
      credentials = c;
      await request('/api/v1/user', 'GET', c);
    },
    ensureRepository: async () => {
      const found = await request(repo, 'GET', credentials, undefined, true);
      if (found.status === 404)
        await request('/api/v1/admin/users/admin/repos', 'POST', credentials, {
          name: 'lifemodel',
          private: true,
          auto_init: false,
          default_branch: 'main',
        });
    },
    seedBundle: async () => {
      const credentialsNow = credentials;
      if (!credentialsNow) throw new Error('Gitea admin login has not been verified');
      const remote = options.gitRemote ?? `${base.origin}/admin/lifemodel.git`;
      const directory = await mkdtemp(join(tmpdir(), 'gitea-seed-'));
      try {
        const clone = await options.runner.run('git', ['clone', options.seedBundle, directory], {
          timeoutMs: timeout,
        });
        if (clone.code !== 0)
          throw new Error(
            `git clone of release seed bundle failed: ${clone.stderr.trim().split('\n')[0] ?? 'no output'}`
          );
        const header = `Authorization: Basic ${Buffer.from(`${credentialsNow.username}:${credentialsNow.password}`).toString('base64')}`;
        const push = await options.runner.run('git', ['push', '--mirror', remote], {
          cwd: directory,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: header,
          },
          timeoutMs: timeout,
        });
        if (push.code !== 0)
          throw new Error(
            `git push of release seed bundle failed: ${push.stderr.trim().split('\n')[0] ?? 'no output'}`
          );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    ensureDeployBranch: async () => {
      const found = await request(
        '/api/v1/repos/admin/lifemodel/branches/deploy',
        'GET',
        credentials,
        undefined,
        true
      );
      if (found.status === 404)
        await request('/api/v1/repos/admin/lifemodel/branches', 'POST', credentials, {
          new_branch_name: 'deploy',
          old_branch_name: 'main',
        });
    },
    ensureReadOnlySource: async () => {
      const source = await kubernetes.ensureCredentials();
      const found = await request(
        `/api/v1/admin/users/${sourceAccount}`,
        'GET',
        credentials,
        undefined,
        true
      );
      if (found.status === 404) {
        await request('/api/v1/admin/users', 'POST', credentials, {
          username: sourceAccount,
          password: source.password,
          email: `${sourceAccount}@lifemodel.invalid`,
          must_change_password: false,
        });
      }
      await request(`${repo}/collaborators/${sourceAccount}`, 'PUT', credentials, {
        permission: 'read',
      });
      await request('/api/v1/user', 'GET', source);
      await request(repo, 'GET', source);
    },
    ensureApplicationObjects: () => kubernetes.ensureApplicationObjects(),
    protectBranch: async (branch) => {
      await request(
        `/api/v1/repos/admin/lifemodel/branch_protections/${encodeURIComponent(branch)}`,
        'PUT',
        credentials,
        {
          rule_name: branch,
          enable_push: true,
          enable_push_whitelist: true,
          push_whitelist_usernames: ['admin'],
          enable_merge_whitelist: true,
          merge_whitelist_usernames: ['admin'],
          block_on_official_review_requests: false,
          block_on_outdated_branch: false,
        },
        true
      );
    },
  };
}
