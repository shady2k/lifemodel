import { createHash } from 'node:crypto';
import Redis from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, testStoreUrls, type TestStores } from '../helpers/test-stores.js';
import { OwnerMessageIntake } from '../../src/storage/owner-message-intake.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';

function uuidV7(at: number): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let time = BigInt(at);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('durable owner-message intake on real Valkey', () => {
  let stores: TestStores;
  let redis: Redis;
  let intake: OwnerMessageIntake;
  beforeAll(async () => {
    stores = await createTestStores();
    const url = new URL(testStoreUrls().valkeyUrl);
    url.pathname = '/7';
    redis = new Redis(url.toString());
    await redis.flushdb();
    intake = new OwnerMessageIntake(redis, 'web-owner-recipient');
  });
  afterAll(async () => {
    await redis?.quit();
    await stores?.redis.quit();
    await stores?.postgres.end();
  });

  it('returns the receipt after a lost response, concurrent retries, and a long dedup window', async () => {
    const id = uuidV7(Date.now());
    const first = await intake.acceptOwnerMessage(id, 'hello'); // response discarded as after-crash retry setup
    const secondConnection = redis.duplicate();
    const retries = await Promise.all([
      intake.acceptOwnerMessage(id, 'hello'),
      new OwnerMessageIntake(secondConnection, 'web-owner-recipient').acceptOwnerMessage(
        id,
        'hello'
      ),
    ]);
    await secondConnection.quit();
    expect(retries.map((item) => item.streamId)).toEqual([first.streamId, first.streamId]);
    const hash = createHash('sha256').update('hello').digest('hex');
    expect(hash).toHaveLength(64);

    for (let index = 0; index < 1_001; index += 1) {
      await intake.acceptOwnerMessage(uuidV7(Date.now()), `later ${index}`);
    }
    const retry = await intake.acceptOwnerMessage(id, 'hello');
    expect(retry).toEqual({ status: 'duplicate', streamId: first.streamId });
    const stream = new InboundMessageStream(redis);
    const messages = await stream.readNew(true);
    expect(messages.filter((message) => message.messageId === id)).toHaveLength(1);
    expect(messages.find((message) => message.messageId === id)?.signal).toMatchObject({
      id,
      type: 'user_message',
      data: {
        updateId: id,
        channel: 'web',
        recipientId: 'web-owner-recipient',
        text: 'hello',
      },
    });
  });

  it('validates IDs, text, and reply sequence before any append', async () => {
    const count = await redis.xlen('inbound');
    await expect(intake.acceptOwnerMessage('not-a-uuid', 'hello')).rejects.toThrow(/UUIDv7/);
    await expect(intake.acceptOwnerMessage(uuidV7(Date.now()), '  ')).rejects.toThrow(/non-empty/);
    await expect(
      intake.acceptOwnerMessage(uuidV7(Date.now()), 'x'.repeat(16 * 1024 + 1))
    ).rejects.toThrow(/16 KiB/);
    await expect(intake.acceptOwnerMessage(uuidV7(Date.now()), 'hello', '0')).rejects.toThrow(
      /replyTo/
    );
    expect(await redis.xlen('inbound')).toBe(count);
  });

  it('rejects conflicting text and UUIDv7 ids outside the accepted time window', async () => {
    const id = uuidV7(Date.now());
    const accepted = await intake.acceptOwnerMessage(id, 'original');
    expect(await intake.acceptOwnerMessage(id, 'different')).toEqual({ status: 'conflict' });
    expect(
      await intake.acceptOwnerMessage(uuidV7(Date.now() - 24 * 60 * 60 * 1_000 - 1), 'old')
    ).toEqual({ status: 'stale' });
    expect(
      await intake.acceptOwnerMessage(uuidV7(Date.now() + 5 * 60 * 1_000 + 1), 'future')
    ).toEqual({ status: 'stale' });
    expect((await redis.xrange('inbound', '-', '+')).map(([streamId]) => streamId)).toContain(
      accepted.streamId
    );
  });

  it('appends before receipt write and a retry remains a single logical input', async () => {
    const id = uuidV7(Date.now());
    const failureConnection = redis.duplicate();
    const failing = new OwnerMessageIntake(failureConnection, 'web-owner-recipient', {
      scriptOverride: `local stream_id = redis.call('XADD', KEYS[1], '*', 'type', 'inbound.message', 'messageId', ARGV[1], 'recipientId', ARGV[2], 'text', ARGV[3], 'timestamp', ARGV[4], 'signal', ARGV[6]); return redis.error_reply('receipt write failed')`,
    });
    await expect(failing.acceptOwnerMessage(id, 'retry me')).rejects.toThrow(/receipt/i);
    await failureConnection.quit();
    const retry = await intake.acceptOwnerMessage(id, 'retry me');
    const stream = new InboundMessageStream(redis);
    const messages = await stream.readNew(true);
    expect(retry.status).toBe('accepted');
    expect(messages.filter((message) => message.messageId === id)).toHaveLength(1);
  });
});
