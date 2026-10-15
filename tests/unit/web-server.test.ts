import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../../src/web/server.js';
import type { IOwnerMessageIntake } from '../../src/ports/owner-message-intake.js';

const id = '0199aabb-ccdd-7eef-8abc-0123456789ab';
const accepted = { status: 'accepted' as const, streamId: '1-0' };

function setup(result: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(accepted)) {
  const acceptOwnerMessage = vi.fn(result);
  const info = vi.fn();
  const server = createWebServer({
    allowedOrigin: 'http://localhost',
    appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
    runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
    intake: { acceptOwnerMessage } as unknown as IOwnerMessageIntake,
    transcript: {
      readTranscript: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
      watchTranscript: vi.fn(),
      acquireStreamLease: vi.fn().mockResolvedValue(true),
      releaseStreamLease: vi.fn().mockResolvedValue(undefined),
    },
    creatureState: { readCreatureState: vi.fn().mockResolvedValue(null) },
    logger: { info },
  });
  return { server, acceptOwnerMessage, info };
}

afterEach(() => vi.restoreAllMocks());

describe('POST /api/messages', () => {
  it.each([
    ['missing', undefined],
    ['null', 'null'],
    ['malformed', 'not an origin'],
    ['sibling host', 'http://sibling.localhost'],
    ['other scheme', 'https://localhost'],
    ['other port', 'http://localhost:8080'],
  ])('refuses %s Origin', async (_name, origin) => {
    const { server, acceptOwnerMessage } = setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/messages',
      ...(origin === undefined ? {} : { headers: { origin } }),
      payload: { id, text: 'hello' },
    });
    expect(response.statusCode).toBe(403);
    expect(acceptOwnerMessage).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    [undefined, '{'],
    [undefined, '{not json'],
  ])('refuses an invalid body before parsing when Origin is %s', async (origin, payload) => {
    const { server, acceptOwnerMessage } = setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(acceptOwnerMessage).not.toHaveBeenCalled();
    await server.close();
  });

  it('accepts a valid message and returns its stream id', async () => {
    const { server, acceptOwnerMessage } = setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload: { id, text: 'hello', replyTo: '12' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ streamId: '1-0' });
    expect(acceptOwnerMessage).toHaveBeenCalledWith(id, 'hello', '12');
    await server.close();
  });

  it.each([
    [{ text: 'hello' }],
    [{ id: 'not-uuid', text: 'hello' }],
    [{ id, text: '' }],
    [{ id, text: 'x'.repeat(16 * 1024 + 1) }],
    [{ id, text: 'hello', replyTo: '0' }],
    [{ id, text: 'hello', recipientId: 'attacker', channel: 'telegram' }],
    [{ id: 12, text: 'hello' }],
    [{ id, text: 12 }],
    [{ id, text: null, replyTo: '1' }],
    [{ id, text: 'hello', replyTo: 12 }],
    [{ id, text: 'hello', replyTo: null }],
    [{ id, text: { value: 'hello' }, replyTo: {} }],
  ])('rejects invalid body %j', async (payload) => {
    const { server, acceptOwnerMessage } = setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(acceptOwnerMessage).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    [{ status: 'duplicate', streamId: '2-0' }, 202, { streamId: '2-0' }],
    [{ status: 'conflict' }, 409, { reason: 'conflict' }],
    [{ status: 'stale' }, 409, { reason: 'stale' }],
  ] as const)('maps intake result to HTTP', async (result, status, body) => {
    const { server } = setup(vi.fn().mockResolvedValue(result));
    const response = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload: { id, text: 'hello' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(body);
    await server.close();
  });

  it('maps an invisible reply target to 400 without appending', async () => {
    const acceptOwnerMessage = vi.fn().mockResolvedValue({ status: 'reply_not_found' });
    const server = createWebServer({
      allowedOrigin: 'http://localhost',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: { acceptOwnerMessage } as unknown as IOwnerMessageIntake,
      transcript: {
        readTranscript: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
        watchTranscript: vi.fn(),
      },
      creatureState: { readCreatureState: vi.fn().mockResolvedValue(null) },
      logger: { info: vi.fn() },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload: { id, text: 'reply', replyTo: '999' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ reason: 'reply_not_found' });
    expect(acceptOwnerMessage).toHaveBeenCalledWith(id, 'reply', '999');
    await server.close();
  });

  it('returns 503 when durable receipt intake fails', async () => {
    const { server } = setup(vi.fn().mockRejectedValue(new Error('store unavailable')));
    const response = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload: { id, text: 'hello' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'intake_unavailable' });
    await server.close();
  });

  it('logs request id, client id and result but never message text', async () => {
    const secret = 'secret message body';
    const { server, info } = setup();
    await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload: { id, text: secret },
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: expect.any(String), clientId: id, result: 'accepted' }),
      'Owner message intake'
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    await server.close();
  });
});

