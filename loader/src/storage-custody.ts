/**
 * SeaweedFS S3 custody for the platform storage module (ADR-015 S-D1, S-D7).
 *
 * Trusted bootstrap - the loader's first start - generates the module's S3
 * service credentials, keeps them in one named OpenBao custody record, and
 * projects them into the one Secret only the SeaweedFS pod mounts. The module
 * reads that record with its own OpenBao role, keeps it in memory only, and
 * fails closed: no credentials means no store, never a default or an
 * anonymous attempt.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { PlatformPhaseError, type PlatformPhase } from './platform-bootstrap.js';

/** The one OpenBao KV v2 record the module's S3 credentials live in. */
export const STORAGE_CUSTODY_PATH = 'lifemodel/data/storage/seaweed';
/** The one bucket the module owns; Seaweed creates it on startup. */
export const STORAGE_BUCKET = 'lifemodel-storage';
/** The Seaweed identity name the module signs with. */
export const STORAGE_IDENTITY_NAME = 'storage-module';
/** The Secret only the SeaweedFS pod mounts, holding its S3 identity file. */
export const S3_IDENTITY_SECRET = 'seaweed-s3-identity';
export const S3_IDENTITY_KEY = 's3.json';

/**
 * The one way forward for an instance bootstrapped before this platform
 * version: its root token is retired, so the grant the loader's custody write
 * needs can never be provisioned, and there is no in-place upgrade.
 */
export const STORAGE_FRESH_INSTALL_ERROR =
  'this platform version needs a fresh installation for the storage module: OpenBao denies the Seaweed custody record and the root token is already retired, so an instance bootstrapped by an earlier platform version cannot be upgraded in place (reinstall this instance)';

/**
 * A denied custody record means an older platform, not a transient fault:
 * nothing in the loader can grant itself the missing policy in steady state.
 * Every other code is a real failure and keeps itself.
 */
export function storageCustodyDenied(error: unknown): never {
  if ((error as { code?: unknown }).code === 'denied')
    throw new PlatformPhaseError('storage-seaweed-custody', STORAGE_FRESH_INSTALL_ERROR);
  throw error;
}

export interface StorageS3Credentials {
  accessKey: string;
  secretKey: string;
}

export type StorageCustodyErrorCode =
  | 'sealed'
  | 'unreachable'
  | 'denied'
  | 'not_found'
  | 'invalid'
  | 'missing';

export class StorageCustodyError extends Error {
  constructor(readonly code: StorageCustodyErrorCode) {
    super(code);
    this.name = 'StorageCustodyError';
  }
}

const ACCESS_KEY = /^[A-Za-z0-9]{16,32}$/;
const SECRET_KEY = /^[A-Za-z0-9_-]{32,64}$/;

/**
 * The record's own shape, validated. A record that does not parse is an error,
 * never something to regenerate: SeaweedFS is already configured from it.
 */
export function parseStorageCredentials(value: unknown): StorageS3Credentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new StorageCustodyError('invalid');
  const record = value as Record<string, unknown>;
  // The record holds the two fields and nothing else: an unknown key is
  // another writer's idea of this record, not a version of it.
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'accessKey' || keys[1] !== 'secretKey')
    throw new StorageCustodyError('invalid');
  const accessKey = record['accessKey'];
  const secretKey = record['secretKey'];
  if (typeof accessKey !== 'string' || !ACCESS_KEY.test(accessKey))
    throw new StorageCustodyError('invalid');
  if (typeof secretKey !== 'string' || !SECRET_KEY.test(secretKey))
    throw new StorageCustodyError('invalid');
  return { accessKey, secretKey };
}

/** A fresh service identity: 80-bit key id, 240-bit secret, both hex/base64url. */
export function generateStorageCredentials(
  randomBytesOf: (size: number) => Buffer = (size) => randomBytes(size)
): StorageS3Credentials {
  return {
    accessKey: randomBytesOf(10).toString('hex').toUpperCase(),
    secretKey: randomBytesOf(30).toString('base64url'),
  };
}

