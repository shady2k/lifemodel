import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKubernetesPostgresSecretPhase } from '../../loader/src/postgres.js';

const encode = (value: string) => Buffer.from(value).toString('base64');

describe('CNPG core credential copy phase', () => {
  it('copies only the generated login into the core namespace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cnpg-credentials-'));
    try {
      const tokenFile = join(directory, 'token');
      await writeFile(tokenFile, 'test-token');
      const calls: { method: string; path: string; body?: any }[] = [];
      let targetData: Record<string, string> | undefined;
      const phase = createKubernetesPostgresSecretPhase({
        apiServer: 'https://kubernetes.test', tokenFile,
        request: async (url, method, _token, body) => {
          const parsed = body === undefined ? undefined : JSON.parse(body);
          calls.push({ method, path: url.pathname, ...(parsed === undefined ? {} : { body: parsed }) });
          if (url.pathname.endsWith('/lifemodel-state/secrets/lifemodel-app'))
            return { status: 200, body: JSON.stringify({ data: { username: encode('lifemodel'), password: encode('generated-password'), unrelated: encode('not-copied') } }) };
          if (method === 'GET' && targetData !== undefined) return { status: 200, body: JSON.stringify({ data: targetData }) };
          if (method === 'GET') return { status: 404, body: 'not found' };
          targetData = parsed.data;
          return { status: 201, body: '{}' };
        },
      });
      expect(phase.name).toBe('cnpg-copy-core-credentials');
      await phase.run();
      const created = calls.find((call) => call.method === 'POST')!.body;
      expect(created).toMatchObject({ metadata: { name: 'lifemodel-db-credentials', namespace: 'lifemodel', annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' } }, data: { username: encode('lifemodel'), password: encode('generated-password') } });
      expect(created.data).not.toHaveProperty('unrelated');
      expect(calls.map(({ method, path }) => [method, path])).toEqual([
        ['GET', '/api/v1/namespaces/lifemodel-state/secrets/lifemodel-app'],
        ['GET', '/api/v1/namespaces/lifemodel/secrets/lifemodel-db-credentials'],
        ['POST', '/api/v1/namespaces/lifemodel/secrets'],
        ['GET', '/api/v1/namespaces/lifemodel/secrets/lifemodel-db-credentials'],
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

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
      const phase = createKubernetesPostgresSecretPhase({ tokenFile, request: async () => ({ status: 404, body: 'missing' }) });
      await expect(phase.run()).rejects.toThrow('CNPG application Secret read failed (404)');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
