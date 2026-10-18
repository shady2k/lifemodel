import { readFile } from 'node:fs/promises';
import type { ModelSlot, ModelSlotName } from './model.js';

export type BaoErrorCode = 'sealed' | 'unreachable' | 'denied' | 'not_found';
export class BaoStorageError extends Error {
  constructor(readonly code: BaoErrorCode) {
    super(code);
  }
}
export interface RoleBaoOptions {
  address: string;
  role: 'loader' | 'model-gateway';
  jwtFile?: string;
  readJwt?: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  logger?: { error(fields: Record<string, unknown>, message: string): void };
}
export function createRoleBaoClient(options: RoleBaoOptions) {
  const base = new URL(options.address);
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const readJwt =
    options.readJwt ??
    (() =>
      readFile(
        options.jwtFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
        'utf8'
      ).then((s) => s.trim()));
  let token: string | undefined;
  let expiresAt = 0;
  async function login(): Promise<void> {
    const jwt = await readJwt();
    if (!jwt) throw new BaoStorageError('denied');
    try {
      const response = await request(new URL('/v1/auth/kubernetes/login', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: options.role, jwt }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
      });
      const data = (await response.json()) as {
        auth?: { client_token?: string; lease_duration?: number };
      };
      if (!response.ok || !data.auth?.client_token)
        throw new BaoStorageError(response.status === 403 ? 'denied' : 'unreachable');
      token = data.auth.client_token;
      expiresAt = now() + Math.max(1, (data.auth.lease_duration ?? 3600) * 1000);
    } catch (error) {
      if (error instanceof BaoStorageError) throw error;
      throw new BaoStorageError('unreachable');
    }
  }
  async function call(
    path: string,
    method = 'GET',
    payload?: unknown
  ): Promise<Record<string, unknown>> {
    const invoke = async () => {
      if (!token || now() >= expiresAt - 30_000) await login();
      const activeToken = token;
      if (!activeToken) throw new BaoStorageError('denied');
      return request(new URL(`/v1/${path}`, base), {
        method,
        headers: {
          'x-vault-token': activeToken,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
      });
    };
    try {
      let response = await invoke();
      if (response.status === 403) {
        token = undefined;
        await login();
        response = await invoke();
      }
      if (!response.ok) {
        const code: BaoErrorCode =
          response.status === 403
            ? 'denied'
            : response.status === 404
              ? 'not_found'
              : response.status === 503
                ? 'sealed'
                : 'unreachable';
        await response.arrayBuffer();
        throw new BaoStorageError(code);
      }
      if (response.status === 204) return {};
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BaoStorageError) throw error;
      options.logger?.error({ code: 'unreachable' }, 'OpenBao request failed');
      throw new BaoStorageError('unreachable');
    }
  }
  async function readSlot(slot: ModelSlotName): Promise<ModelSlot | null> {
    try {
      const result = await call(`lifemodel/data/model/${slot}`);
      const data = result['data'] as
        | { data?: ModelSlot; metadata?: { destroyed?: boolean; deletion_time?: string } }
        | undefined;
      if (!data || data.metadata?.destroyed || data.metadata?.deletion_time) return null;
      if (!data.data) throw new BaoStorageError('unreachable');
      return data.data;
    } catch (error) {
      if (error instanceof BaoStorageError && error.code === 'not_found') return null;
      throw error;
    }
  }
  return {
    call,
    readSlot,
    writeSlot: async (slot: ModelSlotName, value: ModelSlot) => {
      await call(`lifemodel/data/model/${slot}`, 'POST', { data: value });
    },
    deleteReserve: async () => {
      await call('lifemodel/data/model/reserve', 'DELETE');
    },
  };
}
export function createCachedSlotReader(
  read: (slot: ModelSlotName) => Promise<ModelSlot | null>,
  now = Date.now,
  refreshMs = 30_000,
  hardExpiryMs = 300_000
) {
  const cache = new Map<
    ModelSlotName,
    { value: ModelSlot | null; refreshed: number; failedSince?: number }
  >();
  const invalid = new Set<ModelSlotName>();
  return {
    invalidate(slot: ModelSlotName) {
      invalid.add(slot);
    },
    async read(slot: ModelSlotName): Promise<ModelSlot | null> {
      const t = now(),
        old = cache.get(slot);
      if (!old || invalid.has(slot) || t - old.refreshed >= refreshMs) {
        try {
          const value = await read(slot);
          cache.set(slot, { value, refreshed: t });
          invalid.delete(slot);
          return value;
        } catch {
          const failedSince = old?.failedSince ?? t;
          cache.set(slot, { ...(old ?? { value: null, refreshed: t }), failedSince });
          if (t - failedSince >= hardExpiryMs) throw new Error('storage_unavailable');
        }
      }
      const current = cache.get(slot);
      if (current?.failedSince !== undefined && t - current.failedSince >= hardExpiryMs)
        throw new Error('storage_unavailable');
      return current?.value ?? null;
    },
  };
}