/**
 * SeaweedFS's own S3 identity file (`-s3.config`), the narrowest form that
 * works: one identity, one bucket, no admin action, no group, no policy name.
 * Actions are bucket-scoped, so a key that leaks cannot read another bucket.
 */
export function renderS3IdentityConfig(credentials: StorageS3Credentials): string {
  return `${JSON.stringify(
    {
      identities: [
        {
          name: STORAGE_IDENTITY_NAME,
          credentials: [{ accessKey: credentials.accessKey, secretKey: credentials.secretKey }],
          actions: [`Read:${STORAGE_BUCKET}`, `Write:${STORAGE_BUCKET}`, `List:${STORAGE_BUCKET}`],
        },
      ],
    },
    null,
    2
  )}\n`;
}

/**
 * The one read of the custody record, from a KV v2 read: a destroyed or
 * deleted version is absent, a record of the wrong shape is an error, and
 * every other failure keeps its own code so the module can say why.
 */
export async function readCustodyRecord(
  call: (path: string, method?: string) => Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | null> {
  let result: Record<string, unknown>;
  try {
    result = await call(STORAGE_CUSTODY_PATH);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'not_found') return null;
    throw error;
  }
  const data = result['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new StorageCustodyError('unreachable');
  const entry = data as Record<string, unknown>;
  const metadata = entry['metadata'];
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    if (
      record['destroyed'] === true ||
      (typeof record['deletion_time'] === 'string' && record['deletion_time'] !== '')
    )
      return null;
  }
  const value = entry['data'];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new StorageCustodyError('invalid');
  return value as Record<string, unknown>;
}

/**
 * The module's read of its custody record: in memory only, refreshed at most
 * once per interval, and never served stale. A failed refresh is a failed
 * module, not a last-known credential.
 */
export interface CustodyReader {
  read(): Promise<StorageS3Credentials>;
  invalidate(): void;
}
export interface CustodyReaderOptions {
  now?: () => number;
  refreshMs?: number;
}
const DEFAULT_REFRESH_MS = 60_000;

function custodyError(error: unknown): StorageCustodyError {
  if (error instanceof StorageCustodyError) return error;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && ['sealed', 'unreachable', 'denied', 'not_found'].includes(code))
    return new StorageCustodyError(code as StorageCustodyErrorCode);
  return new StorageCustodyError('unreachable');
}

export function createCachedCustodyReader(
  readRecord: () => Promise<Record<string, unknown> | null>,
  options: CustodyReaderOptions = {}
): CustodyReader {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  let cached: { value: StorageS3Credentials; readAt: number } | undefined;
  let pending: Promise<StorageS3Credentials> | undefined;
  let generation = 0;

  async function refresh(): Promise<StorageS3Credentials> {
    const started = generation;
    let record: Record<string, unknown> | null;
    try {
      record = await readRecord();
    } catch (error) {
      throw custodyError(error);
    }
    if (record === null) throw new StorageCustodyError('missing');
    const value = parseStorageCredentials(record);
    if (generation === started) cached = { value, readAt: now() };
    return value;
  }

  return {
    invalidate() {
      cached = undefined;
      pending = undefined;
      generation++;
    },
    async read() {
      if (cached !== undefined && now() - cached.readAt < refreshMs) return cached.value;
      if (pending !== undefined) return pending;
      const active = refresh();
      pending = active;
      try {
        return await active;
      } finally {
        if (pending === active) pending = undefined;
      }
    },
  };
}

/**
 * The trusted-bootstrap phase: one durable record in OpenBao, projected into
 * the SeaweedFS S3 identity Secret. It reuses an existing record, so a restart
 * never rotates the credentials SeaweedFS was configured with.
 */
