import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKubernetesPostgresSecretPhase,
  createKubernetesCaptureSecretPhase,
} from '../../loader/src/postgres.js';

const encode = (value: string) => Buffer.from(value).toString('base64');

describe('CNPG application credential copy phase', () => {
  it('rereads the API token and CA on every copy attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cnpg-credential-rotation-'));
    try {
      const tokenFile = join(directory, 'token');
      const caFile = join(directory, 'ca');
      const seen: [string, string | undefined][] = [];
      const phase = createKubernetesPostgresSecretPhase({
        tokenFile,
        caFile,
        request: async (_url, _method, token, _body, ca) => {
          seen.push([token, ca?.toString()]);
          return { status: 404, body: '{}' };
        },
      });
      await writeFile(tokenFile, 'first-token');
      await writeFile(caFile, 'first-ca');
      await expect(phase.run()).rejects.toThrow('CNPG application Secret read failed');
      await writeFile(tokenFile, 'second-token');
      await writeFile(caFile, 'second-ca');
      await expect(phase.run()).rejects.toThrow('CNPG application Secret read failed');
      expect(seen).toEqual([
        ['first-token', 'first-ca'],
        ['second-token', 'second-ca'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('copies only the generated login into core and each module dedicated Secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cnpg-credentials-'));
    try {
      const tokenFile = join(directory, 'token');
      await writeFile(tokenFile, 'test-token');
      const calls: { method: string; path: string; body?: any }[] = [];
      // The platform precreates all targets, so each is replaced in place.
      const targets = new Map<string, Record<string, string>>([
        ['/api/v1/namespaces/lifemodel/secrets/lifemodel-db-credentials', {}],
        ['/api/v1/namespaces/lifemodel-system/secrets/storage-module-db-credentials', {}],
        ['/api/v1/namespaces/lifemodel-system/secrets/model-gateway-db-credentials', {}],
      ]);
      const phase = createKubernetesPostgresSecretPhase({
        apiServer: 'https://kubernetes.test',
        tokenFile,
        request: async (url, method, _token, body) => {
          const parsed = body === undefined ? undefined : JSON.parse(body);
          calls.push({
            method,
            path: url.pathname,
            ...(parsed === undefined ? {} : { body: parsed }),
          });
          if (url.pathname.endsWith('/lifemodel-state/secrets/lifemodel-app'))
            return {
              status: 200,
              body: JSON.stringify({
                data: {
                  username: encode('lifemodel'),
                  password: encode('generated-password'),
                  unrelated: encode('not-copied'),
                },
              }),
            };
          const target = targets.get(url.pathname);
          if (target !== undefined && method === 'GET')
            return {
              status: 200,
              body: JSON.stringify({ metadata: { resourceVersion: '1' }, data: target }),
            };
          if (target !== undefined && method === 'PUT') {
            targets.set(url.pathname, parsed.data);
            return { status: 200, body: '{}' };
          }
          return { status: 404, body: 'not found' };
        },
      });
      expect(phase.name).toBe('cnpg-copy-core-credentials');
      await phase.run();
      const writes = calls.filter((call) => call.method === 'PUT').map((call) => call.body);
      expect(writes).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'lifemodel-db-credentials',
            namespace: 'lifemodel',
            annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
          }),
          data: { username: encode('lifemodel'), password: encode('generated-password') },
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'storage-module-db-credentials',
            namespace: 'lifemodel-system',
            annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
          }),
          data: { username: encode('lifemodel'), password: encode('generated-password') },
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'model-gateway-db-credentials',
            namespace: 'lifemodel-system',
            annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
          }),
          data: { username: encode('lifemodel'), password: encode('generated-password') },
        }),
      ]);
      for (const write of writes) expect(write.data).not.toHaveProperty('unrelated');
      // The core copy first, then the module's; each is read back.
      expect(calls.map(({ method, path }) => [method, path])).toEqual([
        ['GET', '/api/v1/namespaces/lifemodel-state/secrets/lifemodel-app'],
        ['GET', '/api/v1/namespaces/lifemodel/secrets/lifemodel-db-credentials'],
        ['PUT', '/api/v1/namespaces/lifemodel/secrets/lifemodel-db-credentials'],
        ['GET', '/api/v1/namespaces/lifemodel/secrets/lifemodel-db-credentials'],
        ['GET', '/api/v1/namespaces/lifemodel-system/secrets/storage-module-db-credentials'],
        ['PUT', '/api/v1/namespaces/lifemodel-system/secrets/storage-module-db-credentials'],
        ['GET', '/api/v1/namespaces/lifemodel-system/secrets/storage-module-db-credentials'],
        ['GET', '/api/v1/namespaces/lifemodel-system/secrets/model-gateway-db-credentials'],
        ['PUT', '/api/v1/namespaces/lifemodel-system/secrets/model-gateway-db-credentials'],
        ['GET', '/api/v1/namespaces/lifemodel-system/secrets/model-gateway-db-credentials'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates an absent core copy and only updates platform-created system copies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cnpg-credentials-'));
    try {
      const tokenFile = join(directory, 'token');
      await writeFile(tokenFile, 'test-token');
      const calls: { method: string; path: string }[] = [];
      // One store per target path: a created core copy is not the module's.
      const created = new Map<string, Record<string, string>>([
        ['/api/v1/namespaces/lifemodel-system/secrets/storage-module-db-credentials', {}],
        ['/api/v1/namespaces/lifemodel-system/secrets/model-gateway-db-credentials', {}],
      ]);
      const phase = createKubernetesPostgresSecretPhase({
        apiServer: 'https://kubernetes.test',
        tokenFile,
        request: async (url, method, _token, body) => {
          calls.push({ method, path: url.pathname });
          if (url.pathname.endsWith('/lifemodel-state/secrets/lifemodel-app'))
            return {
              status: 200,
              body: JSON.stringify({
                data: { username: encode('lifemodel'), password: encode('generated-password') },
              }),
            };
          if (method === 'PUT') {
            created.set(url.pathname, JSON.parse(body!).data);
            return { status: 200, body: '{}' };
          }
          if (method === 'POST') {
            expect(url.pathname).toBe('/api/v1/namespaces/lifemodel/secrets');
            const payload = JSON.parse(body!) as {
              metadata: { name: string };
              data: Record<string, string>;
            };
            created.set(`${url.pathname}/${payload.metadata.name}`, payload.data);
            return { status: 201, body: '{}' };
          }
          const data = created.get(url.pathname);
          if (data === undefined) return { status: 404, body: 'not found' };
          return {
            status: 200,
            body: JSON.stringify({ metadata: { resourceVersion: '1' }, data }),
          };
        },
      });
      await phase.run();
      expect([...created.keys()].sort()).toEqual([
        '/api/v1/namespaces/lifemodel-system/secrets/model-gateway-db-credentials',
        '/api/v1/namespaces/lifemodel-system/secrets/storage-module-db-credentials',
        '/api/v1/namespaces/lifemodel/secrets/lifemodel-db-credentials',
      ]);
      for (const data of created.values())
        expect(data).toEqual({
          username: encode('lifemodel'),
          password: encode('generated-password'),
        });
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'creates one durable capture login and reuses it after a restart (conflict=%s)',
    async (conflict) => {
      const directory = await mkdtemp(join(tmpdir(), 'cnpg-capture-'));
      try {
        const tokenFile = join(directory, 'token');
        await writeFile(tokenFile, 'test-token');
        const secrets = new Map<
          string,
          { metadata: { resourceVersion: string }; data: Record<string, string> }
        >([
          [
            '/api/v1/namespaces/lifemodel-system/secrets/model-capture-db-credentials',
            { metadata: { resourceVersion: '1' }, data: {} },
          ],
        ]);
        const sourcePath =
          '/api/v1/namespaces/lifemodel-state/secrets/lifemodel-capture-credentials';
        let generated = 0;
        let sourceCreates = 0;
        const options = {
          apiServer: 'https://kubernetes.test',
          tokenFile,
          randomPassword: () => {
            generated++;
            return 'new-capture-password';
          },
          request: async (url: URL, method: string, _token: string, body: string | undefined) => {
            expect(url.pathname).not.toMatch(
              /lifemodel-app|lifemodel-db-credentials|storage-module-db-credentials|model-gateway-db-credentials/
            );
            if (method === 'POST') {
              const parsed = JSON.parse(body!);
              const path = `${url.pathname}/${parsed.metadata.name}`;
              if (path === sourcePath) {
                sourceCreates++;
                expect(parsed.type).toBe('kubernetes.io/basic-auth');
                expect(parsed.metadata.labels).toEqual({ 'cnpg.io/reload': 'true' });
                expect(parsed.data.username).toBe(encode('lifemodel_capture_writer'));
                if (conflict) {
                  parsed.data.password = encode('winning-password');
                  // An older, unlabeled Secret won the create race.
                  delete parsed.metadata.labels;
                }
              }
              const secret = { ...parsed, metadata: { ...parsed.metadata, resourceVersion: '1' } };
              secrets.set(path, secret);
              return {
                status: path === sourcePath && conflict ? 409 : 201,
                body: JSON.stringify(secret),
              };
            }
            if (method === 'PUT' || method === 'PATCH') {
              expect(url.pathname).not.toBe(sourcePath);
              expect(method).toBe('PUT');
              const parsed = JSON.parse(body!);
              secrets.set(url.pathname, parsed);
              return { status: 200, body: JSON.stringify(parsed) };
            }
            const secret = secrets.get(url.pathname);
            return { status: secret ? 200 : 404, body: JSON.stringify(secret ?? {}) };
          },
        };
        await createKubernetesCaptureSecretPhase(options).run();
        await createKubernetesCaptureSecretPhase(options).run();
        expect(generated).toBe(1);
        expect(sourceCreates).toBe(1);
        expect(secrets.get(sourcePath)?.metadata).toEqual(
          expect.objectContaining(
            conflict ? { resourceVersion: '1' } : { labels: { 'cnpg.io/reload': 'true' } }
          )
        );
        if (conflict) expect(secrets.get(sourcePath)?.metadata).not.toHaveProperty('labels');
        expect(
          secrets.get('/api/v1/namespaces/lifemodel-system/secrets/model-capture-db-credentials')
            ?.data
        ).toEqual({
          username: encode('lifemodel_capture_writer'),
          password: encode(conflict ? 'winning-password' : 'new-capture-password'),
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['application', 'capture'] as const)(
    'does not attempt an unauthorized system Secret create (%s)',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'cnpg-system-placeholder-'));
      try {
        const tokenFile = join(directory, 'token');
        await writeFile(tokenFile, 'test-token');
        const request = async (url: URL, method: string) => {
          expect(method).toBe('GET');
          const source =
            url.pathname.includes('/lifemodel-state/') ||
            url.pathname.includes('/lifemodel/secrets/');
          return source
            ? {
                status: 200,
                body: JSON.stringify({
                  metadata: { resourceVersion: '1' },
                  data: {
                    username: encode(mode === 'capture' ? 'lifemodel_capture_writer' : 'lifemodel'),
                    password: encode('password'),
                  },
                }),
              }
            : { status: 404, body: '{}' };
        };
        // The application phase updates core before reaching its first system copy.
        const options = {
          tokenFile,
          request: async (url: URL, method: string) => {
            if (method === 'PUT' && url.pathname.includes('/lifemodel/secrets/'))
              return { status: 200, body: '{}' };
            return request(url, method);
          },
        };
        const phase =
          mode === 'capture'
            ? createKubernetesCaptureSecretPhase(options)
            : createKubernetesPostgresSecretPhase(options);
        await expect(phase.run()).rejects.toThrow('must be platform-created');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('fails when a Kubernetes API response stalls past the total deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cnpg-credentials-'));
    try {
      const tokenFile = join(directory, 'token');
      await writeFile(tokenFile, 'test-token');
      const phase = createKubernetesPostgresSecretPhase({
        tokenFile,
        timeoutMs: 20,
        request: () => new Promise(() => undefined),
      });
      await expect(phase.run()).rejects.toThrow(/timed out/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed until the generated CNPG application Secret exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cnpg-credentials-'));
    try {
      const tokenFile = join(directory, 'token');
      await writeFile(tokenFile, 'test-token');
      const phase = createKubernetesPostgresSecretPhase({
        tokenFile,
        request: async () => ({ status: 404, body: 'missing' }),
      });
      await expect(phase.run()).rejects.toThrow('CNPG application Secret read failed (404)');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
