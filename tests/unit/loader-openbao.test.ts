import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import {
  createOpenBaoApi,
  createOpenBaoBootstrap,
  type BaoApi,
  type BaoCustody,
  type BaoKeys,
} from '../../loader/src/openbao.js';
import {
  createPlatformPhaseRunner,
  type PlatformPhaseRecord,
  type PlatformPhaseStore,
} from '../../loader/src/platform-bootstrap.js';

function fixture(
  initialized = false,
  crashAfterRevoke = false,
  initialRecord: PlatformPhaseRecord | null = null
) {
  const events: string[] = [];
  let keys: BaoKeys | null = null;
  let record: PlatformPhaseRecord | null = initialRecord;
  let isInitialized = initialized;
  let sealed = true;
  let tokenActive = true;
  let failNextCustodyWrite = false;
  const custody: BaoCustody = {
    read: async () => keys,
    write: async (next) => {
      events.push('custody-write');
      if (failNextCustodyWrite) {
        failNextCustodyWrite = false;
        throw new Error('crash during custody update');
      }
      keys = structuredClone(next);
    },
  };
  const bao: BaoApi = {
    status: async () => ({ initialized: isInitialized, sealed }),
    init: async () => {
      events.push('init');
      isInitialized = true;
      return { keys: ['key-1'], rootToken: 'root-1' };
    },
    unseal: async (key) => {
      events.push(`unseal:${key}`);
      sealed = false;
    },
    rootTokenActive: async () => tokenActive,
    ensureLoaderPolicy: async (_token) => {
      events.push('policy');
    },
    ensureModelPolicy: async (_token) => {
      events.push('model-policy');
    },
    login: async () => {
      events.push('login');
    },
    revokeRootToken: async (_token) => {
      events.push('revoke');
      tokenActive = false;
      failNextCustodyWrite = crashAfterRevoke;
    },
    readModelSlot: async () => {
      throw new Error('bootstrap never reads a model slot');
    },
    writeModelSlot: async () => {
      throw new Error('bootstrap never writes a model slot');
    },
    deleteModelReserve: async () => {
      throw new Error('bootstrap never deletes the reserve');
    },
  };
  const store: PlatformPhaseStore = {
    read: async () => record,
    write: async (r) => {
      record = r;
    },
  };
  const bootstrap = createOpenBaoBootstrap({
    bao,
    custody,
    runPhases: createPlatformPhaseRunner(store),
  });
  return {
    bootstrap,
    events,
    get keys() {
      return keys;
    },
    set keys(v) {
      keys = v;
    },
    get sealed() {
      return sealed;
    },
    set sealed(v) {
      sealed = v;
    },
    get initialized() {
      return isInitialized;
    },
    get tokenActive() {
      return tokenActive;
    },
  };
}

