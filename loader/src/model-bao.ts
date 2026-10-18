/** Shared in-memory Kubernetes-auth client and model-slot reader (ADR-013 D3). */
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ModelSlot, ModelSlotName } from './model.js';

export type BaoErrorCode = 'sealed' | 'unreachable' | 'denied' | 'not_found';
export class BaoStorageError extends Error {
  constructor(readonly code: BaoErrorCode) {
    super(code);
    this.name = 'BaoStorageError';
  }
}
export interface RoleBaoOptions {
  address: string;
  role: 'loader' | 'model-gateway';
  jwtFile?: string;
  readJwt?: () => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
  logger?: { error(fields: Record<string, unknown>, message: string): void };
  request?: (
    url: URL,
    method: string,
    token: string | undefined,
    body: string | undefined
  ) => Promise<{ status: number; body: string }>;
}
/** Explicit root/anonymous requests never borrow or refresh the workload identity. */
export type BaoAuth = { token: string } | { anonymous: true };
export function createRoleBaoClient(options: RoleBaoOptions) {
  const base = new URL(options.address);
  const now = options.now ?? Date.now;
  const readJwt =
    options.readJwt ??
    (() =>
      readFile(options.jwtFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'));
  const timeoutMs = options.timeoutMs ?? 10_000;
  let token: string | undefined;
  let expiresAt = 0;
  let refreshAt = 0;
  let renewable = false;
  let authentication: Promise<void> | undefined;
  let loginGeneration = 0;
  const transport =
    options.request ??
    ((url, method, activeToken, body) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = request(
          url,
          {
            method,
            headers: {
              ...(activeToken === undefined ? {} : { 'x-vault-token': activeToken }),
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            let response = '',
              size = 0;
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              size += Buffer.byteLength(chunk);
              if (size > 1024 * 1024) {
                req.destroy(new BaoStorageError('unreachable'));
                return;
              }
              response += chunk;
            });
            res.on('end', () => {
              clearTimeout(timer);
              resolve({ status: res.statusCode ?? 0, body: response });
            });
            res.on('aborted', () => {
              clearTimeout(timer);
              reject(new BaoStorageError('unreachable'));
            });
            res.on('error', () => {
              clearTimeout(timer);
              reject(new BaoStorageError('unreachable'));
            });
          }
        );
        const timer = setTimeout(() => req.destroy(new BaoStorageError('unreachable')), timeoutMs);
        req.on('error', () => {
          clearTimeout(timer);
          reject(new BaoStorageError('unreachable'));
        });
        req.end(body);
      }));
  function failure(code: BaoErrorCode): BaoStorageError {
    options.logger?.error({ code }, 'OpenBao request failed');
    return new BaoStorageError(code);
  }
  async function send(
    path: string,
    method: string,
    activeToken?: string,
    payload?: unknown
  ): Promise<Record<string, unknown>> {
    try {
      const response = await transport(
        new URL(`/v1/${path}`, base),
        method,
        activeToken,
        payload === undefined ? undefined : JSON.stringify(payload)
      );
      if (response.status < 200 || response.status >= 300) {
        const code: BaoErrorCode =
          response.status === 401 || response.status === 403
            ? 'denied'
            : response.status === 404 && !path.startsWith('auth/')
              ? 'not_found'
              : response.status === 503
                ? 'sealed'
                : 'unreachable';
        // Never include, parse, or log an error response body.
        throw new BaoStorageError(code);
      }
      if (!response.body) return {};
      const decoded: unknown = JSON.parse(response.body);
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded))
        throw new BaoStorageError('unreachable');
      return decoded as Record<string, unknown>;
    } catch (error) {
      throw failure(error instanceof BaoStorageError ? error.code : 'unreachable');
    }
  }
  function acceptAuth(result: Record<string, unknown>): void {
    const auth = result['auth'] as Record<string, unknown> | undefined;
    if (
      typeof auth?.['client_token'] !== 'string' ||
      auth['client_token'] === '' ||
      typeof auth['lease_duration'] !== 'number' ||
      !Number.isFinite(auth['lease_duration']) ||
      auth['lease_duration'] <= 0
    )
      throw failure('unreachable');
    token = auth['client_token'];
    const duration = auth['lease_duration'] * 1000;
    expiresAt = now() + duration;
    refreshAt = expiresAt - Math.min(30_000, duration / 2);
    renewable = auth['renewable'] === true;
  }
  async function login(): Promise<void> {
    let jwt: string;
    try {
      jwt = (await readJwt()).trim();
    } catch {
      throw failure('unreachable');
    }
    if (!jwt) throw failure('denied');
    acceptAuth(await send('auth/kubernetes/login', 'POST', undefined, { role: options.role, jwt }));
    loginGeneration++;
  }
  async function authenticate(forceLogin = false, generation = loginGeneration): Promise<void> {
    // A forced recovery may join a login, but renewal alone cannot satisfy it.
    if (authentication !== undefined) {
      await authentication;
      if (!forceLogin || loginGeneration > generation) return;
      return authenticate(true, generation);
    }
    if (forceLogin && loginGeneration > generation) return;
    authentication = (async () => {
      if (!forceLogin && token !== undefined && now() < refreshAt) return;
      if (!forceLogin && token !== undefined && renewable && now() < expiresAt) {
        try {
          acceptAuth(await send('auth/token/renew-self', 'POST', token, {}));
          return;
        } catch (error) {
          if (!(error instanceof BaoStorageError) || error.code !== 'denied') throw error;
        }
      }
      await login();
    })();
    try {
      await authentication;
    } finally {
      authentication = undefined;
    }
  }
  async function call(
    path: string,
    method = 'GET',
    payload?: unknown,
    auth?: BaoAuth
  ): Promise<Record<string, unknown>> {
    if (auth !== undefined)
      return send(path, method, 'token' in auth ? auth.token : undefined, payload);
    await authenticate();
    const rejectedToken = token;
    try {
      return await send(path, method, rejectedToken, payload);
    } catch (error) {
      if (!(error instanceof BaoStorageError) || error.code !== 'denied') throw error;
      // A concurrent request may already have replaced the rejected token.
      if (token === rejectedToken) await authenticate(true);
      // Direct send: the second rejection cannot enter this recovery path again.
      return send(path, method, token, payload);
    }
  }
  async function readSlot(slot: ModelSlotName): Promise<ModelSlot | null> {
    let result: Record<string, unknown>;
    try {
      result = await call(`lifemodel/data/model/${slot}`);
    } catch (error) {
      if (error instanceof BaoStorageError && error.code === 'not_found') return null;
      throw error;
    }
    const data = result['data'] as Record<string, unknown> | undefined;
    const metadata = data?.['metadata'] as Record<string, unknown> | undefined;
    if (
      metadata?.['destroyed'] === true ||
      (typeof metadata?.['deletion_time'] === 'string' && metadata['deletion_time'] !== '')
    )
      return null;
    const value = data?.['data'] as Record<string, unknown> | undefined;
    if (
      !value ||
      !['openai', 'ollama'].includes(String(value['kind'])) ||
      typeof value['baseUrl'] !== 'string' ||
      typeof value['model'] !== 'string' ||
      (value['key'] !== undefined && typeof value['key'] !== 'string')
    )
      throw failure('unreachable');
    return value as unknown as ModelSlot;
  }
  return {
    call,
    login: () => authenticate(true),
    readSlot,
    writeSlot: async (slot: ModelSlotName, value: ModelSlot) => {
      await call(`lifemodel/data/model/${slot}`, 'POST', { data: value });
    },
    deleteReserve: async () => {
      await call('lifemodel/data/model/reserve', 'DELETE');
    },
  };
}
export class SlotStorageUnavailableError extends Error {
  readonly code = 'storage_unavailable';
  constructor() {
    super('storage_unavailable');
  }
}
/** Per-slot cache; invalidation discards the old credential, even while Bao is down. */
export function createCachedSlotReader(
  read: (slot: ModelSlotName) => Promise<ModelSlot | null>,
  now = Date.now
) {
  const cache = new Map<
    ModelSlotName,
    { value: ModelSlot | null; refreshed: number; failedSince?: number }
  >();
  const pending = new Map<ModelSlotName, Promise<ModelSlot | null>>();
  const generations = new Map<ModelSlotName, number>();
  return {
    invalidate(slot: ModelSlotName) {
      cache.delete(slot);
      generations.set(slot, (generations.get(slot) ?? 0) + 1);
      pending.delete(slot);
    },
    async read(slot: ModelSlotName): Promise<ModelSlot | null> {
      const old = cache.get(slot);
      if (old && now() - old.refreshed < 30_000) return old.value;
      const active = pending.get(slot);
      if (active) return active;
      const generation = generations.get(slot) ?? 0;
      const refresh = (async () => {
        try {
          const value = await read(slot);
          if ((generations.get(slot) ?? 0) !== generation) throw new SlotStorageUnavailableError();
          cache.set(slot, { value, refreshed: now() });
          return value;
        } catch {
          if (!old || (generations.get(slot) ?? 0) !== generation)
            throw new SlotStorageUnavailableError();
          old.failedSince ??= now();
          if (now() - old.failedSince >= 300_000) throw new SlotStorageUnavailableError();
          return old.value;
        }
      })();
      pending.set(slot, refresh);
      try {
        return await refresh;
      } finally {
        if (pending.get(slot) === refresh) pending.delete(slot);
      }
    },
  };
}
