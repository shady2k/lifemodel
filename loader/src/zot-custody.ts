/** Registry bootstrap credentials: OpenBao owns the password; Zot gets only bcrypt. */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { compare, hash } from 'bcryptjs';
import type { PlatformPhase } from './platform-bootstrap.js';

export const ZOT_CUSTODY_PATH = 'lifemodel/data/registry/zot';
export const ZOT_IDENTITY_SECRET = 'zot-htpasswd';
export const ZOT_IDENTITY_KEY = 'htpasswd';

export interface ZotCredential {
  username: 'loader';
  password: string;
}
export type ZotCustodyErrorCode =
  | 'sealed'
  | 'unreachable'
  | 'denied'
  | 'not_found'
  | 'invalid'
  | 'missing'
  | 'mismatch'
  | 'conflict'
  | 'timeout'
  | 'response_too_large';

/** Codes only: upstream messages and bodies may contain credentials or tokens. */
export class ZotCustodyError extends Error {
  constructor(readonly code: ZotCustodyErrorCode) {
    super(code);
    this.name = 'ZotCustodyError';
  }
}

export function parseZotCredential(value: unknown): ZotCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ZotCustodyError('invalid');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'password' ||
    keys[1] !== 'username' ||
    record['username'] !== 'loader' ||
    typeof record['password'] !== 'string' ||
    record['password'].length !== 43 ||
    !/^[A-Za-z0-9_-]{43}$/.test(record['password'])
  )
    throw new ZotCustodyError('invalid');
  return { username: 'loader', password: record['password'] };
}

function safeError(error: unknown): ZotCustodyError {
  if (error instanceof ZotCustodyError) return error;
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'sealed' || code === 'denied' || code === 'not_found')
    return new ZotCustodyError(code);
  return new ZotCustodyError('unreachable');
}

export interface ZotIdentitySecret {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}
export interface ZotCustodyPhaseDeps {
  bao: {
    read(): Promise<Record<string, unknown> | null>;
    write(value: ZotCredential): Promise<void>;
  };
  identity: ZotIdentitySecret;
}

/** Limit accepted bcrypt cost, so a corrupt Secret cannot force unbounded CPU. */
async function matchesIdentity(content: string | null, password: string): Promise<boolean> {
  if (content === null) return false;
  const match = /^loader:(\$2[aby]\$12\$[./A-Za-z0-9]{53})\n?$/.exec(content);
  if (match?.[0] !== content || match[1] === undefined) return false;
  return compare(password, match[1]);
}

/** Durable write and readback precede every Secret effect; replay never rotates. */
export function createZotCustodyPhase(deps: ZotCustodyPhaseDeps): PlatformPhase {
  return {
    name: 'zot-custody',
    async run() {
      try {
        const existing = await deps.bao.read();
        let credential: ZotCredential;
        if (existing === null) {
          credential = parseZotCredential({
            username: 'loader',
            password: randomBytes(32).toString('base64url'),
          });
          await deps.bao.write(credential);
          const saved = await deps.bao.read();
          if (saved === null) throw new ZotCustodyError('missing');
          const verified = parseZotCredential(saved);
          if (verified.password !== credential.password) throw new ZotCustodyError('mismatch');
        } else {
          // An invalid record is not absence. Never regenerate over it.
          credential = parseZotCredential(existing);
        }
        const current = await deps.identity.read();
        if (await matchesIdentity(current, credential.password)) return;
        const content = `loader:${await hash(credential.password, 12)}\n`;
        await deps.identity.write(content);
        if ((await deps.identity.read()) !== content) throw new ZotCustodyError('mismatch');
      } catch (error) {
        throw safeError(error);
      }
    },
  };
}

interface KubernetesZotSecretOptions {
  apiServer?: string;
  namespace?: string;
  tokenFile?: string;
  caFile?: string;
  /** May lower the deadline for tests; never increases the production bound. */
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
const MAX_RESPONSE_BYTES = 1024 * 1024;

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new ZotCustodyError('timeout');
}

