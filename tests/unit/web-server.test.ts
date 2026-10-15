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
    intake: { acceptOwnerMessage } as unknown as IOwnerMessageIntake,
    transcript: {
      readTranscript: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
      watchTranscript: vi.fn(),
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
