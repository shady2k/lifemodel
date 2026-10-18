import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_STATUS_ERROR_KEYS,
  MODEL_STATUS_TIMEOUT_MS,
  modelErrorKey,
  modelStatusView,
  parseModelStatus,
} from '../../src/web/model-status.js';
import { ModelStatusPoller } from '../../src/web/model-status-poller.js';
import type { ModelStatusEvent } from '../../src/web/contract.js';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the expected condition did not happen within the bound');
}

describe('the safe fields of the gateway status (ADR-013 D6)', () => {
  it('keeps only state, outageSince and lastErrorCode', () => {
    expect(
      parseModelStatus({
        state: 'down',
        outageSince: '2026-10-16T11:03:00.000Z',
        lastAttemptAt: '2026-10-16T11:05:00.000Z',
        lastSuccessAt: null,
        lastErrorCode: 'timeout',
        primary: { lastErrorCode: 'timeout', lastErrorAt: '2026-10-16T11:05:00.000Z' },
        reserve: { lastErrorCode: null, lastErrorAt: null },
        upstreamUrl: 'http://owner-endpoint.example/v1',
        lastErrorBody: 'invalid api key sk-secret',
      })
    ).toEqual({
      state: 'down',
      outageSince: '2026-10-16T11:03:00.000Z',
      lastErrorCode: 'timeout',
    });
  });

  it('accepts ok and unknown without an outage', () => {
    expect(parseModelStatus({ state: 'ok', outageSince: null, lastErrorCode: null })).toEqual({
      state: 'ok',
      outageSince: null,
      lastErrorCode: null,
    });
    expect(parseModelStatus({ state: 'unknown' })).toEqual({
      state: 'unknown',
      outageSince: null,
      lastErrorCode: null,
    });
  });

  it.each([
    ['a body that is not an object', 'down'],
    ['an unknown state', { state: 'broken', outageSince: '2026-10-16T11:03:00.000Z' }],
    ['a missing state', { outageSince: '2026-10-16T11:03:00.000Z' }],
    ['a down state without an outage start', { state: 'down', lastErrorCode: 'timeout' }],
    [
      'a down state with an unparseable outage start',
      { state: 'down', outageSince: 'yesterday', lastErrorCode: 'timeout' },
    ],
    ['a non-string error code', { state: 'down', outageSince: '2026-10-16T11:03:00.000Z', lastErrorCode: 7 }],
  ])('refuses %s', (_name, value) => {
    expect(parseModelStatus(value)).toBeNull();
  });
});

describe('safe codes in words', () => {
  it('maps every safe gateway code to its own phrase key', () => {
    expect(Object.keys(MODEL_STATUS_ERROR_KEYS)).toEqual(
      expect.arrayContaining([
        'unreachable',
        'timeout',
        'blocked_destination',
        'not_configured',
        'storage_unavailable',
        'bad_response',
        'unsafe_response',
        'invalid_request',
        'request_too_large',
        'client_disconnected',
      ])
    );
    for (const code of Object.keys(MODEL_STATUS_ERROR_KEYS))
      expect(modelErrorKey(code), code).toMatch(/^modelError[A-Z]/);
    expect(new Set(Object.values(MODEL_STATUS_ERROR_KEYS)).size).toBe(
      Object.keys(MODEL_STATUS_ERROR_KEYS).length
    );
  });

  it.each([
    ['upstream_401', 'modelErrorUpstreamKey'],
    ['upstream_403', 'modelErrorUpstreamKey'],
    ['upstream_404', 'modelErrorUpstreamModel'],
    ['upstream_429', 'modelErrorUpstreamRateLimit'],
    ['upstream_400', 'modelErrorUpstreamRefused'],
    ['upstream_500', 'modelErrorUpstreamServer'],
    ['upstream_503', 'modelErrorUpstreamServer'],
  ])('reads the upstream status in %s', (code, key) => {
    expect(modelErrorKey(code)).toBe(key);
  });

  it('falls back to a generic phrase for anything it does not know', () => {
    for (const code of ['wat', 'upstream_200', 'UPSTREAM_500', '', null])
      expect(modelErrorKey(code)).toBe('modelErrorUnknown');
  });
});

