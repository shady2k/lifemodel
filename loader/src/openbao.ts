/** Restart-safe OpenBao initialization and unseal custody (ADR-010 R7-02). */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { PlatformPhaseStore } from './platform-bootstrap.js';

export interface BaoKeys { keys: string[]; rootToken: string | null }
export interface BaoStatus { initialized: boolean; sealed: boolean }
export interface BaoApi {
  status(): Promise<BaoStatus>;
  init(): Promise<{ keys: string[]; rootToken: string }>;
  unseal(key: string): Promise<void>;
  rootTokenActive(rootToken: string): Promise<boolean>;
  ensureLoaderPolicy(rootToken: string): Promise<void>;
  revokeRootToken(rootToken: string): Promise<void>;
}
export interface BaoCustody { read(): Promise<BaoKeys | null>; write(value: BaoKeys): Promise<void> }
export interface OpenBaoBootstrapDeps {
  bao: BaoApi;
  custody: BaoCustody;
  runPhases(phases: Array<{ name: string; run(): Promise<void> }>): Promise<void>;
}

function assertKeys(value: BaoKeys | null): asserts value is BaoKeys {
  if (value === null || !Array.isArray(value.keys) || value.keys.length !== 1 || typeof value.keys[0] !== 'string' || value.keys[0] === '' || (value.rootToken !== null && (typeof value.rootToken !== 'string' || value.rootToken === ''))) {
    throw new Error('OpenBao is initialized but Secret openbao-unseal-custody is missing or invalid; restore its unseal key from recovery backup');
  }
}

/** One Shamir share, threshold one: the dedicated single-owner VM has one custodian. */
export function createOpenBaoBootstrap(deps: OpenBaoBootstrapDeps): {
  runInitial(): Promise<void>;
  unsealIfSealed(): Promise<void>;
} {
  const { bao, custody } = deps;
  const initialize = async (): Promise<void> => {
    const status = await bao.status();
    if (!status.initialized) {
      const result = await bao.init();
      if (result.keys.length !== 1 || result.keys[0] === undefined || result.keys[0] === '' || result.rootToken === '') throw new Error('OpenBao sys/init returned invalid 1-of-1 Shamir material');
      // Never use either credential until the Kubernetes Secret has been written and read back.
      await custody.write({ keys: result.keys, rootToken: result.rootToken });
    }
    const saved = await custody.read();
    assertKeys(saved);
  };
  const unseal = async (): Promise<void> => {
    const status = await bao.status();
    if (!status.initialized) throw new Error('OpenBao is not initialized after its init phase');
    if (!status.sealed) return;
    const saved = await custody.read();
    assertKeys(saved);
    await bao.unseal(saved.keys[0]!);
    if ((await bao.status()).sealed) throw new Error('OpenBao remains sealed after submitting its custody key');
  };
  const provisionAndRetire = async (): Promise<void> => {
    const saved = await custody.read();
    assertKeys(saved);
    if (saved.rootToken === null) return; // already retired on an earlier run
    // A crash can land after revoke-self but before the Secret update. Detect
    // that cut so a retry can remove the revoked token without using it again.
    if (await bao.rootTokenActive(saved.rootToken)) {
      await bao.ensureLoaderPolicy(saved.rootToken);
      await bao.revokeRootToken(saved.rootToken);
    }
    await custody.write({ keys: saved.keys, rootToken: null });
    const verified = await custody.read();
    assertKeys(verified);
    if (verified.rootToken !== null) throw new Error('OpenBao root token remains in custody Secret after retirement');
  };
  return {
    runInitial: () => deps.runPhases([
      { name: 'openbao-init', run: initialize },
      { name: 'openbao-unseal', run: unseal },
      { name: 'openbao-policy', run: provisionAndRetire },
    ]),
    unsealIfSealed: unseal,
  };
}

