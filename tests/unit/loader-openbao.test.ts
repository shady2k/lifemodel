import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createOpenBaoApi, createOpenBaoBootstrap, type BaoApi, type BaoCustody, type BaoKeys } from '../../loader/src/openbao.js';
import { createPlatformPhaseRunner, type PlatformPhaseRecord, type PlatformPhaseStore } from '../../loader/src/platform-bootstrap.js';

function fixture(initialized = false, crashAfterRevoke = false, initialRecord: PlatformPhaseRecord | null = null) {
  const events: string[] = [];
  let keys: BaoKeys | null = null;
  let record: PlatformPhaseRecord | null = initialRecord;
  let isInitialized = initialized;
  let sealed = true;
  let tokenActive = true;
  let failNextCustodyWrite = false;
  const custody: BaoCustody = {
    read: async () => keys,
    write: async (next) => { events.push('custody-write'); if (failNextCustodyWrite) { failNextCustodyWrite = false; throw new Error('crash during custody update'); } keys = structuredClone(next); },
  };
  const bao: BaoApi = {
    status: async () => ({ initialized: isInitialized, sealed }),
    init: async () => { events.push('init'); isInitialized = true; return { keys: ['key-1'], rootToken: 'root-1' }; },
    unseal: async (key) => { events.push(`unseal:${key}`); sealed = false; },
    rootTokenActive: async () => tokenActive,
    ensureLoaderPolicy: async (_token) => { events.push('policy'); },
    loginLoader: async () => { events.push('login'); },
    revokeRootToken: async (_token) => { events.push('revoke'); tokenActive = false; failNextCustodyWrite = crashAfterRevoke; },
  };
  const store: PlatformPhaseStore = { read: async () => record, write: async (r) => { record = r; } };
  const bootstrap = createOpenBaoBootstrap({ bao, custody, loaderJwt: async () => 'loader-jwt', runPhases: createPlatformPhaseRunner(store) });
  return { bootstrap, events, get keys() { return keys; }, set keys(v) { keys = v; }, get sealed() { return sealed; }, set sealed(v) { sealed = v; }, get initialized() { return isInitialized; }, get tokenActive() { return tokenActive; } };
}

