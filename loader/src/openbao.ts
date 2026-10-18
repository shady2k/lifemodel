/** Restart-safe OpenBao initialization and unseal custody (ADR-010 R7-02). */
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { ModelSlot } from './model.js';
import { createRoleBaoClient, BaoStorageError, type RoleBaoOptions } from './model-bao.js';

export interface BaoKeys {
  keys: string[];
  rootToken: string | null;
}
export interface BaoStatus {
  initialized: boolean;
  sealed: boolean;
}
export interface BaoApi {
  status(): Promise<BaoStatus>;
  init(): Promise<{ keys: string[]; rootToken: string }>;
  unseal(key: string): Promise<void>;
  rootTokenActive(rootToken: string): Promise<boolean>;
  ensureLoaderPolicy(rootToken: string): Promise<void>;
  login(): Promise<void>;
  ensureModelPolicy?(rootToken: string): Promise<void>;
  revokeRootToken(rootToken: string): Promise<void>;
  readModelSlot(slot: 'primary' | 'reserve'): Promise<ModelSlot | null>;
  writeModelSlot(slot: 'primary' | 'reserve', value: ModelSlot): Promise<void>;
  deleteModelReserve(): Promise<void>;
}
export interface BaoCustody {
  read(): Promise<BaoKeys | null>;
  write(value: BaoKeys): Promise<void>;
}
export interface OpenBaoBootstrapDeps {
  bao: BaoApi;
  custody: BaoCustody;
  runPhases(phases: { name: string; run(): Promise<void> }[]): Promise<void>;
  /** Later first-start work shares this durable phase plan and store. */
  extraPhases?: { name: string; run(): Promise<void> }[];
}

function assertKeys(value: BaoKeys | null): asserts value is BaoKeys {
  if (
    value === null ||
    !Array.isArray(value.keys) ||
    value.keys.length !== 1 ||
    typeof value.keys[0] !== 'string' ||
    value.keys[0] === '' ||
    (value.rootToken !== null && (typeof value.rootToken !== 'string' || value.rootToken === ''))
  ) {
    throw new Error(
      'OpenBao is initialized but Secret openbao-unseal-custody is missing or invalid; restore its unseal key from recovery backup'
    );
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
      if (
        result.keys.length !== 1 ||
        result.keys[0] === undefined ||
        result.keys[0] === '' ||
        result.rootToken === ''
      )
        throw new Error('OpenBao sys/init returned invalid 1-of-1 Shamir material');
      // Never use either credential until the Kubernetes Secret has been written and read back.
      await custody.write({ keys: result.keys, rootToken: result.rootToken });
    }
    const saved = await custody.read();
    assertKeys(saved);
  };
  const unseal = async (): Promise<void> => {
    const status = await bao.status();
    if (!status.initialized) throw new Error('OpenBao is not initialized after its init phase');
    // Custody is an independent readiness invariant, even while Bao is unsealed.
    const saved = await custody.read();
    assertKeys(saved);
    if (!status.sealed) return;
    const key = saved.keys[0];
    if (key === undefined) throw new Error('OpenBao custody Secret has no unseal key');
    await bao.unseal(key);
    if ((await bao.status()).sealed)
      throw new Error('OpenBao remains sealed after submitting its custody key');
  };
  const validateAndUnsealBeforeResume = async (): Promise<void> => {
    const status = await bao.status();
    if (!status.initialized) return;
    const saved = await custody.read();
    assertKeys(saved);
    if (status.sealed) await unseal();
    if (saved.rootToken === null) {
      await bao.login();
    }
  };
  const provisionAndRetire = async (): Promise<void> => {
    const saved = await custody.read();
    assertKeys(saved);
    if (saved.rootToken === null) {
      await bao.login();
      return; // root already retired; restore the steady-state identity
    }
    // A crash can land after revoke-self but before the Secret update. Detect
    // that cut so a retry can remove the revoked token without using it again.
    if (await bao.rootTokenActive(saved.rootToken)) {
      await bao.ensureLoaderPolicy(saved.rootToken);
      if (bao.ensureModelPolicy === undefined)
        throw new Error('OpenBao model policy provisioner is unavailable');
      await bao.ensureModelPolicy(saved.rootToken);
      await bao.revokeRootToken(saved.rootToken);
    }
    if (!(await bao.rootTokenActive(saved.rootToken))) await bao.login();
    await custody.write({ keys: saved.keys, rootToken: null });
    const verified = await custody.read();
    assertKeys(verified);
    if (verified.rootToken !== null)
      throw new Error('OpenBao root token remains in custody Secret after retirement');
  };
  return {
    runInitial: async () => {
      await validateAndUnsealBeforeResume();
      await deps.runPhases([
        { name: 'openbao-init', run: initialize },
        { name: 'openbao-unseal', run: unseal },
        { name: 'openbao-policy', run: provisionAndRetire },
        ...(deps.extraPhases ?? []),
      ]);
    },
    unsealIfSealed: unseal,
  };
}

