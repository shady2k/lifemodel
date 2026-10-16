import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKubernetesTlsStores } from '../../loader/src/pki-kubernetes.js';

describe('A0 PKI Kubernetes stores', () => {
  it('gets and updates only the precreated Secret and ConfigMap by name', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    let secret: any = { metadata: { resourceVersion: '1' }, data: {} };
    let cm: any = { metadata: { resourceVersion: '1' }, data: {} };
    const fake = async (url: URL, method: string, _token: string, body?: string) => {
      calls.push({ url: url.toString(), method, body });
      const target = url.pathname.endsWith('/lifemodel-tls') ? secret : cm;
      if (method === 'GET') return { status: 200, body: JSON.stringify(target) };
      const next = JSON.parse(body!) as any;
      next.metadata.resourceVersion = '2';
      if (url.pathname.endsWith('/lifemodel-tls')) secret = next;
      else cm = next;
      return { status: 200, body: JSON.stringify(next) };
    };
    const dir = mkdtempSync(join(tmpdir(), 'kube-pki-'));
    writeFileSync(join(dir, 'token'), 'test-token');
    const stores = createKubernetesTlsStores({
      apiServer: 'https://kubernetes.test',
      tokenFile: join(dir, 'token'),
      caFile: join(dir, 'ca'),
      request: async (url, method, _token, body) => fake(url, method, _token, body),
    });
    await stores.secret.write('CA', 'CERT', 'KEY');
    await stores.configMap.write('CA');
    expect((await stores.secret.read()).cert).toBe('CERT');
    expect(await stores.configMap.read()).toBe('CA');
    expect(calls.every((c) => c.url.includes('/namespaces/lifemodel-system/'))).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(
      expect.arrayContaining([
        '/api/v1/namespaces/lifemodel-system/secrets/lifemodel-tls',
        '/api/v1/namespaces/lifemodel-system/configmaps/lifemodel-ca',
      ])
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