/** One fixed-name GET/PUT client. The platform, never the loader, creates the Secret. */
export function createKubernetesZotIdentitySecret(
  options: KubernetesZotSecretOptions = {}
): ZotIdentitySecret {
  const namespace = options.namespace ?? 'lifemodel-system';
  const tokenFile = options.tokenFile ?? `${SERVICE_ACCOUNT}/token`;
  const caFile = options.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`;
  const requestedTimeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)
    throw new ZotCustodyError('invalid');
  const timeoutMs = Math.min(requestedTimeout, 10_000);
  let url: URL;
  try {
    const host =
      options.apiServer ??
      `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
    url = new URL(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${ZOT_IDENTITY_SECRET}`,
      host
    );
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
      throw new ZotCustodyError('invalid');
  } catch {
    throw new ZotCustodyError('invalid');
  }

  async function bounded<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ZotCustodyError('timeout'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([action(controller.signal), deadline]);
    } catch (error) {
      if (controller.signal.aborted) throw new ZotCustodyError('timeout');
      throw safeError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(
    signal: AbortSignal,
    method: string,
    body?: unknown
  ): Promise<{ status: number; body: string }> {
    assertActive(signal);
    const token = (await readFile(tokenFile, { encoding: 'utf8', signal })).trim();
    assertActive(signal);
    if (token === '') throw new ZotCustodyError('invalid');
    // The cluster CA is required. Never fall back to a different trust store.
    const ca = await readFile(caFile, { signal });
    assertActive(signal);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = options.request
      ? await options.request(url, method, token, payload, ca)
      : await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = httpsRequest(
            url,
            {
              method,
              ca,
              signal,
              headers: {
                authorization: `Bearer ${token}`,
                ...(payload === undefined
                  ? {}
                  : {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(payload),
                    }),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              res.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                  const error = new ZotCustodyError('response_too_large');
                  reject(error);
                  res.destroy();
                  req.destroy();
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8'),
                });
              });
              res.on('error', () => {
                reject(new ZotCustodyError('unreachable'));
              });
              res.on('aborted', () => {
                reject(new ZotCustodyError('unreachable'));
              });
            }
          );
          req.on('error', (error) => {
            reject(safeError(error));
          });
          req.end(payload);
        });
    assertActive(signal);
    if (typeof response.body !== 'string') throw new ZotCustodyError('invalid');
    if (Buffer.byteLength(response.body, 'utf8') > MAX_RESPONSE_BYTES)
      throw new ZotCustodyError('response_too_large');
    return response;
  }

  function checkStatus(status: number): void {
    if (status === 200) return;
    if (status === 403 || status === 401) throw new ZotCustodyError('denied');
    if (status === 404) throw new ZotCustodyError('not_found');
    if (status === 409) throw new ZotCustodyError('conflict');
    throw new ZotCustodyError('unreachable');
  }

  function decode(payload: string): { content: string | null; resourceVersion?: string } {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      throw new ZotCustodyError('invalid');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new ZotCustodyError('invalid');
    const secret = value as Record<string, unknown>;
    let resourceVersion: string | undefined;
    if (secret['metadata'] !== undefined) {
      const metadata = secret['metadata'];
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
        throw new ZotCustodyError('invalid');
      const version = (metadata as Record<string, unknown>)['resourceVersion'];
      if (version !== undefined && (typeof version !== 'string' || version === ''))
        throw new ZotCustodyError('invalid');
      resourceVersion = version;
    }
    let content: string | null = null;
    if (secret['data'] !== undefined) {
      const data = secret['data'];
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new ZotCustodyError('invalid');
      const encoded = (data as Record<string, unknown>)[ZOT_IDENTITY_KEY];
      if (encoded !== undefined) {
        if (
          typeof encoded !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        )
          throw new ZotCustodyError('invalid');
        const decoded = Buffer.from(encoded, 'base64');
        if (decoded.toString('base64') !== encoded) throw new ZotCustodyError('invalid');
        content = decoded.toString('utf8');
      }
    }
    return { content, ...(resourceVersion === undefined ? {} : { resourceVersion }) };
  }

  return {
    read: () =>
      bounded(async (signal) => {
        const response = await send(signal, 'GET');
        checkStatus(response.status);
        return decode(response.body).content;
      }),
    write: (content) =>
      bounded(async (signal) => {
        const current = await send(signal, 'GET');
        checkStatus(current.status);
        const { resourceVersion } = decode(current.body);
        if (resourceVersion === undefined) throw new ZotCustodyError('invalid');
        assertActive(signal);
        const response = await send(signal, 'PUT', {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: ZOT_IDENTITY_SECRET,
            namespace,
            resourceVersion,
            annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
          },
          type: 'Opaque',
          data: { [ZOT_IDENTITY_KEY]: Buffer.from(content, 'utf8').toString('base64') },
        });
        checkStatus(response.status);
      }),
  };
}