describe('what the owner sees', () => {
  const now = new Date(2026, 9, 16, 14, 30).getTime();

  it('hides an ok or unknown status and shows an outage for down', () => {
    expect(modelStatusView(null, 'en', now)).toEqual({ kind: 'unavailable' });
    expect(modelStatusView({ state: 'ok', outageSince: null, lastErrorCode: null }, 'en', now)).toEqual(
      { kind: 'hidden' }
    );
    expect(
      modelStatusView({ state: 'unknown', outageSince: null, lastErrorCode: null }, 'en', now)
    ).toEqual({ kind: 'hidden' });
    const outage = modelStatusView(
      {
        state: 'down',
        outageSince: new Date(2026, 9, 16, 14, 3).toISOString(),
        lastErrorCode: 'unreachable',
      },
      'en',
      now
    );
    expect(outage).toEqual({ kind: 'outage', time: '14:03', errorKey: 'modelErrorUnreachable' });
  });

  it('carries the date when the outage began on an earlier day', () => {
    const earlier = modelStatusView(
      {
        state: 'down',
        outageSince: new Date(2026, 9, 15, 22, 5).toISOString(),
        lastErrorCode: 'upstream_503',
      },
      'en',
      now
    );
    expect(earlier.kind).toBe('outage');
    if (earlier.kind !== 'outage') throw new Error('the outage is missing');
    expect(earlier.time).toMatch(/\d{1,2}[./]\d{1,2}/);
    expect(earlier.time).toMatch(/22:05/);
    expect(earlier.errorKey).toBe('modelErrorUpstreamServer');
    const sameDay = modelStatusView(
      {
        state: 'down',
        outageSince: new Date(2026, 9, 16, 22, 5).toISOString(),
        lastErrorCode: 'upstream_503',
      },
      'en',
      now
    );
    expect(sameDay).toEqual({ kind: 'outage', time: '22:05', errorKey: 'modelErrorUpstreamServer' });
  });

  it('formats the time with 24-hour local hours in both languages', () => {
    const status = {
      state: 'down' as const,
      outageSince: new Date(2026, 9, 16, 9, 7).toISOString(),
      lastErrorCode: 'timeout',
    };
    expect(modelStatusView(status, 'en', now)).toEqual({
      kind: 'outage',
      time: '09:07',
      errorKey: 'modelErrorTimeout',
    });
    expect(modelStatusView(status, 'ru', now)).toEqual({
      kind: 'outage',
      time: '09:07',
      errorKey: 'modelErrorTimeout',
    });
  });
});

describe('the bounded status poll', () => {
  const ok: ModelStatusEvent = { state: 'ok', outageSince: null, lastErrorCode: null };

  it('polls once per period however many readers are attached, and only while one is', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ state: 'ok' }));
    const poller = new ModelStatusPoller({
      url: 'http://model-gateway.lifemodel-system.svc:8081/status',
      pollMs: 40,
      timeoutMs: 20,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    poller.start();
    poller.start();
    poller.start();
    await until(() => fetchMock.mock.calls.length >= 4, 1_000);
    const calls = fetchMock.mock.calls.length;
    poller.stop();
    expect(calls).toBeLessThanOrEqual(6);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://model-gateway.lifemodel-system.svc:8081/status'
    );
  });

  it('keeps the last good status and marks an unavailable fetch instead of an outage', async () => {
    let failing = false;
    const fetchMock = vi.fn(async () => {
      if (failing) throw new Error('connect ECONNREFUSED 10.43.0.7:8081');
      return jsonResponse({ state: 'ok' });
    });
    const poller = new ModelStatusPoller({
      url: 'http://model-gateway.lifemodel-system.svc:8081/status',
      pollMs: 30,
      timeoutMs: 20,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(poller.read()).toBeNull();
    expect(poller.settled()).toBe(false);
    poller.start();
    await until(() => poller.settled());
    expect(poller.read()).toEqual(ok);
    failing = true;
    await until(() => poller.read() === null, 1_000);
    expect(poller.settled()).toBe(true);
    poller.stop();
  });

  it('gives up on a status that does not answer within the bound', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    const poller = new ModelStatusPoller({
      url: 'http://model-gateway.lifemodel-system.svc:8081/status',
      pollMs: 5_000,
      timeoutMs: 30,
      fetch: fetchMock as unknown as typeof fetch,
    });
    poller.start();
    await until(() => poller.settled(), 500);
    expect(poller.read()).toBeNull();
    poller.stop();
    expect(MODEL_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('never keeps polling after the last reader leaves', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ state: 'ok' }));
    const poller = new ModelStatusPoller({
      url: 'http://model-gateway.lifemodel-system.svc:8081/status',
      pollMs: 20,
      timeoutMs: 10,
      fetch: fetchMock as unknown as typeof fetch,
    });
    poller.start();
    await until(() => fetchMock.mock.calls.length >= 1, 500);
    poller.stop();
    const settledCalls = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetchMock.mock.calls.length).toBe(settledCalls);
  });
});
