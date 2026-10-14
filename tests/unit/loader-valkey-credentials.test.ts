import { describe, expect, it } from 'vitest';
import { createKubernetesValkeySecretPhase } from '../../loader/src/valkey.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Valkey password bootstrap phase', () => {
  it('generates once, retains the state Secret, and copies the same password to lifemodel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'valkey-secret-'));
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, 'test-token');
    try {
    const secrets = new Map<string, { data: { password: string }; metadata: { resourceVersion: string } }>();
    const requests: string[] = [];
    let generated = 0;
    const phase = createKubernetesValkeySecretPhase({
      apiServer: 'https://kubernetes.test',
      tokenFile,
      randomPassword: () => { generated += 1; return 'durable-test-password'; },
      request: async (url, method, _token, body) => {
        const match = url.pathname.match(/\/namespaces\/([^/]+)\/secrets(?:\/([^/]+))?$/);
        if (!match) throw new Error(`unexpected URL ${url.pathname}`);
        const key = `${match[1]}/secrets/${match[2] ?? ''}`;
        requests.push(`${method} ${url.pathname}`);
        if (method === 'GET') {
          const secret = secrets.get(key);
          return secret ? { status: 200, body: JSON.stringify(secret) } : { status: 404, body: '' };
        }
        if (method === 'POST') {
          const payload = JSON.parse(body ?? '{}') as { metadata: { namespace: string; name: string }; data: { password: string } };
          const secretKey = `${payload.metadata.namespace}/secrets/${payload.metadata.name}`;
          const secret = { data: payload.data, metadata: { resourceVersion: '1' } };
          secrets.set(secretKey, secret);
          return { status: 201, body: JSON.stringify(secret) };
        }
        if (method === 'PUT') {
          const payload = JSON.parse(body ?? '{}') as { metadata: { namespace: string; name: string; resourceVersion: string }; data: { password: string } };
          const secretKey = `${payload.metadata.namespace}/secrets/${payload.metadata.name}`;
          const secret = { data: payload.data, metadata: { resourceVersion: '2' } };
          secrets.set(secretKey, secret);
          return { status: 200, body: JSON.stringify(secret) };
        }
        throw new Error(`unexpected request ${method}`);
      },
    });
    await phase.run();
    await phase.run();
    const stored = secrets.get('lifemodel-state/secrets/lifemodel-valkey-credentials');
    const copied = secrets.get('lifemodel/secrets/lifemodel-valkey-credentials');
    expect(generated).toBe(1);
    expect(stored?.data.password).toBe(Buffer.from('durable-test-password').toString('base64'));
    expect(copied?.data.password).toBe(stored?.data.password);
    expect(requests).toContain('PUT /api/v1/namespaces/lifemodel/secrets/lifemodel-valkey-credentials');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails when a Kubernetes API response stalls past the total deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'valkey-secret-'));
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, 'test-token');
    try {
      const phase = createKubernetesValkeySecretPhase({
        tokenFile,
        timeoutMs: 20,
        request: () => new Promise(() => undefined),
      });
      await expect(phase.run()).rejects.toThrow(/timed out/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reuses the generated source password after a failed create call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'valkey-secret-'));
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, 'test-token');
    try {
      let generated = 0;
      const posted: string[] = [];
      let failFirstCreate = true;
      const phase = createKubernetesValkeySecretPhase({
        tokenFile,
        randomPassword: () => { generated += 1; return `password-${generated}`; },
        request: async (_url, method, _token, body) => {
          if (method === 'GET') return { status: 404, body: '' };
          const password = (JSON.parse(body ?? '{}') as { data: { password: string } }).data.password;
          posted.push(password);
          if (failFirstCreate) {
            failFirstCreate = false;
            throw new Error('temporary API failure');
          }
          return { status: 500, body: 'still unavailable' };
        },
      });
      await expect(phase.run()).rejects.toThrow('temporary API failure');
      await expect(phase.run()).rejects.toThrow('Valkey password Secret create failed');
      expect(generated).toBe(1);
      expect(posted).toEqual([Buffer.from('password-1').toString('base64'), Buffer.from('password-1').toString('base64')]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
