import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoaderHttp, type LoaderHttp } from '../../loader/src/http.js';
import { createModelStatusReader } from '../../loader/src/model-status.js';
import {
  abortTrackingFetch,
  neverEndingResponse,
  overlongResponse,
  stallingResponse,
} from '../helpers/model-status-fetch.js';
import { createSession, hashPassword } from '../../loader/src/auth.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { loadConfig } from '../../loader/src/config.js';
import type { LoaderState } from '../../loader/src/state.js';

const BOOT_HOST = 'boot-lifemodel.local';
const GATEWAY_STATUS_URL = 'http://model-gateway.lifemodel-system.svc:8081/status';
const servers: LoaderHttp[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the expected condition did not happen within the bound');
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function startLoader(modelStatus?: { read(): Promise<unknown> }): Promise<{
  base: string;
  cookie: string;
  recorded: RecordedLine[];
}> {
  const record = await hashPassword('owner password');
  const state: LoaderState = {
    ensureLayout: async () => undefined,
    readAuth: async () => record,
    writeAuth: async () => undefined,
    replaceAuth: async () => undefined,
    readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
  };
  const recorded: RecordedLine[] = [];
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger(recorded),
    clock: createTestClock(),
    config: loadConfig({ LIFEMODEL_NAME: 'lifemodel' }),
    ...(modelStatus === undefined
      ? {}
      : { modelStatus: modelStatus as import('../../loader/src/model-status.js').ModelStatusReader }),
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
    base: `http://127.0.0.1:${address.port}`,
    cookie: `__Host-lm_session=${createSession(record, Date.now())}`,
    recorded,
  };
}

