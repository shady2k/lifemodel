/**
 * The loader's logs page and its API (ADR-016 §4, L11).
 *
 * The API is driven against the recorded store fixture, and against a closed
 * port for the unavailable answer.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, createServer } from 'node:http';
import { createLoaderHttp, type LoaderHttp } from '../../loader/src/http.js';
import { createSession, hashPassword, type PasswordRecord } from '../../loader/src/auth.js';
import { loadConfig } from '../../loader/src/config.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import type { LoaderState } from '../../loader/src/state.js';
import { startLogsStoreFixture, type LogsStoreFixture } from '../helpers/logs-store-fixture.js';

const BOOT = 'boot-lifemodel.local';
const FROM = Date.parse('2026-11-07T10:00:00.000Z');
const TO = Date.parse('2026-11-07T11:00:00.000Z');
const MID = Date.parse('2026-11-07T10:30:00.000Z');

const servers: LoaderHttp[] = [];
const roots: string[] = [];
const fixtures: LogsStoreFixture[] = [];

afterAll(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function uiRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'loader-logs-'));
  roots.push(root);
  writeFileSync(join(root, 'logs.html'), '<main>logs</main>');
  return root;
}

async function start(storeUrl: string): Promise<{
  record: PasswordRecord;
  token: string;
  get(path: string, authenticated?: boolean): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>;
}> {
  const record = await hashPassword('owner password');
  const clock = createTestClock();
  const token = createSession(record, clock.now());
  const state: LoaderState = {
    ensureLayout: async () => {},
    readAuth: async () => record,
    writeAuth: async () => {},
    replaceAuth: async () => {},
    readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
    reconcilePasswordOnboarding: async () => {},
    savePasswordOnboarding: async () => {},
    saveModelOnboarding: async () => {},
  };
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger([]),
    clock,
    config: loadConfig({ LIFEMODEL_NAME: 'lifemodel', LIFEMODEL_LOGS_STORE_URL: storeUrl }),
    uiRoot: uiRoot(),
    pki: {
      bootstrap: async () => {},
      report: async () => ({
        identity: 'present',
        ca: 'present-matching',
        leaf: 'valid',
        sans: [],
        fingerprint: 'x',
      }),
      caPem: async () => 'CA',
    },
  });
  servers.push(loader);
  await new Promise<void>((resolve) => loader.server.listen(0, '127.0.0.1', resolve));
  const address = loader.server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return {
    record,
    token,
    get: (path, authenticated = true) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method: 'GET',
            headers: {
              host: BOOT,
              ...(authenticated ? { cookie: `__Host-lm_session=${token}` } : {}),
            },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text })
            );
          }
        );
        request.on('error', reject);
        request.end();
      }),
  };
}

async function recorded(): Promise<LogsStoreFixture> {
  const fixture = await startLogsStoreFixture();
  fixtures.push(fixture);
  return fixture;
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind'));
        return;
      }
      const port = address.port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

describe('the logs API', () => {
  it('returns records filtered by the requested time range', async () => {
    const fixture = await recorded();
    const loader = await start(fixture.url);
    const response = await loader.get(`/api/logs?from=${String(FROM)}&to=${String(TO)}`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.body) as { state: string; records: { time: string }[] };
    expect(body.state).toBe('ok');
    expect(body.records).toHaveLength(9);
    expect(body.records[0]?.time).toBe('2026-11-07T11:00:00Z');

    const narrow = await loader.get(`/api/logs?from=${String(FROM)}&to=${String(MID)}`);
    const narrowBody = JSON.parse(narrow.body) as { records: { time: string }[] };
    expect(narrowBody.records).toHaveLength(7);
    expect(narrowBody.records.map((record) => record.time)).not.toContain('2026-11-07T11:00:00Z');
  });

  it('returns records filtered by module', async () => {
    const fixture = await recorded();
    const loader = await start(fixture.url);
    const response = await loader.get(
      `/api/logs?from=${String(FROM)}&to=${String(TO)}&module=core`
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      records: { fields: Record<string, string> }[];
    };
    expect(body.records).toHaveLength(4);
    expect(body.records.every((record) => record.fields['module'] === 'core')).toBe(true);
    expect(body.records.some((record) => record.fields['module'] === 'core-web')).toBe(false);
    expect(fixture.requests.at(-1)?.query).toContain('module:="core"');
  });

  it('returns the modules seen by the store', async () => {
    const fixture = await recorded();
    const loader = await start(fixture.url);
    const response = await loader.get('/api/logs/modules');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      state: 'ok',
      modules: ['core', 'core-web', 'loader', 'model-gateway', 'storage-module', 'task-harness'],
    });
  });

  it('refuses an invalid time range instead of querying the store', async () => {
    const fixture = await recorded();
    const loader = await start(fixture.url);
    const response = await loader.get('/api/logs?from=soon&to=later');
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ state: 'invalid', reason: 'filter' });
    const beyondDateRange = await loader.get(`/api/logs?from=1e20&to=${String(TO)}`);
    expect(beyondDateRange.status).toBe(400);
    expect(JSON.parse(beyondDateRange.body)).toEqual({ state: 'invalid', reason: 'filter' });
    const beyondDateRangeEnd = await loader.get(`/api/logs?from=${String(FROM)}&to=1e20`);
    expect(beyondDateRangeEnd.status).toBe(400);
    expect(JSON.parse(beyondDateRangeEnd.body)).toEqual({ state: 'invalid', reason: 'filter' });
    expect(fixture.requests).toHaveLength(0);
  });

  it('refuses without a session', async () => {
    const fixture = await recorded();
    const loader = await start(fixture.url);
    expect((await loader.get(`/api/logs?from=${String(FROM)}&to=${String(TO)}`, false)).status).toBe(403);
    expect((await loader.get('/api/logs/modules', false)).status).toBe(403);
    const page = await loader.get('/logs', false);
    expect(page.status).toBe(303);
    expect(String(page.headers['location'])).toContain('/login');
  });

  it('serves the page with a session', async () => {
    const fixture = await recorded();
    const loader = await start(fixture.url);
    const response = await loader.get('/logs');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.body).toContain('logs');
  });

  it('says unavailable with its reason when the store is stopped, never an empty list', async () => {
    const port = await closedPort();
    const loader = await start(`http://127.0.0.1:${String(port)}`);
    const response = await loader.get(`/api/logs?from=${String(FROM)}&to=${String(TO)}`);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      state: 'unavailable',
      reason: 'connection_refused',
    });
    const modules = await loader.get('/api/logs/modules');
    expect(modules.status).toBe(503);
    expect(JSON.parse(modules.body)).toEqual({
      state: 'unavailable',
      reason: 'connection_refused',
    });
  });
});
