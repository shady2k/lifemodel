/** Restart-safe OpenBao initialization and unseal custody (ADR-010 R7-02). */
import { request as httpsRequest } from 'node:https';
import { ZOT_CUSTODY_PATH, type ZotCredential } from './zot-custody.js';
import { readFile } from 'node:fs/promises';
import type { ModelSlot } from './model.js';
import { createRoleBaoClient, BaoStorageError, type RoleBaoOptions } from './model-bao.js';
import {
  readCustodyRecord,
  storageCustodyDenied,
  STORAGE_CUSTODY_PATH,
  type StorageS3Credentials,
} from './storage-custody.js';

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
  /** The storage module's read-only identity and the loader's custody write (ADR-015 S-D1). */
  ensureStoragePolicy(rootToken: string): Promise<void>;
  ensureRegistryPolicy(rootToken: string): Promise<void>;
  readRegistryCustody(): Promise<Record<string, unknown> | null>;
  writeRegistryCustody(value: ZotCredential): Promise<void>;
  /** The SeaweedFS S3 custody record, or null when it does not exist yet. */
  readStorageCustody(): Promise<Record<string, unknown> | null>;
  writeStorageCustody(value: StorageS3Credentials): Promise<void>;
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
  /**
   * The steady-state loader writes the Seaweed custody record with its own
   * grant (policy `loader-storage`, ADR-015 S-D1). An instance bootstrapped by
   * an earlier platform version never received that grant and cannot be given
   * it: provisioning needs the root token, which is already retired. There is
   * no upgrade path, so this names the one way forward instead of retrying a
   * bare denial for the life of the deployment.
   */
  const assertStorageCustodyGrant = async (): Promise<void> => {
    // An absent record is a current installation whose phase has not run yet.
    await bao.readStorageCustody().catch(storageCustodyDenied);
  };
  const validateAndUnsealBeforeResume = async (): Promise<void> => {
    const status = await bao.status();
    if (!status.initialized) return;
    const saved = await custody.read();
    assertKeys(saved);
    if (status.sealed) await unseal();
    if (saved.rootToken === null) {
      await assertStorageCustodyGrant();
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
      await bao.ensureStoragePolicy(saved.rootToken);
      await bao.ensureRegistryPolicy(saved.rootToken);
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

  interface ServiceIdentity {
    /** The policy, the Kubernetes-auth role and the ServiceAccount name. */
    role: string;
    /** The exact policy text; nothing is added to it. */
    policy: string;
    /** Paths the policy must grant `read` on, and nothing more. */
    verify: readonly string[];
    /** Paths it must not reach at all. */
    deny: readonly string[];
    /** How the failure messages name the holder, e.g. "the gateway". */
    holder: string;
  }
  /**
   * A platform service's own identity, provisioned beside `loader-model` and
   * verified before the root token is retired (ADR-013 D3, ADR-015 S-D1).
   *
   * Each service logs in with its own ServiceAccount, so it holds one
   * read-only policy and nothing else. Its Kubernetes-auth login needs the
   * service's projected JWT, which the loader does not have: the policy is
   * therefore checked through a bounded token that carries that policy alone,
   * and the role's binding to the ServiceAccount is checked by reading the
   * role back. Policy and role writes repeat safely. Token creation is not
   * idempotent: a lost response can leave a parented, nonrenewable token alive
   * until its 60s TTL or root retirement.
   */
  const ensureServiceIdentity = async (
    rootToken: string,
    identity: ServiceIdentity
  ): Promise<void> => {
    await asToken(rootToken, `sys/policies/acl/${identity.role}`, 'PUT', {
      policy: identity.policy,
    });
    await asToken(rootToken, `auth/kubernetes/role/${identity.role}`, 'POST', {
      bound_service_account_names: [identity.role],
      bound_service_account_namespaces: ['lifemodel-system'],
      policies: [identity.role],
      token_no_default_policy: true,
      ttl: '1h',
    });
    const response = await asToken(rootToken, `auth/kubernetes/role/${identity.role}`, 'GET');
    const recorded = response['data'];
    if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded))
      throw new Error(`OpenBao ${identity.role} role response has no data object`);
    const role = recorded as Record<string, unknown>;
    const serviceAccounts = role['bound_service_account_names'];
    const namespaces = role['bound_service_account_namespaces'];
    const policies = role['policies'];
    if (
      !Array.isArray(serviceAccounts) ||
      serviceAccounts.length !== 1 ||
      serviceAccounts[0] !== identity.role ||
      !Array.isArray(namespaces) ||
      namespaces.length !== 1 ||
      namespaces[0] !== 'lifemodel-system' ||
      !Array.isArray(policies) ||
      policies.length !== 1 ||
      policies[0] !== identity.role ||
      role['token_no_default_policy'] !== true
    )
      throw new Error(
        `OpenBao ${identity.role} role is not bound to ${identity.holder} ServiceAccount alone`
      );
    const minted = await asToken(rootToken, 'auth/token/create', 'POST', {
      policies: [identity.role],
      ttl: '60s',
      renewable: false,
      no_default_policy: true,
    });
    const auth = minted['auth'] as Record<string, unknown> | undefined;
    const verificationToken = auth?.['client_token'];
    if (typeof verificationToken !== 'string' || verificationToken === '')
      throw new Error(`OpenBao issued no token for the ${identity.role} capability check`);
    try {
      const tokenPolicies = auth?.['policies'];
      if (
        !Array.isArray(tokenPolicies) ||
        tokenPolicies.length !== 1 ||
        tokenPolicies[0] !== identity.role
      )
        throw new Error(`OpenBao verification token must carry the ${identity.role} policy alone`);
      const capabilities = await asToken(rootToken, 'sys/capabilities', 'POST', {
        token: verificationToken,
        paths: [...identity.verify, ...identity.deny],
      });
      for (const path of identity.verify) {
        const granted = capabilities[path];
        if (!Array.isArray(granted) || granted.length !== 1 || granted[0] !== 'read')
          throw new Error(
            `OpenBao ${identity.role} policy does not grant read on ${path} and nothing more`
          );
      }
      for (const path of identity.deny) {
        const granted = capabilities[path];
        if (!Array.isArray(granted) || granted.length !== 1 || granted[0] !== 'deny')
          throw new Error(
            `OpenBao ${identity.role} policy reaches beyond the paths ${identity.holder} reads`
          );
      }
    } finally {
      // The check's token is bounded anyway; revoke it so no credential outlives the check.
      await asToken(rootToken, 'auth/token/revoke', 'POST', { token: verificationToken });
    }
  };
  /** The model gateway reads the model slots and nothing else (ADR-013 D3). */
  const ensureModelGatewayIdentity = async (rootToken: string): Promise<void> =>
    ensureServiceIdentity(rootToken, {
      role: 'model-gateway',
      policy: 'path "lifemodel/data/model/*" { capabilities = ["read"] }',
      verify: ['lifemodel/data/model/primary', 'lifemodel/data/model/reserve'],
      deny: ['lifemodel/metadata/model/primary'],
      holder: 'the gateway',
    });
  /** The storage module reads the one SeaweedFS custody record (ADR-015 S-D1). */
  const ensureStorageModuleIdentity = async (rootToken: string): Promise<void> =>
    ensureServiceIdentity(rootToken, {
      role: 'storage-module',
      policy: `path "${STORAGE_CUSTODY_PATH}" { capabilities = ["read"] }`,
      verify: [STORAGE_CUSTODY_PATH],
      deny: ['lifemodel/data/model/primary'],
      holder: 'the storage module',
    });
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
      await ensureModelGatewayIdentity(rootToken);
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
    ensureStoragePolicy: async (rootToken) => {
      // The loader writes the custody record; the module only reads it.
      const policy = `path "${STORAGE_CUSTODY_PATH}" { capabilities = ["create", "update", "read"] }`;
      await asToken(rootToken, 'sys/policies/acl/loader-storage', 'PUT', { policy });
      await asToken(rootToken, 'auth/kubernetes/role/loader', 'POST', {
        bound_service_account_names: ['loader'],
        bound_service_account_namespaces: ['lifemodel-system'],
        policies: ['loader', 'loader-model', 'loader-storage'],
        ttl: '1h',
      });
      // The storage path joins the live loader token only through a fresh login.
      await client.login();
      const capabilities = await asRole('sys/capabilities-self', 'POST', {
        paths: [STORAGE_CUSTODY_PATH, 'lifemodel/data/model/primary'],
      });
      const custody = capabilities[STORAGE_CUSTODY_PATH];
      const model = capabilities['lifemodel/data/model/primary'];
      if (
        !Array.isArray(custody) ||
        !custody.includes('create') ||
        !custody.includes('update') ||
        !custody.includes('read') ||
        custody.includes('delete')
      )
        throw new Error(
          'OpenBao loader-storage login did not have create, update and read on the custody record'
        );
      if (!Array.isArray(model) || !model.includes('read'))
        throw new Error('OpenBao loader login lost its model-slot rights');
      await ensureStorageModuleIdentity(rootToken);
    },
    ensureRegistryPolicy: async (rootToken) => {
      const policy = `path "${ZOT_CUSTODY_PATH}" { capabilities = ["create", "update", "read"] }`;
      await asToken(rootToken, 'sys/policies/acl/loader-registry', 'PUT', { policy });
      await asToken(rootToken, 'auth/kubernetes/role/loader', 'POST', {
        bound_service_account_names: ['loader'],
        bound_service_account_namespaces: ['lifemodel-system'],
        policies: ['loader', 'loader-model', 'loader-storage', 'loader-registry'],
        ttl: '1h',
      });
      await client.login();
      const capabilities = await asRole('sys/capabilities-self', 'POST', {
        paths: [ZOT_CUSTODY_PATH],
      });
      const granted = capabilities[ZOT_CUSTODY_PATH];
      if (
        !Array.isArray(granted) ||
        granted.length !== 3 ||
        !['create', 'update', 'read'].every((capability) => granted.includes(capability))
      )
        throw new Error('zot_policy_denied');
    },
    readRegistryCustody: async () => {
      let result: Record<string, unknown>;
      try {
        result = await asRole(ZOT_CUSTODY_PATH, 'GET');
      } catch (error) {
        if (error instanceof BaoStorageError && error.code === 'not_found') return null;
        throw new Error('zot_custody_unavailable');
      }
      const data = result['data'];
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('zot_custody_invalid');
      const entry = data as Record<string, unknown>;
      const metadata = entry['metadata'] as Record<string, unknown> | undefined;
      if (
        metadata?.['destroyed'] === true ||
        (typeof metadata?.['deletion_time'] === 'string' && metadata['deletion_time'] !== '')
      )
        return null;
      const value = entry['data'];
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('zot_custody_invalid');
      return value as Record<string, unknown>;
    },
    writeRegistryCustody: async (value) => {
      try {
        await asRole(ZOT_CUSTODY_PATH, 'POST', { data: value });
      } catch {
        throw new Error('zot_custody_unavailable');
      }
    },
    readStorageCustody: async () =>
      readCustodyRecord((path, method) => asRole(path, method ?? 'GET')),
    writeStorageCustody: async (value) => {
      await asRole(STORAGE_CUSTODY_PATH, 'POST', { data: value });
    },
    readModelSlot: async (slot) => {
      const read = await client.readSlot(slot);
      return read.state === 'present' ? read.slot : null;
    },
    writeModelSlot: client.writeSlot,
    deleteModelReserve: client.deleteReserve,
    revokeRootToken: async (rootToken) => {
      await asToken(rootToken, 'auth/token/revoke-self', 'POST', {});
    },
  };
}