export interface StorageCustodyBao {
  read(): Promise<Record<string, unknown> | null>;
  write(value: StorageS3Credentials): Promise<void>;
}
export interface IdentitySecret {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}
export interface StorageCustodyPhaseDeps {
  bao: StorageCustodyBao;
  identity: IdentitySecret;
  generate?: () => StorageS3Credentials;
}
export function createStorageCustodyPhase(deps: StorageCustodyPhaseDeps): PlatformPhase {
  return {
    name: 'storage-seaweed-custody',
    run: async () => {
      let credentials: StorageS3Credentials;
      const existing = await deps.bao.read().catch(storageCustodyDenied);
      if (existing === null) {
        const generated = deps.generate?.() ?? generateStorageCredentials();
        credentials = parseStorageCredentials(generated);
        await deps.bao.write(credentials).catch(storageCustodyDenied);
        const saved = await deps.bao.read().catch(storageCustodyDenied);
        if (saved === null)
          throw new Error('OpenBao storage custody record is absent after its write');
        const verified = parseStorageCredentials(saved);
        if (
          verified.accessKey !== credentials.accessKey ||
          verified.secretKey !== credentials.secretKey
        )
          throw new Error('OpenBao storage custody read-back did not match the write');
      } else {
        credentials = parseStorageCredentials(existing);
      }
      const content = renderS3IdentityConfig(credentials);
      if ((await deps.identity.read()) !== content) await deps.identity.write(content);
      if ((await deps.identity.read()) !== content)
        throw new Error(
          'the SeaweedFS S3 identity Secret read-back did not match the custody record'
        );
    },
  };
}

interface KubernetesSecretOptions {
  apiServer?: string;
  namespace?: string;
  tokenFile?: string;
  caFile?: string;
  timeoutMs?: number;
  request?: (
    url: URL,
    method: string,
    token: string,
    body: string | undefined,
    ca: Buffer | undefined
  ) => Promise<{ status: number; body: string }>;
}
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/** A fixed-name API client: it reads and updates the one Seaweed identity Secret. */
export function createKubernetesS3IdentitySecret(
  options: KubernetesSecretOptions = {}
): IdentitySecret {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const namespace = options.namespace ?? 'lifemodel-system';
  const tokenFile = options.tokenFile ?? `${SERVICE_ACCOUNT}/token`;
  const caFile = options.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = new URL(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${S3_IDENTITY_SECRET}`,
    host
  );
  const customRequest = options.request;
  const call =
    customRequest ??
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
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        req.end(body);
      }));
  async function send(method: string, body?: unknown): Promise<{ status: number; body: string }> {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token === '') throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined;
    try {
      ca = await readFile(caFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (!customRequest) return call(url, method, token, payload, ca);
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Kubernetes API request exceeded ${String(timeoutMs)} ms`));
      }, timeoutMs);
      customRequest(url, method, token, payload, ca).then(
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }
  function decode(payload: string): { content: string | null; resourceVersion?: string } {
    const secret = JSON.parse(payload) as {
      data?: Record<string, string>;
      metadata?: { resourceVersion?: string };
    };
    const encoded = secret.data?.[S3_IDENTITY_KEY];
    const resourceVersion = secret.metadata?.resourceVersion;
    return {
      content: encoded === undefined ? null : Buffer.from(encoded, 'base64').toString('utf8'),
      ...(resourceVersion === undefined ? {} : { resourceVersion }),
    };
  }
  return {
    read: async () => {
      const response = await send('GET');
      if (response.status === 404) return null;
      if (response.status !== 200)
        throw new Error(`SeaweedFS S3 identity Secret read failed (${String(response.status)})`);
      return decode(response.body).content;
    },
    write: async (content) => {
      // Platform-created first: the loader updates this Secret and never creates it.
      const current = await send('GET');
      if (current.status !== 200)
        throw new Error(
          `SeaweedFS S3 identity Secret must be platform-created before the loader writes it (${String(current.status)})`
        );
      const { resourceVersion } = decode(current.body);
      if (resourceVersion === undefined)
        throw new Error('SeaweedFS S3 identity Secret has no resourceVersion');
      const body = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: S3_IDENTITY_SECRET,
          namespace,
          resourceVersion,
          annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
        },
        type: 'Opaque',
        data: { [S3_IDENTITY_KEY]: Buffer.from(content, 'utf8').toString('base64') },
      };
      const response = await send('PUT', body);
      if (response.status !== 200)
        throw new Error(`SeaweedFS S3 identity Secret update failed (${String(response.status)})`);
    },
  };
}