async function get(
  base: string,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the loader reads the gateway status for its settings', () => {
  it('keeps only the safe fields of a status body', async () => {
    const reader = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      fetch: vi.fn(async () =>
        jsonResponse({
          state: 'down',
          outageSince: '2026-10-16T11:03:00.000Z',
          lastErrorCode: 'unreachable',
          lastSuccessAt: '2026-10-16T10:00:00.000Z',
          primary: { lastErrorCode: 'unreachable', lastErrorAt: '2026-10-16T11:03:00.000Z' },
          upstreamUrl: 'http://owner-endpoint.example/v1',
        })
      ) as unknown as typeof fetch,
    });
    expect(await reader.read()).toEqual({
      state: 'down',
      outageSince: '2026-10-16T11:03:00.000Z',
      lastErrorCode: 'unreachable',
    });
  });

  it('answers unavailable for a failure, a bad body or a status that never comes', async () => {
    const failing = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      fetch: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.43.0.7:8081');
      }) as unknown as typeof fetch,
    });
    expect(await failing.read()).toBeNull();
    const malformed = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      fetch: vi.fn(async () => jsonResponse({ state: 'broken' })) as unknown as typeof fetch,
    });
    expect(await malformed.read()).toBeNull();
    const notJson = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      fetch: vi.fn(async () => new Response('<html>nginx</html>')) as unknown as typeof fetch,
    });
    expect(await notJson.read()).toBeNull();
    const hanging = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      timeoutMs: 30,
      fetch: vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    });
    expect(await hanging.read()).toBeNull();
  });

  it('cancels the response body it rejects, so no connection stays open', async () => {
    const body = neverEndingResponse(503);
    const tracking = abortTrackingFetch(async () => body.response);
    const reader = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      timeoutMs: 60,
      fetch: tracking.fetch,
    });
    expect(await reader.read()).toBeNull();
    await until(() => body.cancelled() || tracking.aborted());
  });

  it.each([201, 202, 206])('reads a %s answer as unavailable, never an outage', async (status) => {
    const reader = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ state: 'down', outageSince: '2026-10-16T11:03:00.000Z', lastErrorCode: 'timeout' }), {
          status,
        })
      ) as unknown as typeof fetch,
    });
    expect(await reader.read()).toBeNull();
  });

  it('reads an empty 204 answer as unavailable', async () => {
    const reader = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    });
    expect(await reader.read()).toBeNull();
  });

  it('refuses a body past its byte bound and cancels it', async () => {
    const body = overlongResponse(200, 1_024, 16);
    const tracking = abortTrackingFetch(async () => body.response);
    const reader = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      timeoutMs: 500,
      fetch: tracking.fetch,
    });
    expect(await reader.read()).toBeNull();
    await until(() => body.cancelled() || tracking.aborted());
  });

  it('gives up on a body that stalls after its first part, within the bound', async () => {
    const body = stallingResponse(200, '{"state":"do');
    const tracking = abortTrackingFetch(async () => body.response);
    const reader = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      timeoutMs: 40,
      fetch: tracking.fetch,
    });
    const startedAt = Date.now();
    expect(await reader.read()).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(body.cancelled() || tracking.aborted()).toBe(true);
  });

  it('asks the gateway once per cache window however many callers wait', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ state: 'ok' }));
    let now = 1_000;
    const reader = createModelStatusReader({
      url: GATEWAY_STATUS_URL,
      cacheMs: 200,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    const [first, second] = await Promise.all([reader.read(), reader.read()]);
    expect(first).toEqual({ state: 'ok', outageSince: null, lastErrorCode: null });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await reader.read();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 201;
    await reader.read();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(GATEWAY_STATUS_URL);
  });

  it('serves the safe status to a signed-in settings page and unavailable without one', async () => {
    const reader = {
      read: vi.fn(async () => ({
        state: 'down' as const,
        outageSince: '2026-10-16T11:03:00.000Z',
        lastErrorCode: 'timeout',
        upstreamUrl: 'http://owner-endpoint.example/v1',
      })),
    };
    const { base, cookie } = await startLoader(reader);
    const anonymous = await get(base, '/api/model-status', { host: BOOT_HOST });
    expect(anonymous.status).toBe(403);
    const status = await get(base, '/api/model-status', {
      host: BOOT_HOST,
      cookie,
      'sec-fetch-site': 'same-origin',
    });
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(status.body)).toEqual({
      state: 'down',
      outageSince: '2026-10-16T11:03:00.000Z',
      lastErrorCode: 'timeout',
    });
    expect(status.body).not.toContain('owner-endpoint.example');
  });

  it('answers unavailable rather than failing when no status can be read', async () => {
    const { base, cookie } = await startLoader({ read: async () => null });
    const status = await get(base, '/api/model-status', {
      host: BOOT_HOST,
      cookie,
      'sec-fetch-site': 'same-origin',
    });
    expect(status.status).toBe(200);
    expect(status.body).toBe('null');
    const broken = await startLoader({
      read: async () => {
        throw new Error('the gateway answered nonsense');
      },
    });
    const second = await get(broken.base, '/api/model-status', {
      host: BOOT_HOST,
      cookie: broken.cookie,
      'sec-fetch-site': 'same-origin',
    });
    expect(second.status).toBe(200);
    expect(second.body).toBe('null');
  });

  it('answers null for a down status that carries no usable outage start', async () => {
    for (const outageSince of [null, 'yesterday', 'https://endpoint.example/v1?key=sk-secret']) {
      const { base, cookie } = await startLoader({
        read: async () => ({ state: 'down', outageSince, lastErrorCode: 'timeout' }),
      });
      const status = await get(base, '/api/model-status', {
        host: BOOT_HOST,
        cookie,
        'sec-fetch-site': 'same-origin',
      });
      expect(status.status, String(outageSince)).toBe(200);
      expect(status.body, String(outageSince)).toBe('null');
    }
  });

  it('leaves the status route unreachable from the chat host and unknown paths', async () => {
    const { base, cookie } = await startLoader({ read: async () => null });
    const chatHost = await get(base, '/api/model-status', {
      host: 'lifemodel.local',
      cookie,
    });
    expect(chatHost.status).toBe(404);
  });
});
