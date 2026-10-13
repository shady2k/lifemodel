import { describe, expect, it } from 'vitest';
import { createOpenBaoApi, createOpenBaoBootstrap, type BaoApi, type BaoCustody, type BaoKeys } from '../../loader/src/openbao.js';
import { createPlatformPhaseRunner, type PlatformPhaseRecord, type PlatformPhaseStore } from '../../loader/src/platform-bootstrap.js';

function fixture(initialized = false, crashAfterRevoke = false) {
  const events: string[] = [];
  let keys: BaoKeys | null = null;
  let record: PlatformPhaseRecord | null = null;
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
    revokeRootToken: async (_token) => { events.push('revoke'); tokenActive = false; failNextCustodyWrite = crashAfterRevoke; },
  };
  const store: PlatformPhaseStore = { read: async () => record, write: async (r) => { record = r; } };
  const bootstrap = createOpenBaoBootstrap({ bao, custody, runPhases: createPlatformPhaseRunner(store) });
  return { bootstrap, events, get keys() { return keys; }, set keys(v) { keys = v; }, get sealed() { return sealed; }, get initialized() { return isInitialized; }, get tokenActive() { return tokenActive; } };
}

describe('OpenBao bootstrap', () => {
  it('uses the OpenBao HTTP API shapes for 1-of-1 init, policy, role and self-revocation', async () => {
    const calls: Array<{ path: string; method: string; token: string | undefined; body: string | undefined }> = [];
    const api = createOpenBaoApi({
      address: 'http://openbao.test:8200',
      request: async (url, method, token, body) => {
        calls.push({ path: url.pathname, method, token, body });
        if (url.pathname.endsWith('/auth/token/lookup-self')) return { status: 200, body: '{}'};
        if (url.pathname.endsWith('/sys/seal-status')) return { status: 200, body: JSON.stringify({ initialized: false, sealed: true }) };
        if (url.pathname.endsWith('/sys/init')) return { status: 200, body: JSON.stringify({ keys: ['key'], root_token: 'root' }) };
        return { status: 204, body: '' };
      },
    });
    await api.status();
    expect(await api.init()).toEqual({ keys: ['key'], rootToken: 'root' });
    expect(await api.rootTokenActive('root')).toBe(true);
    await api.ensureLoaderPolicy('root');
    await api.revokeRootToken('root');
    expect(calls.map(({ path, method }) => [path, method])).toEqual([
      ['/v1/sys/seal-status', 'GET'], ['/v1/sys/init', 'POST'],
      ['/v1/auth/token/lookup-self', 'GET'], ['/v1/sys/policies/acl/loader-bootstrap', 'PUT'], ['/v1/auth/token/roles/loader-bootstrap', 'POST'],
      ['/v1/auth/token/revoke-self', 'POST'],
    ]);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ secret_shares: 1, secret_threshold: 1 });
    expect(calls.slice(2).every(({ token }) => token === 'root')).toBe(true);
  });

  it('initializes once, writes and reads custody before unsealing or using the root token, then retires it', async () => {
    const f = fixture();
    await f.bootstrap.runInitial();
    expect(f.events).toEqual(['init', 'custody-write', 'unseal:key-1', 'policy', 'revoke', 'custody-write']);
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

  it('resumes after root revocation but before the custody token is removed', async () => {
    const f = fixture(false, true);
    await expect(f.bootstrap.runInitial()).rejects.toThrow('crash during custody update');
    expect(f.tokenActive).toBe(false);
    // The custody token remains, but lookup-self identifies the exact crash cut.
    await f.bootstrap.runInitial();
    expect(f.events.filter((event) => event === 'init')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'policy')).toHaveLength(1);
    expect(f.keys).toEqual({ keys: ['key-1'], rootToken: null });
  });

  it('fails loudly with a named recovery error when initialized Bao has lost custody', async () => {
    const f = fixture(true);
    await expect(f.bootstrap.runInitial()).rejects.toThrow(/OpenBao is initialized but Secret openbao-unseal-custody is missing/);
    expect(f.events).not.toContain('init');
  });

  it('unseals a sealed restart without reinitializing', async () => {
    const f = fixture(true);
    f.keys = { keys: ['key-1'], rootToken: null };
    await f.bootstrap.unsealIfSealed();
    expect(f.events).toEqual(['unseal:key-1']);
    expect(f.events).not.toContain('init');
  });
});
