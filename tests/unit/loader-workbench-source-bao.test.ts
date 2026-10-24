import { describe, expect, it } from 'vitest';
import { createOpenBaoApi } from '../../loader/src/openbao.js';
const path = 'lifemodel/data/workbench/source';
const source = {
  registry: 'https://registry.example',
  repository: 'team/workbench',
  username: 'reader',
  password: 'SECRET_CANARY',
};
describe('workbench source OpenBao custody', () => {
  it('stores the credential in exact KV v2 record and reads it privately', async () => {
    let stored: unknown = null;
    const calls: { path: string; method: string; payload: unknown }[] = [];
    const api = createOpenBaoApi({
      address: 'http://bao.test',
      role: 'loader',
      readJwt: async () => 'jwt',
      request: async (url, method, _token, body) => {
        const payload = JSON.parse(body ?? '{}');
        calls.push({ path: url.pathname, method, payload });
        if (url.pathname.endsWith('/auth/kubernetes/login'))
          return {
            status: 200,
            body: JSON.stringify({ auth: { client_token: 'token', lease_duration: 3600 } }),
          };
        if (url.pathname.endsWith('/' + path)) {
          if (method === 'POST') {
            stored = payload.data;
            return { status: 204, body: '' };
          }
          return stored === null
            ? { status: 404, body: 'private body' }
            : {
                status: 200,
                body: JSON.stringify({ data: { data: stored, metadata: { version: 1 } } }),
              };
        }
        return { status: 204, body: '' };
      },
    });
    expect(await api.readWorkbenchSource()).toBeNull();
    await api.writeWorkbenchSource(source);
    expect(calls.at(-1)).toEqual({
      path: '/v1/' + path,
      method: 'POST',
      payload: { data: source },
    });
    expect(await api.readWorkbenchSource()).toEqual(source);
  });
  it('does not expose a response body on storage failure', async () => {
    const api = createOpenBaoApi({
      address: 'http://bao.test',
      role: 'loader',
      readJwt: async () => 'jwt',
      request: async (url) =>
        url.pathname.endsWith('/auth/kubernetes/login')
          ? {
              status: 200,
              body: JSON.stringify({ auth: { client_token: 'token', lease_duration: 3600 } }),
            }
          : { status: 500, body: 'SECRET_CANARY' },
    });
    await expect(api.readWorkbenchSource()).rejects.toThrow('workbench_source_unavailable');
    await expect(api.writeWorkbenchSource(source)).rejects.toThrow('workbench_source_unavailable');
  });
});