describe('OpenBao bootstrap', () => {
  it('uses the OpenBao HTTP API shapes for 1-of-1 init, policy, role and self-revocation', async () => {
    const calls: Array<{ path: string; method: string; token: string | undefined; body: string | undefined }> = [];
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      request: async (url, method, token, body) => {
        calls.push({ path: url.pathname, method, token, body });
        if (url.pathname.endsWith('/auth/token/lookup-self')) return { status: 200, body: '{}'};
        if (url.pathname.endsWith('/sys/auth')) return { status: 200, body: '{}'};
        if (url.pathname.endsWith('/auth/kubernetes/login')) return { status: 200, body: JSON.stringify({ auth: { client_token: 'loader-token' } }) };
        if (url.pathname.endsWith('/sys/capabilities-self')) return { status: 200, body: JSON.stringify({ 'sys/seal-status': ['read'], 'sys/unseal': ['update'], 'sys/init': ['deny'] }) };
        if (url.pathname.endsWith('/sys/seal-status')) return { status: 200, body: JSON.stringify({ initialized: false, sealed: true }) };
        if (url.pathname.endsWith('/sys/init')) return { status: 200, body: JSON.stringify({ keys: ['key'], root_token: 'root' }) };
        return { status: 204, body: '' };
      },
    });
    await api.status();
    expect(await api.init()).toEqual({ keys: ['key'], rootToken: 'root' });
    expect(await api.rootTokenActive('root')).toBe(true);
    await api.ensureLoaderPolicy('root', 'loader-jwt');
    await api.revokeRootToken('root');
    expect(calls.map(({ path, method }) => [path, method])).toEqual([
      ['/v1/sys/seal-status', 'GET'], ['/v1/sys/init', 'POST'],
      ['/v1/auth/token/lookup-self', 'GET'], ['/v1/sys/policies/acl/loader', 'PUT'], ['/v1/sys/auth', 'GET'],
      ['/v1/sys/auth/kubernetes', 'POST'], ['/v1/auth/kubernetes/config', 'POST'], ['/v1/auth/kubernetes/role/loader', 'POST'], ['/v1/auth/kubernetes/login', 'POST'],
      ['/v1/sys/capabilities-self', 'POST'], ['/v1/auth/token/revoke-self', 'POST'],
    ]);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ secret_shares: 1, secret_threshold: 1 });
    expect(calls.filter(({ path }) => !path.endsWith('/auth/kubernetes/login') && !path.endsWith('/sys/capabilities-self')).slice(2).every(({ token }) => token === 'root')).toBe(true);
    expect(JSON.parse(calls.find(({ path }) => path.endsWith('/auth/kubernetes/role/loader'))?.body ?? '{}')).toMatchObject({ bound_service_account_names: ['loader'], bound_service_account_namespaces: ['lifemodel-system'], policies: ['loader'] });
    expect(JSON.parse(calls.find(({ path }) => path.endsWith('/auth/kubernetes/login'))?.body ?? '{}')).toMatchObject({ role: 'loader', jwt: 'loader-jwt' });
    expect(calls.find(({ path }) => path.endsWith('/sys/capabilities-self'))?.token).toBe('loader-token');
  });

  it('refuses to retire root when the authenticated loader lacks its required capabilities', async () => {
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      request: async (url, _method, token) => {
        if (url.pathname.endsWith('/auth/kubernetes/login')) {
          return { status: 200, body: JSON.stringify({ auth: { client_token: 'loader-token' } }) };
        }
        if (url.pathname.endsWith('/sys/capabilities-self')) {
          expect(token).toBe('loader-token');
          return { status: 200, body: JSON.stringify({ 'sys/seal-status': ['read'], 'sys/unseal': ['update'], 'sys/init': ['update'] }) };
        }
        return { status: 204, body: '' };
      },
    });
    await expect(api.ensureLoaderPolicy('root', 'projected-loader-jwt')).rejects.toThrow(/minimal permitted and denied capabilities/);
  });

  it('aborts a request whose server accepts but never completes the response', async () => {
    const server = createServer((_request, _response) => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const api = createOpenBaoApi({ address: `http://127.0.0.1:${String(address.port)}`, timeoutMs: 30 });
      await expect(api.status()).rejects.toThrow(/exceeded 30 ms/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('initializes once, writes and reads custody before unsealing or using the root token, then retires it', async () => {
    const f = fixture();
    await f.bootstrap.runInitial();
    expect(f.events).toEqual(['init', 'custody-write', 'unseal:key-1', 'policy', 'revoke', 'login', 'custody-write']);
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
    await expect(f.bootstrap.runInitial()).rejects.toThrow(/OpenBao is initialized but Secret openbao-unseal-custody is missing/);
    expect(f.events).not.toContain('init');
  });

  it('unseals before resuming a persisted policy phase after Bao is resealed', async () => {
    const events: string[] = [];
    let sealed = true;
    const bao: BaoApi = {
      status: async () => ({ initialized: true, sealed }),
      init: async () => { throw new Error('must not initialize'); },
      unseal: async () => { events.push('unseal'); sealed = false; },
      rootTokenActive: async () => { events.push('lookup'); return false; },
      ensureLoaderPolicy: async () => { throw new Error('must not reprovision'); },
      loginLoader: async () => { events.push('login'); },
      revokeRootToken: async () => { throw new Error('must not revoke'); },
    };
    const custody: BaoCustody = {
      read: async () => ({ keys: ['share'], rootToken: null }),
      write: async () => { throw new Error('must not write'); },
    };
    let record: PlatformPhaseRecord | null = { phase: 'openbao-policy', status: 'running' };
    const store: PlatformPhaseStore = { read: async () => record, write: async (next) => { record = next; } };
    const bootstrap = createOpenBaoBootstrap({ bao, custody, loaderJwt: async () => 'loader-jwt', runPhases: createPlatformPhaseRunner(store) });
    await bootstrap.runInitial();
    expect(events).toContain('unseal');
    expect(sealed).toBe(false);
    expect(events).not.toContain('lookup');
  });

  it('rejects missing custody on a completed, unsealed bootstrap before resuming', async () => {
    const f = fixture(true, false, { phase: 'openbao-policy', status: 'complete' });
    f.sealed = false;
    f.keys = null;
    await expect(f.bootstrap.runInitial()).rejects.toThrow(/Secret openbao-unseal-custody is missing/);
    expect(f.events).not.toContain('init');
    expect(f.events).not.toContain('login');
  });

  it('rejects invalid custody on a completed, unsealed bootstrap before resuming', async () => {
    const f = fixture(true, false, { phase: 'openbao-policy', status: 'complete' });
    f.sealed = false;
    f.keys = { keys: [], rootToken: null };
    await expect(f.bootstrap.runInitial()).rejects.toThrow(/Secret openbao-unseal-custody is missing or invalid/);
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