describe('static application', () => {
  it('publishes unavailable when a state read stalls and never starts another read concurrently', async () => {
    let release!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      release = resolve;
    });
    const readCreatureState = vi.fn(() => pending);
    const { server } = setup();
    // Replace the test server's state reader through a new server with the same real HTTP stream path.
    await server.close();
    const config = setup();
    const stalledServer = createWebServer({
      allowedOrigin: 'http://localhost',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: { acceptOwnerMessage: vi.fn() } as unknown as IOwnerMessageIntake,
      transcript: {
        readTranscript: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
        watchTranscript: vi.fn(async function* () {
          await new Promise<void>(() => {});
        }),
        acquireStreamLease: vi.fn().mockResolvedValue(true),
        releaseStreamLease: vi.fn().mockResolvedValue(undefined),
      },
      creatureState: { readCreatureState },
      logger: { info: vi.fn() },
    });
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await stalledServer.listen({ host: '127.0.0.1', port: 0 });
      const address = stalledServer.server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/events?after=0`, {
        signal: abort.signal,
      });
      reader = response.body!.getReader();
      const chunks = new TextDecoder();
      let buffer = '';
      while (!buffer.includes('event: state')) buffer += chunks.decode((await reader.read()).value);
      expect(buffer).toContain('data: null');
      expect(readCreatureState).toHaveBeenCalledOnce();
      release(null);
    } finally {
      abort.abort();
      await reader?.cancel().catch(() => undefined);
      await stalledServer.close();
      await config.server.close();
    }
  });

  it('does not expose metrics or readiness details on the public listener', async () => {
    const { server } = setup();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
    try {
      for (const route of ['/metrics', '/readyz']) {
        const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(await response.text()).toContain('fixture app');
      }
    } finally {
      await server.close();
    }
  });

  it('serves the built app and its assets with the exact CSP', async () => {
    const { server } = setup();
    const home = await server.inject({ method: 'GET', url: '/' });
    const asset = await server.inject({ method: 'GET', url: '/assets/app.js' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<div id="app">fixture app</div>');
    expect(asset.statusCode).toBe(200);
    expect(asset.body.trim()).toBe('window.fixture = true;');
    const hashedAsset = await server.inject({ method: 'GET', url: '/assets/app-12345678.js' });
    expect(hashedAsset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(home.headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self'; connect-src 'self'"
    );
    expect(home.headers['cache-control']).toBe('no-store');
    expect(asset.headers['cache-control']).toBe('no-store');
    const unknown = await server.inject({ method: 'GET', url: '/api/unknown' });
    const missingAsset = await server.inject({ method: 'GET', url: '/missing.js' });
    expect(unknown.headers['cache-control']).toBe('no-store');
    expect(missingAsset.headers['cache-control']).toBe('no-store');
    expect(unknown.headers['content-security-policy']).toBe(
      home.headers['content-security-policy']
    );
    await server.close();
  });
});
