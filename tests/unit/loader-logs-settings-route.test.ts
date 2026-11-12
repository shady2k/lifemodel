/**
 * The retention setting's two routes (ADR-016 §4, §5; L11): a session on both,
 * CSRF and the exact Origin on the write, the status the page reads, and the
 * refusal of a byte bound this volume can never reach - with both numbers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp, type LoaderHttp } from '../../loader/src/http.js';
import { createSession, csrfToken, hashPassword } from '../../loader/src/auth.js';
import { loadConfig } from '../../loader/src/config.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import type { LoaderState } from '../../loader/src/state.js';
import type { LogsSettings, LogsSettingsStatus } from '../../loader/src/logs-settings.js';
import { marginBytesOf, retentionLimits } from '../../loader/src/logs-retention.js';

const BOOT = 'boot-lifemodel.local';
const VOLUME = 3 * 1024 * 1024 * 1024;
const LIMITS = retentionLimits(VOLUME);

const servers: LoaderHttp[] = [];
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STATUS: LogsSettingsStatus = {
  days: 14,
  maxBytes: 1_610_612_736,
  desiredRevision: '2-abcdef012345',
  appliedRevision: '1-0123456789ab',
  appliedAt: '2026-11-08T04:00:00.000Z',
  applied: false,
  pending: 'mismatch',
  limits: LIMITS,
  fitsVolume: true,
};

interface Answers {
  status?: () => Promise<LogsSettingsStatus>;
  write?: (input: unknown) => Promise<Awaited<ReturnType<LogsSettings['write']>>>;
}

interface Fixture {
  cookie: string;
  csrf: string;
  send(options: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>;
}

async function start(answers: Answers = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'loader-logs-settings-'));
  roots.push(root);
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
  const settings: LogsSettings = {
    status: answers.status ?? (async () => STATUS),
    write: answers.write ?? (async () => ({ state: 'ok', status: STATUS })),
    reconcile: async () => {},
  };
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger([]),
    clock,
    config: loadConfig({ LIFEMODEL_NAME: 'lifemodel', LIFEMODEL_LOGS_STORE_URL: 'http://127.0.0.1:1' }),
    uiRoot: root,
    logsSettings: settings,
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
  const port = address.port;
  return {
    cookie: `__Host-lm_session=${token}`,
    csrf: csrfToken(record, token),
    send: ({ method, path, body, headers = {} }) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: {
              host: BOOT,
              ...headers,
              ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
            },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              text += chunk;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
            );
          }
        );
        req.on('error', reject);
        req.end(body);
      }),
  };
}

function sessionHeaders(fixture: Fixture): Record<string, string> {
  return {
    cookie: fixture.cookie,
    origin: `https://${BOOT}`,
    'x-csrf-token': fixture.csrf,
    'content-type': 'application/json',
  };
}

describe('GET /api/logs/settings', () => {
  it('answers the status the page shows, with no-store and CSP', async () => {
    const fixture = await start();
    const response = await fixture.send({
      method: 'GET',
      path: '/api/logs/settings',
      headers: { cookie: fixture.cookie, origin: `https://${BOOT}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(response.body)).toEqual({ state: 'ok', ...STATUS });
  });

  it('refuses a reader without a session, on GET as on every logs route', async () => {
    const fixture = await start();
    const response = await fixture.send({
      method: 'GET',
      path: '/api/logs/settings',
      headers: { origin: `https://${BOOT}` },
    });
    expect(response.status).toBe(403);
  });

  it('answers unavailable when the loader has no settings seam', async () => {
    const fixture = await start({
      status: async () => {
        throw new Error('no service');
      },
    });
    const response = await fixture.send({
      method: 'GET',
      path: '/api/logs/settings',
      headers: { cookie: fixture.cookie, origin: `https://${BOOT}` },
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ state: 'unavailable', reason: 'unavailable' });
  });
});

describe('PUT /api/logs/settings', () => {
  it('writes the two numbers and answers the status it proved', async () => {
    const writes: unknown[] = [];
    const fixture = await start({
      write: async (input) => {
        writes.push(input);
        return { state: 'ok', status: STATUS };
      },
    });
    const response = await fixture.send({
      method: 'PUT',
      path: '/api/logs/settings',
      headers: sessionHeaders(fixture),
      body: JSON.stringify({ days: 7, maxBytes: 1_073_741_824 }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ state: 'ok', ...STATUS });
    expect(writes).toEqual([{ days: 7, maxBytes: 1_073_741_824 }]);
  });

  it('refuses a request without a session, without CSRF, or from another Origin', async () => {
    const fixture = await start();
    const body = JSON.stringify({ days: 7, maxBytes: 1_073_741_824 });
    const anonymous = await fixture.send({
      method: 'PUT',
      path: '/api/logs/settings',
      body,
      headers: { origin: `https://${BOOT}`, 'content-type': 'application/json' },
    });
    expect(anonymous.status).toBe(401);
    const noCsrf = await fixture.send({
      method: 'PUT',
      path: '/api/logs/settings',
      body,
      headers: { cookie: fixture.cookie, origin: `https://${BOOT}`, 'content-type': 'application/json' },
    });
    expect(noCsrf.status).toBe(403);
    const foreignOrigin = await fixture.send({
      method: 'PUT',
      path: '/api/logs/settings',
      body,
      headers: { ...sessionHeaders(fixture), origin: 'https://evil.example' },
    });
    expect(foreignOrigin.status).toBe(403);
  });

  it('refuses a body that is not JSON, or not the two numbers', async () => {
    const fixture = await start();
    const wrongType = await fixture.send({
      method: 'PUT',
      path: '/api/logs/settings',
      headers: { ...sessionHeaders(fixture), 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
    const notJson = await fixture.send({
      method: 'PUT',
      path: '/api/logs/settings',
      headers: sessionHeaders(fixture),
      body: '{',
    });
    expect(notJson.status).toBe(400);
    const refused = await start({
      write: async () => ({ state: 'invalid', field: 'days' }),
    });
    const answer = await refused.send({
      method: 'PUT',
      path: '/api/logs/settings',
      headers: sessionHeaders(refused),
      body: JSON.stringify({ days: 0, maxBytes: 1_073_741_824 }),
    });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toEqual({ state: 'invalid', field: 'days' });
  });

  it('refuses a byte bound above volume minus the evictor threshold, with both numbers', async () => {
    const fixture = await start({
      write: async () => ({
        state: 'above_volume',
        maxBytes: LIMITS.largestMaxBytes + 1024 * 1024,
        largestMaxBytes: LIMITS.largestMaxBytes,
        volumeBytes: LIMITS.volumeBytes,
        evictorThresholdBytes: LIMITS.evictorThresholdBytes,
      }),
    });
    const response = await fixture.send({
      method: 'PUT',
      path: '/api/logs/settings',
      headers: sessionHeaders(fixture),
      body: JSON.stringify({ days: 14, maxBytes: LIMITS.largestMaxBytes + 1024 * 1024 }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      state: 'refused',
      reason: 'above_volume',
      maxBytes: LIMITS.largestMaxBytes + 1024 * 1024,
      largestMaxBytes: LIMITS.largestMaxBytes,
      volumeBytes: VOLUME,
      evictorThresholdBytes: LIMITS.evictorThresholdBytes,
    });
    // The numbers the page names are the ADR's: volume and its evictor threshold.
    expect(LIMITS.largestMaxBytes + LIMITS.evictorThresholdBytes).toBe(VOLUME);
    expect(marginBytesOf(VOLUME)).toBe(805_306_368);
  });

  it('answers unavailable when the loader cannot see the volume or may not write', async () => {
    for (const [reason, expected] of [
      ['volume_unknown', { state: 'unavailable', reason: 'volume_unknown' }],
      ['forbidden', { state: 'unavailable', reason: 'forbidden' }],
      ['unavailable', { state: 'unavailable', reason: 'unavailable' }],
    ] as const) {
      const fixture = await start({ write: async () => ({ state: reason }) });
      const response = await fixture.send({
        method: 'PUT',
        path: '/api/logs/settings',
        headers: sessionHeaders(fixture),
        body: JSON.stringify({ days: 7, maxBytes: 1_073_741_824 }),
      });
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual(expected);
    }
  });
});