describe('OpenBao bootstrap', () => {
  it('uses the OpenBao HTTP API shapes for 1-of-1 init, policy, role and self-revocation', async () => {
    const calls: Array<{
      path: string;
      method: string;
      token: string | undefined;
      body: string | undefined;
    }> = [];
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url, method, token, body) => {
        calls.push({ path: url.pathname, method, token, body });
        if (url.pathname.endsWith('/auth/token/lookup-self')) return { status: 200, body: '{}' };
        if (url.pathname.endsWith('/sys/auth')) return { status: 200, body: '{}' };
        if (url.pathname.endsWith('/auth/kubernetes/login'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'loader-token', lease_duration: 3600, renewable: true },
            }),
          };
        if (url.pathname.endsWith('/auth/kubernetes/role/model-gateway'))
          return method === 'GET'
            ? {
                status: 200,
                body: JSON.stringify({
                  bound_service_account_names: ['model-gateway'],
                  bound_service_account_namespaces: ['lifemodel-system'],
                  policies: ['model-gateway'],
                }),
              }
            : { status: 204, body: '' };
        if (url.pathname.endsWith('/auth/token/create'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'gateway-check-token', lease_duration: 60, renewable: false },
            }),
          };
        if (url.pathname.endsWith('/sys/capabilities-self'))
          return {
            status: 200,
            body: JSON.stringify(
              token === 'gateway-check-token'
                ? {
                    'lifemodel/data/model/primary': ['read'],
                    'lifemodel/data/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['deny'],
                  }
                : {
                    'sys/seal-status': ['read'],
                    'sys/unseal': ['update'],
                    'sys/init': ['deny'],
                    'lifemodel/data/model/primary': ['create', 'update', 'read'],
                    'lifemodel/data/model/reserve': ['create', 'update', 'read', 'delete'],
                    'lifemodel/metadata/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['read'],
                  }
            ),
          };
        if (url.pathname.endsWith('/sys/seal-status'))
          return { status: 200, body: JSON.stringify({ initialized: false, sealed: true }) };
        if (url.pathname.endsWith('/sys/init'))
          return { status: 200, body: JSON.stringify({ keys: ['key'], root_token: 'root' }) };
        return { status: 204, body: '' };
      },
    });
    await api.status();
    expect(await api.init()).toEqual({ keys: ['key'], rootToken: 'root' });
    expect(await api.rootTokenActive('root')).toBe(true);
    await api.ensureLoaderPolicy('root');
    await api.ensureModelPolicy('root');
    await api.revokeRootToken('root');
    expect(calls.map(({ path, method }) => [path, method])).toEqual([
      ['/v1/sys/seal-status', 'GET'],
      ['/v1/sys/init', 'POST'],
      ['/v1/auth/token/lookup-self', 'GET'],
      ['/v1/sys/policies/acl/loader', 'PUT'],
      ['/v1/sys/auth', 'GET'],
      ['/v1/sys/auth/kubernetes', 'POST'],
      ['/v1/auth/kubernetes/config', 'POST'],
      ['/v1/auth/kubernetes/role/loader', 'POST'],
      ['/v1/auth/kubernetes/login', 'POST'],
      ['/v1/sys/capabilities-self', 'POST'],
      ['/v1/sys/mounts', 'GET'],
      ['/v1/sys/mounts/lifemodel', 'POST'],
      ['/v1/sys/policies/acl/loader-model', 'PUT'],
      ['/v1/auth/kubernetes/role/loader', 'POST'],
      ['/v1/sys/policies/acl/model-gateway', 'PUT'],
      ['/v1/auth/kubernetes/role/model-gateway', 'POST'],
      ['/v1/auth/kubernetes/role/model-gateway', 'GET'],
      ['/v1/auth/token/create', 'POST'],
      ['/v1/sys/capabilities-self', 'POST'],
      ['/v1/auth/token/revoke-self', 'POST'],
      ['/v1/auth/kubernetes/login', 'POST'],
      ['/v1/sys/capabilities-self', 'POST'],
      ['/v1/auth/token/revoke-self', 'POST'],
    ]);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ secret_shares: 1, secret_threshold: 1 });
    expect(
      calls
        .filter(
          ({ path, token }) =>
            !path.endsWith('/auth/kubernetes/login') &&
            !path.endsWith('/sys/capabilities-self') &&
            token !== 'gateway-check-token'
        )
        .slice(2)
        .every(({ token }) => token === 'root')
    ).toBe(true);
    // The gateway policy's capability check runs as the gateway's own policy
    // would, never as root and never as the loader's other policies.
    expect(
      calls.find(
        ({ path, token }) =>
          path.endsWith('/sys/capabilities-self') && token === 'gateway-check-token'
      )
    ).toBeDefined();
    expect(
      JSON.parse(
        calls.find(({ path }) => path.endsWith('/auth/kubernetes/role/loader'))?.body ?? '{}'
      )
    ).toMatchObject({
      bound_service_account_names: ['loader'],
      bound_service_account_namespaces: ['lifemodel-system'],
      policies: ['loader'],
    });
    expect(
      JSON.parse(calls.find(({ path }) => path.endsWith('/auth/kubernetes/login'))?.body ?? '{}')
    ).toMatchObject({ role: 'loader', jwt: 'loader-jwt' });
    expect(calls.filter(({ path }) => path.endsWith('/sys/capabilities-self')).at(-1)?.token).toBe(
      'loader-token'
    );
  });

  it('sends no token on anonymous bootstrap calls and keeps the workload token across root calls', async () => {
    const calls: Array<{ path: string; token: string | undefined }> = [];
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url, _method, token) => {
        calls.push({ path: url.pathname, token });
        if (url.pathname.endsWith('/auth/kubernetes/login'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'loader-token', lease_duration: 3600, renewable: true },
            }),
          };
        if (url.pathname.endsWith('/sys/seal-status'))
          return { status: 200, body: JSON.stringify({ initialized: true, sealed: true }) };
        if (url.pathname.endsWith('/lifemodel/data/model/primary'))
          return {
            status: 200,
            body: JSON.stringify({
              data: {
                data: { kind: 'openai', baseUrl: 'https://model.example/v1', model: 'm' },
                metadata: {},
              },
            }),
          };
        return { status: 204, body: '' };
      },
    });
    // A workload login happens first, so the token is available to borrow.
    await api.login();
    await expect(api.status()).resolves.toEqual({ initialized: true, sealed: true });
    await api.unseal('share-1');
    await api.revokeRootToken('root-token-1');
    await expect(api.readModelSlot('primary')).resolves.toMatchObject({ model: 'm' });
    const tokenFor = (suffix: string) => calls.find((call) => call.path.endsWith(suffix))?.token;
    expect(tokenFor('/sys/seal-status')).toBeUndefined();
    expect(tokenFor('/sys/unseal')).toBeUndefined();
    expect(tokenFor('/auth/token/revoke-self')).toBe('root-token-1');
    // An explicit root call never replaces the workload identity.
    expect(tokenFor('/lifemodel/data/model/primary')).toBe('loader-token');
  });

  it('provisions idempotent KV v2, the loader model policy and the read-only gateway identity before loader-role verification', async () => {
    const calls: Array<{ path: string; method: string; token?: string; body?: string }> = [];
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url, method, token, body) => {
        calls.push({
          path: url.pathname,
          method,
          ...(token === undefined ? {} : { token }),
          ...(body === undefined ? {} : { body }),
        });
        if (url.pathname.endsWith('/sys/mounts'))
          return {
            status: 200,
            body: JSON.stringify({ 'lifemodel/': { type: 'kv', options: { version: '2' } } }),
          };
        if (url.pathname.endsWith('/auth/kubernetes/login'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'loader-token', lease_duration: 3600, renewable: true },
            }),
          };
        if (url.pathname.endsWith('/auth/kubernetes/role/model-gateway') && method === 'GET')
          return {
            status: 200,
            body: JSON.stringify({
              bound_service_account_names: ['model-gateway'],
              bound_service_account_namespaces: ['lifemodel-system'],
              policies: ['model-gateway'],
            }),
          };
        if (url.pathname.endsWith('/auth/token/create'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'gateway-check-token', lease_duration: 60, renewable: false },
            }),
          };
        if (url.pathname.endsWith('/sys/capabilities-self'))
          return {
            status: 200,
            body: JSON.stringify(
              token === 'gateway-check-token'
                ? {
                    'lifemodel/data/model/primary': ['read'],
                    'lifemodel/data/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['deny'],
                  }
                : {
                    'lifemodel/data/model/primary': ['create', 'update', 'read'],
                    'lifemodel/data/model/reserve': ['create', 'update', 'read', 'delete'],
                    'lifemodel/metadata/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['read'],
                  }
            ),
          };
        return { status: 204, body: '' };
      },
    });
    await api.ensureModelPolicy('root-token');
    const policy = JSON.parse(
      calls.find((call) => call.path.endsWith('/loader-model'))?.body ?? '{}'
    ).policy as string;
    expect(policy).toContain(
      'path "lifemodel/data/model/reserve" { capabilities = ["create", "update", "read", "delete"] }'
    );
    expect(policy).toContain(
      'path "lifemodel/data/model/*" { capabilities = ["create", "update", "read"] }'
    );
    expect(policy).not.toMatch(/path "lifemodel\/data\/model\/(?:\*|primary)"[^}]*delete/);
    expect(policy).toContain('path "lifemodel/metadata/model/*" { capabilities = ["read"] }');
    expect(
      calls.find((call) => call.path.endsWith('/auth/kubernetes/role/loader'))?.body
    ).toContain('loader-model');
    expect(calls.some((call) => call.path.endsWith('/sys/mounts/lifemodel'))).toBe(false);

    // The gateway's own identity: read on the slots only, bound to its own
    // ServiceAccount, verified as that policy would be held before root goes.
    const gatewayPolicy = JSON.parse(
      calls.find((call) => call.path.endsWith('/sys/policies/acl/model-gateway'))?.body ?? '{}'
    ).policy as string;
    expect(gatewayPolicy).toBe('path "lifemodel/data/model/*" { capabilities = ["read"] }');
    expect(gatewayPolicy).not.toMatch(/create|update|delete|metadata/);
    expect(
      JSON.parse(
        calls.find(
          (call) =>
            call.path.endsWith('/auth/kubernetes/role/model-gateway') && call.method === 'POST'
        )?.body ?? '{}'
      )
    ).toEqual({
      bound_service_account_names: ['model-gateway'],
      bound_service_account_namespaces: ['lifemodel-system'],
      policies: ['model-gateway'],
      ttl: '1h',
    });
    expect(
      JSON.parse(calls.find((call) => call.path.endsWith('/auth/token/create'))?.body ?? '{}')
    ).toEqual({ policies: ['model-gateway'], ttl: '60s', renewable: false, no_parent: true });
    const gatewayCheck = calls.find(
      (call) => call.path.endsWith('/sys/capabilities-self') && call.token === 'gateway-check-token'
    );
    expect(JSON.parse(gatewayCheck?.body ?? '{}').paths).toEqual([
      'lifemodel/data/model/primary',
      'lifemodel/data/model/reserve',
      'lifemodel/metadata/model/primary',
    ]);
    expect(
      calls.find(
        (call) =>
          call.path.endsWith('/auth/token/revoke-self') && call.token === 'gateway-check-token'
      )
    ).toBeDefined();
  });

  it.each([
    ['write', { 'lifemodel/data/model/primary': ['read', 'update'] }],
    ['an unrelated path', { 'lifemodel/metadata/model/primary': ['read'] }],
  ])('refuses the phase when the gateway policy can %s', async (_description, mutated) => {
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url, method, token) => {
        if (url.pathname.endsWith('/sys/mounts'))
          return {
            status: 200,
            body: JSON.stringify({ 'lifemodel/': { type: 'kv', options: { version: '2' } } }),
          };
        if (url.pathname.endsWith('/auth/kubernetes/login'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'loader-token', lease_duration: 3600, renewable: true },
            }),
          };
        if (url.pathname.endsWith('/auth/kubernetes/role/model-gateway') && method === 'GET')
          return {
            status: 200,
            body: JSON.stringify({
              bound_service_account_names: ['model-gateway'],
              bound_service_account_namespaces: ['lifemodel-system'],
              policies: ['model-gateway'],
            }),
          };
        if (url.pathname.endsWith('/auth/token/create'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: {
                client_token: 'gateway-check-token',
                lease_duration: 60,
                renewable: false,
              },
            }),
          };
        if (url.pathname.endsWith('/sys/capabilities-self'))
          return {
            status: 200,
            body: JSON.stringify(
              token === 'gateway-check-token'
                ? {
                    'lifemodel/data/model/primary': ['read'],
                    'lifemodel/data/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['deny'],
                    ...mutated,
                  }
                : {
                    'lifemodel/data/model/primary': ['create', 'update', 'read'],
                    'lifemodel/data/model/reserve': ['create', 'update', 'read', 'delete'],
                    'lifemodel/metadata/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['read'],
                  }
            ),
          };
        return { status: 204, body: '' };
      },
    });
    await expect(api.ensureModelPolicy('root-token')).rejects.toThrow(/model-gateway/);
  });

  it('provisions and verifies the gateway identity before the root token is retired', async () => {
    const paths: string[] = [];
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url, method, token) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith('/sys/seal-status'))
          return { status: 200, body: JSON.stringify({ initialized: true, sealed: false }) };
        if (url.pathname.endsWith('/sys/mounts'))
          return { status: 200, body: '{"lifemodel/":{"type":"kv","options":{"version":"2"}}}' };
        if (url.pathname.endsWith('/auth/token/lookup-self')) return { status: 200, body: '{}' };
        if (url.pathname.endsWith('/auth/kubernetes/login'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'loader-token', lease_duration: 3600, renewable: true },
            }),
          };
        if (url.pathname.endsWith('/auth/kubernetes/role/model-gateway') && method === 'GET')
          return {
            status: 200,
            body: JSON.stringify({
              bound_service_account_names: ['model-gateway'],
              bound_service_account_namespaces: ['lifemodel-system'],
              policies: ['model-gateway'],
            }),
          };
        if (url.pathname.endsWith('/auth/token/create'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'gateway-check-token', lease_duration: 60, renewable: false },
            }),
          };
        if (url.pathname.endsWith('/sys/capabilities-self'))
          return {
            status: 200,
            body: JSON.stringify(
              token === 'gateway-check-token'
                ? {
                    'lifemodel/data/model/primary': ['read'],
                    'lifemodel/data/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['deny'],
                  }
                : {
                    'sys/seal-status': ['read'],
                    'sys/unseal': ['update'],
                    'sys/init': ['deny'],
                    'lifemodel/data/model/primary': ['create', 'update', 'read'],
                    'lifemodel/data/model/reserve': ['create', 'update', 'read', 'delete'],
                    'lifemodel/metadata/model/reserve': ['read'],
                    'lifemodel/metadata/model/primary': ['read'],
                  }
            ),
          };
        return { status: 204, body: '' };
      },
    });
    // Where the bootstrap retired the root token, in the same call order.
    const retiredAt: number[] = [];
    const bootstrap = createOpenBaoBootstrap({
      bao: {
        ...api,
        revokeRootToken: async (rootToken) => {
          retiredAt.push(paths.length);
          await api.revokeRootToken(rootToken);
        },
      },
      custody: {
        read: async () => ({
          keys: ['key'],
          rootToken: retiredAt.length > 0 ? null : 'root-token',
        }),
        write: async () => {},
      },
      runPhases: async (phases) => {
        for (const phase of phases) await phase.run();
      },
    });
    await bootstrap.runInitial();
    const gatewayPolicy = paths.indexOf('/v1/sys/policies/acl/model-gateway');
    const gatewayRole = paths.indexOf('/v1/auth/kubernetes/role/model-gateway');
    const gatewayCheck = paths.indexOf('/v1/sys/capabilities-self', gatewayRole);
    expect(gatewayPolicy).toBeGreaterThanOrEqual(0);
    expect(gatewayRole).toBeGreaterThan(gatewayPolicy);
    expect(gatewayCheck).toBeGreaterThan(gatewayRole);
    // The root token is retired only after the gateway's identity was written
    // AND verified: a role provisioned after the retirement could never be
    // fixed by the loader again (ADR-013 D3).
    expect(retiredAt).toHaveLength(1);
    expect(retiredAt[0]).toBeGreaterThan(gatewayCheck);
    // The retirement is the LAST revoke-self of the phase: the capability
    // check's own bounded token was revoked inside the verification above.
    expect(paths.lastIndexOf('/v1/auth/token/revoke-self')).toBe(retiredAt[0]);
  });

  it('re-enters the policy phase after a crash before the gateway identity is verified', async () => {
    const events: string[] = [];
    let attempts = 0;
    let rootActive = true;
    let record: PlatformPhaseRecord | null = null;
    const store: PlatformPhaseStore = {
      read: async () => record,
      write: async (next) => {
        record = next;
      },
    };
    const bootstrap = createOpenBaoBootstrap({
      bao: {
        status: async () => ({ initialized: true, sealed: false }),
        init: async () => ({ keys: ['key'], rootToken: 'root' }),
        unseal: async () => {},
        rootTokenActive: async () => rootActive,
        ensureLoaderPolicy: async () => {
          events.push('loader-policy');
        },
        ensureModelPolicy: async () => {
          attempts += 1;
          events.push(`model-policy:${String(attempts)}`);
          if (attempts === 1) throw new Error('crash before the gateway identity was verified');
        },
        login: async () => {
          events.push('login');
        },
        revokeRootToken: async () => {
          events.push('revoke');
          rootActive = false;
        },
      },
      custody: {
        read: async () => ({ keys: ['key'], rootToken: rootActive ? 'root' : null }),
        write: async () => {},
      },
      runPhases: createPlatformPhaseRunner(store),
    });
    await expect(bootstrap.runInitial()).rejects.toThrow(/gateway identity/);
    expect(record).toEqual({ phase: 'openbao-policy', status: 'failed' });
    expect(events).not.toContain('revoke');
    // The next start re-runs the whole policy phase and retires root only then.
    await bootstrap.runInitial();
    expect(record).toEqual({ phase: 'openbao-policy', status: 'complete' });
    expect(events).toEqual([
      'loader-policy',
      'model-policy:1',
      'loader-policy',
      'model-policy:2',
      'revoke',
      'login',
    ]);
    expect(rootActive).toBe(false);
  });

  it('refuses to retire root when the authenticated loader lacks its required capabilities', async () => {
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url, _method, token) => {
        if (url.pathname.endsWith('/auth/kubernetes/login')) {
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'loader-token', lease_duration: 3600, renewable: true },
            }),
          };
        }
        if (url.pathname.endsWith('/sys/capabilities-self')) {
          expect(token).toBe('loader-token');
          return {
            status: 200,
            body: JSON.stringify({
              'sys/seal-status': ['read'],
              'sys/unseal': ['update'],
              'sys/init': ['update'],
            }),
          };
        }
        return { status: 204, body: '' };
      },
    });
    await expect(api.ensureLoaderPolicy('root')).rejects.toThrow(
      /minimal permitted and denied capabilities/
    );
  });

  it('refuses root retirement when loader capabilities include primary delete', async () => {
    const events: string[] = [];
    let retired = false;
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url, _method, token) => {
        if (url.pathname.endsWith('/auth/kubernetes/login'))
          return {
            status: 200,
            body: JSON.stringify({
              auth: { client_token: 'loader-token', lease_duration: 3600, renewable: true },
            }),
          };
        if (url.pathname.endsWith('/sys/capabilities-self')) {
          expect(token).toBe('loader-token');
          return {
            status: 200,
            body: JSON.stringify({
              'lifemodel/data/model/primary': ['create', 'update', 'read', 'delete'],
              'lifemodel/data/model/reserve': ['create', 'update', 'read', 'delete'],
              'lifemodel/metadata/model/reserve': ['read'],
              'lifemodel/metadata/model/primary': ['read'],
            }),
          };
        }
        if (url.pathname.endsWith('/sys/mounts'))
          return {
            status: 200,
            body: JSON.stringify({ 'lifemodel/': { type: 'kv', options: { version: '2' } } }),
          };
        return { status: 204, body: '' };
      },
    });
    const bootstrap = createOpenBaoBootstrap({
      bao: {
        status: async () => ({ initialized: true, sealed: false }),
        init: async () => ({ keys: ['key'], rootToken: 'root' }),
        unseal: async () => {},
        rootTokenActive: async () => !retired,
        ensureLoaderPolicy: async () => {},
        ensureModelPolicy: (root) => api.ensureModelPolicy!(root),
        login: () => api.login(),
        revokeRootToken: async () => {
          events.push('revoke');
          retired = true;
        },
      },
      custody: {
        read: async () => ({ keys: ['key'], rootToken: 'root' }),
        write: async () => {},
      },
      runPhases: async (phases) => {
        for (const phase of phases) await phase.run();
      },
    });
    let failure: unknown;
    try {
      await bootstrap.runInitial();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(events).not.toContain('revoke');
  });
  it('reads model slots through the HTTP API and treats deleted KV v2 latest version as unset', async () => {
    const paths: string[] = [];
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      role: 'loader',
      readJwt: async () => 'loader-jwt',
      request: async (url) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith('/login'))
          return {
            status: 200,
            body: JSON.stringify({ auth: { client_token: 'token', lease_duration: 3600 } }),
          };
        return {
          status: 200,
          body: JSON.stringify({
            data: {
              data: { key: 'private-key' },
              metadata: { destroyed: false, deletion_time: '2026-10-17T00:00:00Z' },
            },
          }),
        };
      },
    });
    await expect(api.readModelSlot('reserve')).resolves.toBeNull();
    expect(paths).toEqual(['/v1/auth/kubernetes/login', '/v1/lifemodel/data/model/reserve']);
  });

  it('aborts a request whose server accepts but never completes the response', async () => {
    const server = createServer((_request, _response) => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind');
    try {
      const api = createOpenBaoApi({
        address: `http://127.0.0.1:${String(address.port)}`,
        timeoutMs: 30,
        role: 'loader',
      });
      await expect(api.status()).rejects.toMatchObject({ code: 'unreachable' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('initializes once, writes and reads custody before unsealing or using the root token, then retires it', async () => {
    const f = fixture();
    await f.bootstrap.runInitial();
    expect(f.events).toEqual([
      'init',
      'custody-write',
      'unseal:key-1',
      'policy',
      'model-policy',
      'revoke',
      'login',
      'custody-write',
    ]);
    expect(f.keys).toEqual({ keys: ['key-1'], rootToken: null });
    expect(f.tokenActive).toBe(false);
    await f.bootstrap.runInitial();
    expect(f.events.filter((event) => event === 'init')).toHaveLength(1);
  });

  it('resumes a running init phase from custody after a crash without initializing again', async () => {
    const f = fixture(true);
    f.keys = { keys: ['key-1'], rootToken: 'root-1' };
    await f.bootstrap.runInitial();
    expect(f.events).not.toContain('init');
    expect(f.tokenActive).toBe(false);
  });

  it('resumes after root revocation and reseal before the custody token is removed', async () => {
    const f = fixture(false, true);
    await expect(f.bootstrap.runInitial()).rejects.toThrow('crash during custody update');
    expect(f.tokenActive).toBe(false);
    // The custody token remains, but lookup-self identifies the exact crash cut.
    f.sealed = true;
    const recoveryStart = f.events.length;
    await f.bootstrap.runInitial();
    const recoveryEvents = f.events.slice(recoveryStart);
    expect(recoveryEvents).toEqual(['unseal:key-1', 'login', 'custody-write']);
    expect(f.events.filter((event) => event === 'init')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'policy')).toHaveLength(1);
    expect(f.keys).toEqual({ keys: ['key-1'], rootToken: null });
  });

  it('fails loudly with a named recovery error when initialized Bao has lost custody', async () => {
    const f = fixture(true);
    await expect(f.bootstrap.runInitial()).rejects.toThrow(
      /OpenBao is initialized but Secret openbao-unseal-custody is missing/
    );
    expect(f.events).not.toContain('init');
  });

  it('unseals before resuming a persisted policy phase after Bao is resealed', async () => {
    const events: string[] = [];
    let sealed = true;
    const bao: BaoApi = {
      status: async () => ({ initialized: true, sealed }),
      init: async () => {
        throw new Error('must not initialize');
      },
      unseal: async () => {
        events.push('unseal');
        sealed = false;
      },
      rootTokenActive: async () => {
        events.push('lookup');
        return false;
      },
      ensureLoaderPolicy: async () => {
        throw new Error('must not reprovision');
      },
      login: async () => {
        events.push('login');
      },
      revokeRootToken: async () => {
        throw new Error('must not revoke');
      },
      readModelSlot: async () => {
        throw new Error('must not read a model slot');
      },
      writeModelSlot: async () => {
        throw new Error('must not write a model slot');
      },
      deleteModelReserve: async () => {
        throw new Error('must not delete the reserve');
      },
    };
    const custody: BaoCustody = {
      read: async () => ({ keys: ['share'], rootToken: null }),
      write: async () => {
        throw new Error('must not write');
      },
    };
    let record: PlatformPhaseRecord | null = { phase: 'openbao-policy', status: 'running' };
    const store: PlatformPhaseStore = {
      read: async () => record,
      write: async (next) => {
        record = next;
      },
    };
    const bootstrap = createOpenBaoBootstrap({
      bao,
      custody,
      runPhases: createPlatformPhaseRunner(store),
    });
    await bootstrap.runInitial();
    expect(events).toContain('unseal');
    expect(sealed).toBe(false);
    expect(events).not.toContain('lookup');
  });

  it('rejects missing custody on a completed, unsealed bootstrap before resuming', async () => {
    const f = fixture(true, false, { phase: 'openbao-policy', status: 'complete' });
    f.sealed = false;
    f.keys = null;
    await expect(f.bootstrap.runInitial()).rejects.toThrow(
      /Secret openbao-unseal-custody is missing/
    );
    expect(f.events).not.toContain('init');
    expect(f.events).not.toContain('login');
  });

  it('rejects invalid custody on a completed, unsealed bootstrap before resuming', async () => {
    const f = fixture(true, false, { phase: 'openbao-policy', status: 'complete' });
    f.sealed = false;
    f.keys = { keys: [], rootToken: null };
    await expect(f.bootstrap.runInitial()).rejects.toThrow(
      /Secret openbao-unseal-custody is missing or invalid/
    );
    expect(f.events).not.toContain('init');
    expect(f.events).not.toContain('login');
  });

  it('unseals a sealed restart without reinitializing', async () => {
    const f = fixture(true);
    f.keys = { keys: ['key-1'], rootToken: null };
    await f.bootstrap.unsealIfSealed();
    expect(f.events).toEqual(['unseal:key-1']);
    expect(f.events).not.toContain('init');
  });
});
