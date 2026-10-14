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
