import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp } from '../../loader/src/http.js';
import { createSession, csrfToken, hashPassword } from '../../loader/src/auth.js';
import { loadConfig } from '../../loader/src/config.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import type { ModelCaptureSetting } from '../../loader/src/model-capture-setting.js';
import { createSettingsStore } from '../../loader/src/settings/store.js';
import { platformSettings } from '../../loader/src/settings/platform.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
const servers: ReturnType<typeof createLoaderHttp>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fixture(unavailable = false) {
  const record = await hashPassword('owner password');
  const clock = createTestClock();
  const token = createSession(record, clock.now());
  const logs: RecordedLine[] = [];
  let setting: ModelCaptureSetting = { until: null };
  const writes: ModelCaptureSetting[] = [];
  const loader = createLoaderHttp({
    state: {
      ensureLayout: async () => {},
      readAuth: async () => {
        return record;
      },
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
    modelCapture: {
      read: async () => {
        if (unavailable) throw new Error('PRIVATE_STORAGE_ERROR');
        return setting;
      },
      write: async (value) => {
        if (unavailable) throw new Error('PRIVATE_STORAGE_ERROR');
        setting = value;
        writes.push(value);
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
    writes,
    clock,
    get setting() {
      return setting;
    },
  };
}
describe('capture setting HTTP boundary', () => {
  it('starts off, enables a bounded session-filtered window, expires and turns off explicitly', async () => {
    const f = await fixture();
    const initial = await f.request('/api/model-capture');
    expect(initial.status).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(initial.body)).toEqual({ until: null });
    const setting = { until: new Date(f.clock.now() + 600_000).toISOString(), session: 'chat-1' };
    expect(
      (await f.request('/api/model-capture', 'PUT', { durationMs: 600_000, session: 'chat-1' }))
        .status
    ).toBe(200);
    expect(f.setting).toEqual(setting);
    expect(JSON.parse((await f.request('/api/model-capture')).body)).toEqual(setting);
    f.clock.advance(600_000);
    expect(JSON.parse((await f.request('/api/model-capture')).body)).toEqual({ until: null });
    expect((await f.request('/api/model-capture', 'PUT', { durationMs: null })).status).toBe(200);
    expect(f.writes.at(-1)).toEqual({ until: null });
  });
  it('sets a full 24-hour expiry from server time, returns it and stores no duration', async () => {
    const f = await fixture();
    const expected = { until: new Date(f.clock.now() + 86_400_000).toISOString() };
    const response = await f.request('/api/model-capture', 'PUT', { durationMs: 86_400_000 });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expected);
    expect(f.writes).toEqual([expected]);
    expect(JSON.parse((await f.request('/api/model-capture')).body)).toEqual(expected);
  });
  it('enables until disabled explicitly, preserves its session scope and disables it', async () => {
    const f = await fixture();
    const expected = { until: 'until-disabled', session: 'chat-1' };
    const response = await f.request('/api/model-capture', 'PUT', {
      mode: 'until-disabled',
      session: 'chat-1',
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expected);
    expect(f.writes).toEqual([expected]);
    expect(f.setting).toEqual(expected);
    expect(JSON.parse((await f.request('/api/model-capture')).body)).toEqual(expected);
    const off = await f.request('/api/model-capture', 'PUT', { durationMs: null });
    expect(off.status).toBe(200);
    expect(JSON.parse(off.body)).toEqual({ until: null });
    expect(f.writes.at(-1)).toEqual({ until: null });
  });
  it('rejects nonpositive, over-24h and malformed mode/session requests before storage', async () => {
    const f = await fixture();
    for (const value of [
      {},
      { durationMs: '600000' },
      { mode: 'forever' },
      { mode: 'until-disabled', durationMs: null },
      { mode: 'until-disabled', durationMs: 600_000 },
      { mode: 'until-disabled', until: null },
      { mode: 'until-disabled', session: 'bad session' },
      { mode: 'until-disabled', extra: true },
      { durationMs: 0 },
      { durationMs: -1 },
      { durationMs: 86_400_001 },
      { durationMs: 600_000, session: 'bad session' },
      { durationMs: null, session: 'chat-1' },
      { durationMs: null, extra: true },
      { until: null },
      { until: new Date(f.clock.now() + 600_000).toISOString() },
      { durationMs: 600_000, until: new Date(f.clock.now() + 600_000).toISOString() },
    ]) {
      const response = await f.request('/api/model-capture', 'PUT', value);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'capture_setting_invalid' });
    }
    expect(f.writes).toEqual([]);
  });
  it.each([
    ['read authentication', 'GET', undefined, { cookie: '' }, 403],
    ['read origin', 'GET', undefined, { origin: 'https://attacker.example' }, 403],
    ['read fetch site', 'GET', undefined, { 'sec-fetch-site': 'cross-site' }, 403],
    ['write authentication', 'PUT', { durationMs: null }, { cookie: '' }, 401],
    ['write CSRF', 'PUT', { durationMs: null }, { 'x-csrf-token': '' }, 403],
    ['write origin', 'PUT', { durationMs: null }, { origin: 'https://attacker.example' }, 403],
    ['JSON content type', 'PUT', {}, { 'content-type': 'text/plain' }, 415],
    ['POST method', 'POST', {}, {}, 405],
    ['DELETE method', 'DELETE', {}, {}, 405],
    ['body bound', 'PUT', { padding: 'x'.repeat(9000) }, {}, 413],
  ] as const)('requires %s', async (_name, method, body, headers, status) => {
    const f = await fixture();
    expect((await f.request('/api/model-capture', method, body, headers)).status).toBe(status);
    expect(f.writes).toEqual([]);
  });
  it('returns bounded storage errors, never private exception text', async () => {
    const f = await fixture(true);
    const read = await f.request('/api/model-capture');
    const write = await f.request('/api/model-capture', 'PUT', { durationMs: null });
    expect(read.status).toBe(503);
    expect(write.status).toBe(503);
    expect(read.body + write.body + JSON.stringify(f.logs)).not.toContain('PRIVATE_STORAGE_ERROR');
  });
});
