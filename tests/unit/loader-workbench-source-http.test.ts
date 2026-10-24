import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp } from '../../loader/src/http.js';
import { createSession, csrfToken, hashPassword } from '../../loader/src/auth.js';
import { loadConfig } from '../../loader/src/config.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import type { WorkbenchSource } from '../../loader/src/workbench-source.js';
import { createSettingsStore } from '../../loader/src/settings/store.js';
import { platformSettings } from '../../loader/src/settings/platform.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
const servers: ReturnType<typeof createLoaderHttp>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fixture() {
  const record = await hashPassword('owner password');
  const clock = createTestClock();
  const token = createSession(record, clock.now());
  const logs: RecordedLine[] = [];
  let source: WorkbenchSource = {
    registry: 'https://registry.example',
    repository: 'team/workbench',
    username: 'reader',
    password: 'SECRET_CANARY',
  };
  let triggers = 0;
  const loader = createLoaderHttp({
    state: {
      ensureLayout: async () => {},
      readAuth: async () => record,
      writeAuth: async () => {},
      replaceAuth: async () => {},
    },
    clock,
    config: loadConfig({ LIFEMODEL_NAME: 'lifemodel' }),
    logger: createRecordingLogger(logs),
    settings: createSettingsStore({
      fs: createNodeFileSystem(),
      config: { loaderDir: '/not-read-by-this-test' },
      registry: platformSettings,
      clock,
      logger: createRecordingLogger(logs),
    }),
    pki: {
      bootstrap: async () => {},
      caPem: async () => 'CA',
      report: async () => ({
        identity: 'present',
        ca: 'present-matching',
        leaf: 'valid',
        sans: [],
        fingerprint: 'x',
      }),
    },
    workbench: {
      read: async () => source,
      write: async (v) => {
        source = v;
      },
      status: async () => ({
        state: 'failed',
        lastAttemptAt: 123,
        reason: 'unavailable',
        pinnedDigest: 'sha256:' + 'a'.repeat(64),
        password: 'SECRET_CANARY',
      }),
      retrigger: async () => {
        triggers++;
      },
    },
  });
  servers.push(loader);
  await new Promise<void>((resolve) => loader.server.listen(0, '127.0.0.1', resolve));
  const address = loader.server.address();
  if (!address || typeof address === 'string') throw Error('bind');
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {}
  ) {
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method,
            headers: {
              host: 'boot-lifemodel.local',
              origin: 'https://boot-lifemodel.local',
              cookie: '__Host-lm_session=' + token,
              'x-csrf-token': csrfToken(record, token),
              'content-type': 'application/json',
              ...headers,
            },
          },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers })
            );
          }
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      }
    );
  }
  return {
    request,
    logs,
    get source() {
      return source;
    },
    get triggers() {
      return triggers;
    },
  };
}
describe('workbench source HTTP boundary', () => {
  it('returns only safe source and safe status fields', async () => {
    const f = await fixture();
    const response = await f.request('/api/workbench-source');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      registry: 'https://registry.example',
      repository: 'team/workbench',
      username: 'reader',
      hasPassword: true,
    });
    const status = await f.request('/api/workbench-status');
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ state: 'failed', lastAttemptAt: 123 });
    const dump = await f.request('/api/settings');
    expect(dump.status).toBe(200);
    expect(response.body + status.body + dump.body + JSON.stringify(f.logs)).not.toContain(
      'SECRET_CANARY'
    );
    expect(JSON.parse(dump.body).values).not.toHaveProperty('workbench.source');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('saves before retrigger, preserves omitted password, and clears explicitly', async () => {
    const f = await fixture();
    const response = await f.request('/api/workbench-source', 'PUT', {
      registry: 'https://registry.example',
      repository: 'team/workbench',
      username: 'reader',
    });
    expect(response.status).toBe(200);
    expect(f.source.password).toBe('SECRET_CANARY');
    expect(f.triggers).toBe(1);
    expect(response.body).not.toContain('SECRET_CANARY');
    expect(
      (
        await f.request('/api/workbench-source', 'PUT', {
          registry: 'https://registry.example',
          repository: 'team/workbench',
          username: 'reader',
          password: '',
        })
      ).status
    ).toBe(200);
    expect(f.source.password).toBeUndefined();
    expect(f.source.username).toBeUndefined();
  });
  it('refuses missing replacement password on changed source or username', async () => {
    const f = await fixture();
    for (const candidate of [
      {
        registry: 'https://registry.example',
        repository: 'team/workbench',
        username: 'new-reader',
      },
      { registry: 'https://other.example', repository: 'team/workbench', username: 'reader' },
    ]) {
      const response = await f.request('/api/workbench-source', 'PUT', candidate);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: 'invalid_source',
        fields: { password: 'required_for_username' },
      });
    }
    expect(f.triggers).toBe(0);
  });
  it('returns safe field reasons and does not retrigger invalid saves', async () => {
    const f = await fixture();
    const response = await f.request('/api/workbench-source', 'PUT', {
      registry: 'https://reader:SECRET_CANARY@registry.example',
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'invalid_source',
      fields: { registry: expect.any(String), repository: expect.any(String) },
    });
    expect(response.body + JSON.stringify(f.logs)).not.toContain('SECRET_CANARY');
    expect(f.triggers).toBe(0);
  });
  it('requires session, same origin and CSRF, and limits methods', async () => {
    const f = await fixture();
    expect(
      (await f.request('/api/workbench-source', 'GET', undefined, { cookie: '' })).status
    ).toBe(403);
    expect(
      (
        await f.request('/api/workbench-status', 'GET', undefined, {
          origin: 'https://attacker.example',
        })
      ).status
    ).toBe(403);
    expect(
      (await f.request('/api/workbench-source', 'PUT', {}, { 'x-csrf-token': '' })).status
    ).toBe(403);
    expect((await f.request('/api/workbench-source', 'POST', {})).status).toBe(405);
  });
});
