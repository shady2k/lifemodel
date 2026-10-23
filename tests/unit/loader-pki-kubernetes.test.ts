import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKubernetesTlsStores } from '../../loader/src/pki-kubernetes.js';

describe('A0 PKI Kubernetes stores', () => {
  it('rereads the projected token and CA for every operation and bounds stalled requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kube-pki-rotation-'));
    try {
      const tokenFile = join(dir, 'token');
      const caFile = join(dir, 'ca');
      writeFileSync(tokenFile, 'first-token');
      writeFileSync(caFile, 'first-ca');
      const seen: [string, string | undefined][] = [];
      const stores = createKubernetesTlsStores({
        tokenFile,
        caFile,
        request: async (_url, _method, token, _body, ca) => {
          seen.push([token, ca?.toString()]);
          return { status: 404, body: '{}' };
        },
      });
      await stores.taskModelSecret.read();
      writeFileSync(tokenFile, 'second-token');
      writeFileSync(caFile, 'second-ca');
      await stores.taskModelSecret.read();
      expect(seen).toEqual([
        ['first-token', 'first-ca'],
        ['second-token', 'second-ca'],
      ]);
      const stalled = createKubernetesTlsStores({
        tokenFile,
        caFile,
        timeoutMs: 20,
        request: () => new Promise(() => undefined),
      });
      await expect(stalled.taskModelSecret.read()).rejects.toThrow('timed out');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ['taskModelSecret', 'lifemodel-system', 'model-gateway-task-tls'],
    ['taskChannelSecret', 'lifemodel', 'core-task-channel-tls'],
  ] as const)(
    'writes and reads back %s without touching another Secret',
    async (storeName, namespace, name) => {
      const dir = mkdtempSync(join(tmpdir(), 'kube-task-model-pki-'));
      try {
        writeFileSync(join(dir, 'token'), 'test-token');
        const calls: { path: string; method: string }[] = [];
        let secret: any = { metadata: { resourceVersion: '1' }, data: {} };
        const stores = createKubernetesTlsStores({
          apiServer: 'https://kubernetes.test',
          tokenFile: join(dir, 'token'),
          caFile: join(dir, 'ca'),
          request: async (url, method, token, body) => {
            expect(token).toBe('test-token');
            calls.push({ path: url.pathname, method });
            if (method === 'PUT') secret = JSON.parse(body!);
            return { status: 200, body: JSON.stringify(secret) };
          },
        });
        await stores[storeName].write('CA', 'CERT', 'KEY');
        expect(await stores[storeName].read()).toEqual({ ca: 'CA', cert: 'CERT', key: 'KEY' });
        expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
        expect(new Set(calls.map((call) => call.path))).toEqual(
          new Set([`/api/v1/namespaces/${namespace}/secrets/${name}`])
        );
        expect(secret.metadata.name).toBe(name);
        expect(secret.metadata.namespace).toBe(namespace);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
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
    expect(
      calls.every(
        (c) =>
          c.url.includes('/namespaces/lifemodel-system/') ||
          [
            '/api/v1/namespaces/lifemodel/configmaps/lifemodel-ca',
            '/api/v1/namespaces/lifemodel-motor/configmaps/lifemodel-ca',
          ].includes(new URL(c.url).pathname)
      )
    ).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(
      expect.arrayContaining([
        '/api/v1/namespaces/lifemodel-system/secrets/lifemodel-tls',
        '/api/v1/namespaces/lifemodel-system/configmaps/lifemodel-ca',
        '/api/v1/namespaces/lifemodel-motor/configmaps/lifemodel-ca',
      ])
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(4);
    rmSync(dir, { recursive: true, force: true });
  });
});
