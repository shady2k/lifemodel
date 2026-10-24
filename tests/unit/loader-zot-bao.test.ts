import { describe, it, expect } from 'vitest';
import { createOpenBaoApi } from '../../loader/src/openbao.js';

const path = 'lifemodel/data/registry/zot';
function fixture(allow = true) {
  const calls: { path: string; method: string; payload: Record<string, unknown> }[] = [];
  let value: unknown = { username: 'loader', password: 'P'.repeat(43) };
  const api = createOpenBaoApi({
    address: 'http://bao.test',
    role: 'loader',
    readJwt: async () => 'jwt',
    request: async (url, method, _token, body) => {
      const payload = JSON.parse(body ?? '{}') as Record<string, unknown>;
      calls.push({ path: url.pathname, method, payload });
      if (url.pathname.endsWith('/auth/kubernetes/login'))
        return {
          status: 200,
          body: JSON.stringify({ auth: { client_token: 'token', lease_duration: 3600 } }),
        };
      if (url.pathname.endsWith('/sys/capabilities-self'))
        return {
          status: 200,
          body: JSON.stringify({ [path]: allow ? ['create', 'update', 'read'] : ['read'] }),
        };
      if (url.pathname.endsWith('/' + path) && method === 'GET')
        return {
          status: 200,
          body: JSON.stringify({ data: { data: value, metadata: { version: 1 } } }),
        };
      return { status: 204, body: '' };
    },
  });
  return {
    api,
    calls,
    set value(next: unknown) {
      value = next;
    },
  };
}
describe('zot OpenBao custody policy', () => {
  it('grants only the loader exact custody create/read/update and preserves existing roles', async () => {
    const f = fixture();
    await f.api.ensureRegistryPolicy('root');
    expect(
      f.calls.find((c) => c.path.endsWith('/sys/policies/acl/loader-registry'))?.payload
    ).toEqual({ policy: `path "${path}" { capabilities = ["create", "update", "read"] }` });
    expect(
      f.calls.find((c) => c.path.endsWith('/auth/kubernetes/role/loader'))?.payload
    ).toMatchObject({
      bound_service_account_names: ['loader'],
      bound_service_account_namespaces: ['lifemodel-system'],
      policies: ['loader', 'loader-model', 'loader-storage', 'loader-registry'],
    });
    expect(f.calls.filter((c) => c.path.includes('/role/')).length).toBe(1);
  });
  it('fails closed when policy verification loses write', async () => {
    await expect(fixture(false).api.ensureRegistryPolicy('root')).rejects.toThrow(
      'zot_policy_denied'
    );
  });
  it('reads and writes only the exact KV v2 path', async () => {
    const f = fixture();
    const credential = { username: 'loader', password: 'P'.repeat(43) };
    await expect(f.api.readRegistryCustody()).resolves.toEqual(credential);
    await f.api.writeRegistryCustody(credential);
    expect(f.calls.at(-1)).toMatchObject({
      path: '/v1/' + path,
      method: 'POST',
      payload: { data: credential },
    });
  });
});
