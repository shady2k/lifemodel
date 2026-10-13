import { describe, expect, it } from 'vitest';
import { createKubernetesPhaseStore, createPlatformPhaseRunner, type PlatformPhaseStore } from '../../loader/src/platform-bootstrap.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('platform bootstrap phases', () => {
  it('writes and reads back each phase before and after its side effect, then resumes without repeating completed work', async () => {
    const events: string[] = [];
    let record: { phase: string; status: 'running' | 'complete' } | null = null;
    const store: PlatformPhaseStore = {
      read: async () => { events.push('read'); return record; },
      write: async (next) => { events.push(`write:${next.phase}:${next.status}`); record = next; },
    };
    const run = createPlatformPhaseRunner(store);
    const effects: string[] = [];
    await run([{ name: 'custody', run: async () => { events.push('effect:custody'); effects.push('custody'); } }, { name: 'unseal', run: async () => { events.push('effect:unseal'); effects.push('unseal'); } }]);
    expect(events).toEqual([
      'read', 'write:custody:running', 'read', 'effect:custody', 'write:custody:complete', 'read', 'read',
      'write:unseal:running', 'read', 'effect:unseal', 'write:unseal:complete', 'read',
    ]);
    events.length = 0;
    await run([{ name: 'custody', run: async () => { effects.push('custody'); } }, { name: 'unseal', run: async () => { effects.push('unseal'); } }, { name: 'gitea', run: async () => { effects.push('gitea'); } }]);
    expect(effects).toEqual(['custody', 'unseal', 'gitea']);
    expect(record).toEqual({ phase: 'gitea', status: 'complete' });
  });

  it('resumes a running phase after a crash without repeating earlier completed effects', async () => {
    let record: { phase: string; status: 'running' | 'complete' } | null = null;
    const effects: string[] = [];
    const store: PlatformPhaseStore = {
      read: async () => record,
      write: async (next) => { record = next; },
    };
    const run = createPlatformPhaseRunner(store);
    const custody = { name: 'custody', run: async () => { effects.push('custody'); } };
    await run([custody]);
    const unstable = { name: 'unseal', run: async () => { effects.push('unseal'); throw new Error('crash'); } };
    await expect(run([custody, unstable])).rejects.toThrow('crash');
    await run([custody, { name: 'unseal', run: async () => { effects.push('unseal'); } }]);
    expect(effects).toEqual(['custody', 'unseal', 'unseal']);
    expect(record).toEqual({ phase: 'unseal', status: 'complete' });
  });

  it('stores phase records in only the named in-cluster Secret and verifies API read-back', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    let secret: Record<string, unknown> | null = { metadata: { name: 'loader-bootstrap-state', namespace: 'lifemodel-system', resourceVersion: '1' }, data: {} };
    // Filesystem access is the real ServiceAccount-token boundary.
    const directory = await mkdtemp(join(tmpdir(), 'loader-platform-'));
    const tokenPath = join(directory, 'token');
    await writeFile(tokenPath, 'service-token');
    const client = createKubernetesPhaseStore({
      apiServer: 'https://kubernetes.test', tokenFile: tokenPath, caFile: '/missing-ca',
      request: async (url, method, token, body) => {
        expect(token).toBe('service-token'); calls.push({ path: url.pathname, method });
        if (method === 'GET') return secret === null ? { status: 404, body: '' } : { status: 200, body: JSON.stringify(secret) };
        expect(method).toBe('PUT');
        secret = JSON.parse(body ?? '{}') as Record<string, unknown>;
        const metadata = secret['metadata'] as Record<string, unknown>; metadata['resourceVersion'] = '2';
        return { status: 200, body: JSON.stringify(secret) };
      },
    });
    try {
      await client.write({ phase: 'custody', status: 'running' });
      expect(await client.read()).toEqual({ phase: 'custody', status: 'running' });
      expect(calls.every(({ path }) => path === '/api/v1/namespaces/lifemodel-system/secrets/loader-bootstrap-state')).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('declares only phase and custody Secret grants for the loader ServiceAccount', async () => {
    const [role, binding, account] = await Promise.all([
      readFile('deploy/platform/a0/service-account.yaml', 'utf8'),
      readFile('deploy/platform/a0/service-account.yaml', 'utf8'),
      readFile('deploy/platform/a0/service-account.yaml', 'utf8'),
    ]);
    expect(role).toContain('resources: ["secrets"]');
    expect(role).toContain('- loader-bootstrap-state');
    expect(role).toContain('- openbao-unseal-custody');
    expect(role).not.toMatch(/pods|configmaps|kustomizations|gitrepositories|roles|serviceaccounts/);
    expect(role).toContain('verbs: ["get", "update"]');
    expect(role).not.toContain('create');
    expect(binding).toContain('kind: ServiceAccount');
    expect(binding).toContain('name: loader');
    expect(account).toContain('automountServiceAccountToken: true');
  });
});