interface KubernetesSecretStoreOptions {
  apiServer?: string;
  namespace?: string;
  tokenFile?: string;
  caFile?: string;
  request?: (
    url: URL,
    method: string,
    token: string,
    body: string | undefined,
    ca: Buffer | undefined
  ) => Promise<{ status: number; body: string }>;
  timeoutMs?: number;
}
const SECRET = 'openbao-unseal-custody';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Restricted client for the platform-created custody Secret; it cannot create or list Secrets. */
export function createKubernetesBaoCustody(options: KubernetesSecretStoreOptions = {}): BaoCustody {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const namespace = options.namespace ?? 'lifemodel-system';
  const url = new URL(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${SECRET}`,
    host
  );
  const tokenFile = options.tokenFile ?? `${SA_DIR}/token`;
  const caFile = options.caFile ?? `${SA_DIR}/ca.crt`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const call =
    options.request ??
    ((target, method, token, body, ca) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpsRequest(
          target,
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
            res.on('data', (chunk: string) => {
              response += chunk;
            });
            res.on('end', () => {
              clearTimeout(timer);
              resolve({ status: res.statusCode ?? 0, body: response });
            });
            res.on('aborted', () => {
              clearTimeout(timer);
              reject(new Error('Kubernetes API response was truncated'));
            });
          }
        );
        const timer = setTimeout(
          () => req.destroy(new Error(`Kubernetes API request exceeded ${String(timeoutMs)} ms`)),
          timeoutMs
        );
        req.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        if (body !== undefined) req.write(body);
        req.end();
      }));
  async function send(method: string, body?: string): Promise<{ status: number; body: string }> {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined;
    try {
      ca = await readFile(caFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return call(url, method, token, body, ca);
  }
  function decode(payload: string): { secret: Record<string, unknown>; value: BaoKeys | null } {
    const secret = JSON.parse(payload) as Record<string, unknown>;
    const data = secret['data'] as Record<string, string> | undefined;
    const encoded = data?.['custody'];
    const value =
      encoded === undefined
        ? null
        : (JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as BaoKeys);
    return { secret, value };
  }
  return {
    read: async () => {
      const response = await send('GET');
      if (response.status === 404) return null;
      if (response.status !== 200)
        throw new Error(
          `Kubernetes custody Secret read failed (${String(response.status)}): ${response.body}`
        );
      return decode(response.body).value;
    },
    write: async (value) => {
      const current = await send('GET');
      if (current.status !== 200)
        throw new Error(
          `Kubernetes custody Secret must be platform-created before loader startup (${String(current.status)}): ${current.body}`
        );
      const { secret } = decode(current.body);
      const metadata = secret['metadata'] as Record<string, unknown> | undefined;
      if (typeof metadata?.['resourceVersion'] !== 'string')
        throw new Error('Kubernetes custody Secret has no resourceVersion');
      const payload = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          ...metadata,
          name: SECRET,
          namespace,
          resourceVersion: metadata['resourceVersion'],
        },
        type: 'Opaque',
        data: { custody: Buffer.from(JSON.stringify(value)).toString('base64') },
      };
      const response = await send('PUT', JSON.stringify(payload));
      if (response.status !== 200)
        throw new Error(
          `Kubernetes custody Secret write failed (${String(response.status)}): ${response.body}`
        );
      const verified = await send('GET');
      if (
        verified.status !== 200 ||
        JSON.stringify(decode(verified.body).value) !== JSON.stringify(value)
      )
        throw new Error('Kubernetes custody Secret read-back did not match the write');
    },
  };
}

/** Bootstrap operations and model routes share this one workload client. */
export function createOpenBaoApi(
  options: Omit<RoleBaoOptions, 'role'> & { role: 'loader' }
): BaoApi {
  const client = createRoleBaoClient(options);
  // Every request states its identity: the workload token, an explicit root
  // token, or none at all. No default, so no call can borrow the wrong one.
  const asRole = (path: string, method: string, payload?: unknown) =>
    client.call(path, method, payload);
  const asAnonymous = (path: string, method: string, payload?: unknown) =>
    client.call(path, method, payload, { anonymous: true });
  const asToken = (token: string, path: string, method: string, payload?: unknown) =>
    client.call(path, method, payload, { token });
  return {
    status: async () => {
      const data = await asAnonymous('sys/seal-status', 'GET');
      return { initialized: data['initialized'] === true, sealed: data['sealed'] === true };
    },
    init: async () => {
      const response = await asAnonymous('sys/init', 'POST', {
        secret_shares: 1,
        secret_threshold: 1,
      });
      const keys = response['keys'] ?? response['keys_base64'];
      if (!Array.isArray(keys) || typeof response['root_token'] !== 'string')
        throw new Error('OpenBao sys/init response has no key shares or root token');
      return { keys: keys as string[], rootToken: response['root_token'] };
    },
    unseal: async (key) => {
      await asAnonymous('sys/unseal', 'POST', { key });
    },
    rootTokenActive: async (rootToken) => {
      try {
        await asToken(rootToken, 'auth/token/lookup-self', 'GET');
        return true;
      } catch (error) {
        if (error instanceof BaoStorageError && error.code === 'denied') return false;
        throw error;
      }
    },
    ensureLoaderPolicy: async (rootToken) => {
      const policy =
        'path "sys/seal-status" { capabilities = ["read"] }\npath "sys/unseal" { capabilities = ["update"] }';
      await asToken(rootToken, 'sys/policies/acl/loader', 'PUT', { policy });
      const mounts = await asToken(rootToken, 'sys/auth', 'GET');
      const auth = mounts['kubernetes/'];
      if (auth === undefined)
        await asToken(rootToken, 'sys/auth/kubernetes', 'POST', { type: 'kubernetes' });
      // OpenBao uses its own pod ServiceAccount token for TokenReview when
      // token_reviewer_jwt is omitted (https://openbao.org/docs/auth/kubernetes/).
      await asToken(rootToken, 'auth/kubernetes/config', 'POST', {
        kubernetes_host: 'https://kubernetes.default.svc:443',
      });
      await asToken(rootToken, 'auth/kubernetes/role/loader', 'POST', {
        bound_service_account_names: ['loader'],
        bound_service_account_namespaces: ['lifemodel-system'],
        policies: ['loader'],
        ttl: '1h',
      });
      await client.login();
      const capabilities = await asRole('sys/capabilities-self', 'POST', {
        paths: ['sys/seal-status', 'sys/unseal', 'sys/init'],
      });
      const result = capabilities['sys/seal-status'] as string[] | undefined;
      const unseal = capabilities['sys/unseal'] as string[] | undefined;
      const init = capabilities['sys/init'] as string[] | undefined;
      if (
        !result?.includes('read') ||
        !unseal?.includes('update') ||
        init?.length !== 1 ||
        init[0] !== 'deny'
      ) {
        throw new Error(
          'OpenBao Kubernetes loader login did not have the expected minimal permitted and denied capabilities'
        );
      }
    },
    login: client.login,
    ensureModelPolicy: async (rootToken) => {
      const mounts = await asToken(rootToken, 'sys/mounts', 'GET');
      if (mounts['lifemodel/'] === undefined) {
        await asToken(rootToken, 'sys/mounts/lifemodel', 'POST', {
          type: 'kv',
          options: { version: '2' },
        });
      } else {
        const mount = mounts['lifemodel/'] as Record<string, unknown>;
        const options = mount['options'] as Record<string, unknown> | undefined;
        if (mount['type'] !== 'kv' || options?.['version'] !== '2')
          throw new Error('OpenBao lifemodel mount is not KV v2');
      }
      const policy =
        'path "lifemodel/data/model/*" { capabilities = ["create", "update", "read"] }\npath "lifemodel/data/model/reserve" { capabilities = ["create", "update", "read", "delete"] }\npath "lifemodel/metadata/model/*" { capabilities = ["read"] }';
      await asToken(rootToken, 'sys/policies/acl/loader-model', 'PUT', { policy });
      await asToken(rootToken, 'auth/kubernetes/role/loader', 'POST', {
        bound_service_account_names: ['loader'],
        bound_service_account_namespaces: ['lifemodel-system'],
        policies: ['loader', 'loader-model'],
        ttl: '1h',
      });
      await client.login();
      const capabilities = await asRole('sys/capabilities-self', 'POST', {
        paths: [
          'lifemodel/data/model/primary',
          'lifemodel/data/model/reserve',
          'lifemodel/metadata/model/primary',
          'lifemodel/metadata/model/reserve',
        ],
      });
      const primary = capabilities['lifemodel/data/model/primary'] as string[] | undefined;
      const reserve = capabilities['lifemodel/data/model/reserve'] as string[] | undefined;
      const metadata = capabilities['lifemodel/metadata/model/reserve'] as string[] | undefined;
      const primaryMetadata = capabilities['lifemodel/metadata/model/primary'] as
        | string[]
        | undefined;
      if (
        !primary?.includes('create') ||
        !primary.includes('update') ||
        !primary.includes('read') ||
        primary.includes('delete') ||
        reserve?.includes('delete') !== true ||
        !metadata?.includes('read') ||
        !primaryMetadata?.includes('read')
      )
        throw new Error('OpenBao loader-model login did not have expected model capabilities');
    },
    readModelSlot: client.readSlot,
    writeModelSlot: client.writeSlot,
    deleteModelReserve: client.deleteReserve,
    revokeRootToken: async (rootToken) => {
      await asToken(rootToken, 'auth/token/revoke-self', 'POST', {});
    },
  };
}
