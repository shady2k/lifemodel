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
});