interface KubernetesSecretStoreOptions {
  apiServer?: string; namespace?: string; tokenFile?: string; caFile?: string;
  request?: (url: URL, method: string, token: string, body: string | undefined, ca: Buffer | undefined) => Promise<{ status: number; body: string }>;
}
const SECRET = 'openbao-unseal-custody';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Restricted client for the platform-created custody Secret; it cannot create or list Secrets. */
export function createKubernetesBaoCustody(options: KubernetesSecretStoreOptions = {}): BaoCustody {
  const host = options.apiServer ?? `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const namespace = options.namespace ?? 'lifemodel-system';
  const url = new URL(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${SECRET}`, host);
  const tokenFile = options.tokenFile ?? `${SA_DIR}/token`;
  const caFile = options.caFile ?? `${SA_DIR}/ca.crt`;
  const call = options.request ?? ((target, method, token, body, ca) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpsRequest(target, { method, ca, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) } }, (res) => {
      let response = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { response += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: response }));
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  }));
  async function send(method: string, body?: string): Promise<{ status: number; body: string }> {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined; try { ca = await readFile(caFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return call(url, method, token, body, ca);
  }
  async function decode(payload: string): Promise<{ secret: Record<string, unknown>; value: BaoKeys | null }> {
    const secret = JSON.parse(payload) as Record<string, unknown>;
    const data = secret['data'] as Record<string, string> | undefined;
    const encoded = data?.['custody'];
    const value = encoded === undefined ? null : JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as BaoKeys;
    return { secret, value };
  }
  return {
    read: async () => {
      const response = await send('GET');
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`Kubernetes custody Secret read failed (${response.status}): ${response.body}`);
      return (await decode(response.body)).value;
    },
    write: async (value) => {
      const current = await send('GET');
      if (current.status !== 200) throw new Error(`Kubernetes custody Secret must be platform-created before loader startup (${current.status}): ${current.body}`);
      const { secret } = await decode(current.body);
      const metadata = secret['metadata'] as Record<string, unknown> | undefined;
      if (typeof metadata?.['resourceVersion'] !== 'string') throw new Error('Kubernetes custody Secret has no resourceVersion');
      const payload = { apiVersion: 'v1', kind: 'Secret', metadata: { name: SECRET, namespace, resourceVersion: metadata['resourceVersion'] }, type: 'Opaque', data: { custody: Buffer.from(JSON.stringify(value)).toString('base64') } };
      const response = await send('PUT', JSON.stringify(payload));
      if (response.status !== 200) throw new Error(`Kubernetes custody Secret write failed (${response.status}): ${response.body}`);
      const verified = await send('GET');
      if (verified.status !== 200 || JSON.stringify((await decode(verified.body)).value) !== JSON.stringify(value)) throw new Error('Kubernetes custody Secret read-back did not match the write');
    },
  };
}

interface OpenBaoApiOptions { address: string; request?: (url: URL, method: string, token: string | undefined, body: string | undefined) => Promise<{ status: number; body: string }> }
/** OpenBao HTTP API client. The address is configuration, not a hard-coded route. */
export function createOpenBaoApi(options: OpenBaoApiOptions): BaoApi {
  const base = new URL(options.address);
  const call = options.request ?? ((url, method, token, body) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { method, headers: { ...(token === undefined ? {} : { 'x-vault-token': token }), ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) } }, (res) => {
      let response = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { response += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: response }));
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  }));
  async function api(path: string, method: string, token?: string, payload?: unknown): Promise<Record<string, unknown>> {
    const response = await call(new URL(`/v1/${path}`, base), method, token, payload === undefined ? undefined : JSON.stringify(payload));
    if (response.status < 200 || response.status >= 300) throw new Error(`OpenBao ${method} ${path} failed (${response.status}): ${response.body}`);
    return response.body ? JSON.parse(response.body) as Record<string, unknown> : {};
  }
  return {
    status: async () => {
      const data = await api('sys/seal-status', 'GET');
      return { initialized: data['initialized'] === true, sealed: data['sealed'] === true };
    },
    init: async () => {
      const response = await api('sys/init', 'POST', undefined, { secret_shares: 1, secret_threshold: 1 });
      const keys = (response['keys'] ?? response['keys_base64']) as unknown;
      if (!Array.isArray(keys) || typeof response['root_token'] !== 'string') throw new Error('OpenBao sys/init response has no key shares or root token');
      return { keys: keys as string[], rootToken: response['root_token'] };
    },
    unseal: async (key) => { await api('sys/unseal', 'POST', undefined, { key }); },
    rootTokenActive: async (rootToken) => {
      const response = await call(new URL('/v1/auth/token/lookup-self', base), 'GET', rootToken, undefined);
      if (response.status === 200) return true;
      if (response.status === 403) return false;
      throw new Error(`OpenBao GET auth/token/lookup-self failed (${response.status}): ${response.body}`);
    },
    ensureLoaderPolicy: async (rootToken) => {
      const policy = 'path "sys/seal-status" { capabilities = ["read"] }\npath "sys/unseal" { capabilities = ["update"] }';
      await api('sys/policies/acl/loader-bootstrap', 'PUT', rootToken, { policy });
      await api('auth/token/roles/loader-bootstrap', 'POST', rootToken, { allowed_policies: ['loader-bootstrap'], token_ttl: '1h', token_max_ttl: '24h' });
    },
    revokeRootToken: async (rootToken) => { await api('auth/token/revoke-self', 'POST', rootToken, {}); },
  };
}
