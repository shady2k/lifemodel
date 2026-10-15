import { randomBytes } from 'node:crypto';
import Redis from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestStores, testStoreUrls, type TestStores } from '../helpers/test-stores.js';
import { OwnerMessageIntake } from '../../src/storage/owner-message-intake.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { createWebServer } from '../../src/web/server.js';

function uuidV7(at: number): string {
  const bytes = randomBytes(16);
  let time = BigInt(at);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('owner message HTTP route with real Valkey', () => {
  let stores: TestStores;
  let redis: Redis;
  let server: ReturnType<typeof createWebServer>;
  let intake: OwnerMessageIntake;

  beforeAll(async () => {
    stores = await createTestStores();
    const url = new URL(testStoreUrls().valkeyUrl);
    url.pathname = '/8';
    redis = new Redis(url.toString());
    await redis.flushdb();
    intake = new OwnerMessageIntake(redis, 'web-owner-recipient');
    server = createWebServer({
      allowedOrigin: 'http://localhost',
      intake,
      logger: { info: vi.fn() },
    });
  });
  afterAll(async () => {
    await server?.close();
    await redis?.quit();
    await stores?.redis.quit();
    await stores?.postgres.end();
  });

  it('returns the original receipt, rejects conflicts and stale ids, and appends only one input', async () => {
    const id = uuidV7(Date.now());
    const request = (clientId: string, text: string) =>
      server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { origin: 'http://localhost' },
        payload: { id: clientId, text },
      });
    const first = await request(id, 'hello');
    const retry = await request(id, 'hello');
    const conflict = await request(id, 'different');
    const staleId = uuidV7(Date.now() - 24 * 60 * 60 * 1_000 - 1);
    const stale = await request(staleId, 'old');
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ reason: 'conflict' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ reason: 'stale' });
    const stream = new InboundMessageStream(redis);
    const inputs = await stream.readNew(true);
    expect(inputs.filter((message) => message.messageId === id)).toHaveLength(1);
    expect(inputs.some((message) => message.messageId === staleId)).toBe(false);
  });

  it('returns 503 when the intake receipt write fails after append', async () => {
    const id = uuidV7(Date.now());
    const brokenRedis = redis.duplicate();
    const broken = new OwnerMessageIntake(brokenRedis, 'web-owner-recipient', {
      scriptOverride: `local stream_id = redis.call('XADD', KEYS[1], '*', 'type', 'inbound.message', 'messageId', ARGV[1], 'recipientId', ARGV[2], 'text', ARGV[3], 'timestamp', ARGV[4], 'signal', ARGV[6]); return redis.error_reply('receipt write failed')`,
    });
    const brokenServer = createWebServer({
      allowedOrigin: 'http://localhost',
      intake: broken,
      logger: { info: vi.fn() },
    });
    const response = await brokenServer.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload: { id, text: 'retry' },
    });
    expect(response.statusCode).toBe(503);
    await brokenServer.close();
    await brokenRedis.quit();
    const retry = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost' },
      payload: { id, text: 'retry' },
    });
    expect(retry.statusCode).toBe(202);
    const stream = new InboundMessageStream(redis);
    const inputs = await stream.readNew(true);
    expect(inputs.filter((message) => message.messageId === id)).toHaveLength(1);
  });
});
