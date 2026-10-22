import { randomBytes } from 'node:crypto';
import Redis from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestStores, testStoreUrls, type TestStores } from '../helpers/test-stores.js';
import { OwnerMessageIntake } from '../../src/storage/owner-message-intake.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { createWebServer } from '../../src/web/server.js';
import { silentModelStatus } from '../helpers/model-status.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import {
  PostgresTranscriptStore,
  WAKE_CONNECTION_NAME,
} from '../../src/storage/postgres-transcript-store.js';
import { CreatureStateStore } from '../../src/storage/creature-state-store.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

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

/**
 * The `key=value` fields of one CLIENT LIST line. A client name may not contain a
 * space, so splitting on spaces is exact; the last '=' keeps a value with one.
 */
function clientListFields(line: string): Map<string, string> {
  return new Map(
    line
      .split(' ')
      .filter((field) => field.includes('='))
      .map((field) => {
        const separator = field.indexOf('=');
        return [field.slice(0, separator), field.slice(separator + 1)] as const;
      })
  );
}

/**
 * The ids of the watcher connections this file opened. CLIENT LIST is the whole
 * server, shared with every other test file's clients, and every transcript
 * store names its watcher connection the same way, so ours is the one with the
 * store's name on this file's own logical database (lifemodel-653.7.11).
 */
async function watcherClientIds(redis: Redis, database: string): Promise<string[]> {
  return ((await redis.client('LIST')) as string)
    .split('\n')
    .filter(Boolean)
    .map(clientListFields)
    .filter(
      (fields) => fields.get('name') === WAKE_CONNECTION_NAME && fields.get('db') === database
    )
    .map((fields) => fields.get('id'))
    .filter((id): id is string => id !== undefined);
}

/** The logical database this file's clients use, as the server reports it. */
async function clientDatabase(redis: Redis): Promise<string> {
  const database = clientListFields(((await redis.client('INFO')) as string).trim()).get('db');
  if (database === undefined) throw new Error('CLIENT INFO did not report a database');
  return database;
}

async function nextSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { value: string }
) {
  while (true) {
    const separator = buffer.value.indexOf('\n\n');
    if (separator >= 0) {
      const frame = buffer.value.slice(0, separator);
      buffer.value = buffer.value.slice(separator + 2);
      const fields = Object.fromEntries(
        frame
          .split('\n')
          .filter((line) => !line.startsWith(':'))
          .map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
          })
      );
      if (fields['event']) return fields as { event: string; data?: string; id?: string };
      continue;
    }
    const result = await reader.read();
    if (result.done) throw new Error('SSE stream closed before the expected event');
    buffer.value += new TextDecoder().decode(result.value, { stream: true });
  }
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
    await applyTestMigrations(stores.postgres);
    const transcript = new PostgresTranscriptStore(stores.postgres, redis, 'web-owner-recipient');
    intake = new OwnerMessageIntake(redis, 'web-owner-recipient', { transcript });
    server = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript,
      creatureState: new CreatureStateStore(redis),
      modelStatus: silentModelStatus(),
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
        headers: { origin: 'https://lifemodel.local' },
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

  it('serves a private transcript page and resumes SSE from the last visible sequence over HTTP', async () => {
    const conversations = new PostgresConversationStore(stores.postgres);
    const recipient = 'web-owner-recipient';
    const writeRow = async (messageId: string, role: 'user' | 'assistant', content: string) => {
      await conversations.save(`conversation:${recipient}`, {
        messages: [{ role, content, timestamp: new Date().toISOString(), messageId }],
      });
    };
    await writeRow('http-before-page', 'user', 'before page');
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
    const base = `http://127.0.0.1:${address.port}`;
    const pageResponse = await fetch(`${base}/api/transcript?limit=50`);
    expect(pageResponse.headers.get('cache-control')).toBe('no-store');
    const page = (await pageResponse.json()) as { rows: { sequence: string }[]; cursor: string };
    await writeRow('http-between-page-and-subscribe', 'assistant', 'between page and stream');

    const firstAbort = new AbortController();
    const firstResponse = await fetch(`${base}/api/events?after=${page.cursor}`, {
      signal: firstAbort.signal,
    });
    expect(firstResponse.headers.get('cache-control')).toBe('no-store');
    expect(firstResponse.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self'; connect-src 'self'"
    );
    const firstReader = firstResponse.body!.getReader();
    const firstBuffer = { value: '' };
    const initialState = await nextSseEvent(firstReader, firstBuffer);
    expect(initialState.event).toBe('state');
    expect(initialState.id).toBeUndefined();
    const inserted = await nextSseEvent(firstReader, firstBuffer);
    expect(inserted.event).toBe('message');
    const row = JSON.parse(inserted.data!) as { sequence: string; text: string };
    expect(row.text).toBe('between page and stream');
    expect(inserted.id).toBe(row.sequence);
    const rendered = new Map<string, string>([[row.sequence, row.text]]);
    firstAbort.abort();
    await firstReader.cancel().catch(() => undefined);

    // Reconnect from an older cursor to model duplicate delivery; the client renders by sequence.
    const duplicateAbort = new AbortController();
    const duplicateResponse = await fetch(`${base}/api/events?after=${page.cursor}`, {
      headers: { 'Last-Event-ID': page.cursor },
      signal: duplicateAbort.signal,
    });
    const duplicateReader = duplicateResponse.body!.getReader();
    const duplicateBuffer = { value: '' };
    expect((await nextSseEvent(duplicateReader, duplicateBuffer)).event).toBe('state');
    const duplicate = await nextSseEvent(duplicateReader, duplicateBuffer);
    const duplicateRow = JSON.parse(duplicate.data!) as { sequence: string; text: string };
    rendered.set(duplicateRow.sequence, duplicateRow.text);
    expect(duplicate.id).toBe(inserted.id);
    expect(rendered.size).toBe(1);
    duplicateAbort.abort();
    await duplicateReader.cancel().catch(() => undefined);

    await writeRow('http-during-disconnect', 'user', 'saved during outage');
    const reconnect = new AbortController();
    const resumed = await fetch(`${base}/api/events?after=${page.cursor}`, {
      headers: { 'Last-Event-ID': inserted.id! },
      signal: reconnect.signal,
    });
    const resumedReader = resumed.body!.getReader();
    const resumedBuffer = { value: '' };
    expect((await nextSseEvent(resumedReader, resumedBuffer)).event).toBe('state');
    const caughtUp = await nextSseEvent(resumedReader, resumedBuffer);
    expect(caughtUp.event).toBe('message');
    const caughtUpRow = JSON.parse(caughtUp.data!) as { sequence: string; text: string };
    expect(caughtUpRow.text).toBe('saved during outage');
    rendered.set(caughtUpRow.sequence, caughtUpRow.text);
    expect(rendered.size).toBe(2);
    reconnect.abort();
    await resumedReader.cancel().catch(() => undefined);
    await server.close();
    server = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript: new PostgresTranscriptStore(stores.postgres, redis, recipient),
      creatureState: new CreatureStateStore(redis),
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
  });

  it('catches up rows committed while the web server is stopped, without duplicates', async () => {
    const conversations = new PostgresConversationStore(stores.postgres);
    const recipient = 'web-owner-recipient';
    const write = (messageId: string, content: string) =>
      conversations.save(`conversation:${recipient}`, {
        messages: [{ role: 'assistant', content, timestamp: new Date().toISOString(), messageId }],
      });
    const before = await server.inject({ method: 'GET', url: '/api/transcript?limit=50' });
    const cursor = (before.json() as { cursor: string | null }).cursor ?? '0';
    await server.close();
    await write('server-stopped-one', 'while stopped one');
    await write('server-stopped-two', 'while stopped two');
    const restarted = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript: new PostgresTranscriptStore(stores.postgres, redis, recipient),
      creatureState: new CreatureStateStore(redis),
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    await restarted.listen({ host: '127.0.0.1', port: 0 });
    const address = restarted.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events?after=${cursor}`, {
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const buffer = { value: '' };
    expect((await nextSseEvent(reader, buffer)).event).toBe('state');
    const rows = [await nextSseEvent(reader, buffer), await nextSseEvent(reader, buffer)];
    expect(rows.map((event) => JSON.parse(event.data!).text)).toEqual([
      'while stopped one',
      'while stopped two',
    ]);
    expect(new Set(rows.map((event) => event.id)).size).toBe(2);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await restarted.close();
    server = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript: new PostgresTranscriptStore(stores.postgres, redis, recipient),
      creatureState: new CreatureStateStore(redis),
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
  });

  it('resumes each row once after repeated drops in the middle of catch-up', async () => {
    const recipient = 'web-owner-recipient';
    const conversations = new PostgresConversationStore(stores.postgres);
    const write = (messageId: string, content: string) =>
      conversations.save(`conversation:${recipient}`, {
        messages: [{ role: 'assistant', content, timestamp: new Date().toISOString(), messageId }],
      });
    const baseline = await new PostgresTranscriptStore(
      stores.postgres,
      redis,
      recipient
    ).readTranscript({ limit: 1 });
    await write('repeated-drop-one', 'batch one');
    await write('repeated-drop-two', 'batch two');
    await write('repeated-drop-three', 'batch three');

    const streamServer = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript: new PostgresTranscriptStore(stores.postgres, redis, recipient),
      creatureState: new CreatureStateStore(redis),
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    await streamServer.listen({ host: '127.0.0.1', port: 0 });
    const address = streamServer.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
    const url = `http://127.0.0.1:${address.port}/api/events?after=${baseline.cursor ?? '0'}`;
    const visible = new Map<string, string>();
    let lastId = baseline.cursor ?? '0';
    for (const expectedText of ['batch one', 'batch two', 'batch three']) {
      const abort = new AbortController();
      const response = await fetch(url, {
        headers: { 'Last-Event-ID': lastId },
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      const buffer = { value: '' };
      expect((await nextSseEvent(reader, buffer)).event).toBe('state');
      const event = await nextSseEvent(reader, buffer);
      expect(event.event).toBe('message');
      const row = JSON.parse(event.data!) as { sequence: string; text: string };
      expect(row.text).toBe(expectedText);
      visible.set(row.sequence, row.text);
      lastId = event.id!;
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
    expect([...visible.values()]).toEqual(['batch one', 'batch two', 'batch three']);
    expect(visible.size).toBe(3);
    await streamServer.close();
  });

  it('sends state-only updates without SSE ids and limits streams to four per session', async () => {
    const stateStore = new CreatureStateStore(redis);
    const stateServer = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript: new PostgresTranscriptStore(stores.postgres, redis, 'web-owner-recipient'),
      creatureState: stateStore,
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    await stateServer.listen({ host: '127.0.0.1', port: 0 });
    const address = stateServer.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
    const currentPage = await new PostgresTranscriptStore(
      stores.postgres,
      redis,
      'web-owner-recipient'
    ).readTranscript({ limit: 1 });
    const url = `http://127.0.0.1:${address.port}/api/events?after=${currentPage.cursor ?? '0'}`;
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    const responses = await Promise.all(
      aborts.map((controller) =>
        fetch(url, {
          headers: { cookie: '__Host-lm_session=opaque-token' },
          signal: controller.signal,
        })
      )
    );
    const readers = responses.map((response) => response.body!.getReader());
    const buffers = readers.map(() => ({ value: '' }));
    for (let index = 0; index < readers.length; index += 1) {
      const state = await nextSseEvent(readers[index]!, buffers[index]!);
      expect(state.event).toBe('state');
      expect(state.id).toBeUndefined();
    }
    const fifth = await fetch(url, {
      headers: { cookie: '__Host-lm_session=opaque-token' },
    });
    expect(fifth.status).toBe(429);
    await redis.set('lifemodel:core:snapshot:epoch', '1');
    await stateStore.publishCreatureState('thinking', 1);
    const change = await nextSseEvent(readers[0]!, buffers[0]!);
    expect(change.event).toBe('state');
    expect(change.id).toBeUndefined();
    expect(JSON.parse(change.data!).state).toBe('thinking');
    aborts.forEach((controller) => controller.abort());
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => undefined)));
    await stateServer.close();
  });

  it('closes the watcher Valkey connection when the HTTP client disconnects', async () => {
    const recipient = 'web-owner-recipient';
    const stateServer = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript: new PostgresTranscriptStore(stores.postgres, redis, recipient),
      creatureState: new CreatureStateStore(redis),
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    await stateServer.listen({ host: '127.0.0.1', port: 0 });
    const address = stateServer.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
    const page = await new PostgresTranscriptStore(
      stores.postgres,
      redis,
      recipient
    ).readTranscript({ limit: 1 });
    const database = await clientDatabase(redis);
    const baseline = new Set(await watcherClientIds(redis, database));
    const abort = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/events?after=${page.cursor ?? '0'}`,
      { signal: abort.signal }
    );
    const reader = response.body!.getReader();
    expect((await nextSseEvent(reader, { value: '' })).event).toBe('state');
    let watcherIds: string[] = [];
    await expect
      .poll(async () => {
        watcherIds = (await watcherClientIds(redis, database)).filter((id) => !baseline.has(id));
        return watcherIds;
      })
      .toHaveLength(1);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await expect
      .poll(async () => {
        const current = await watcherClientIds(redis, database);
        return watcherIds.every((id) => !current.includes(id));
      })
      .toBe(true);
    await stateServer.close();
  });

  it('publishes stale state on the open stream after the core stops refreshing it', async () => {
    const recipient = 'web-owner-recipient';
    const stateStore = new CreatureStateStore(redis);
    const stateServer = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake,
      transcript: new PostgresTranscriptStore(stores.postgres, redis, recipient),
      creatureState: stateStore,
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    // Model a core killed just before state expiry, without waiting a full TTL in the suite.
    await redis.set(
      'lifemodel:creature:state',
      JSON.stringify({ state: 'thinking', epoch: 55, publishedAt: Date.now() - 14_500 }),
      'EX',
      15
    );
    await stateServer.listen({ host: '127.0.0.1', port: 0 });
    const address = stateServer.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener did not start');
    const latest = await new PostgresTranscriptStore(
      stores.postgres,
      redis,
      recipient
    ).readTranscript({
      limit: 1,
    });
    const abort = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/events?after=${latest.cursor ?? '0'}`,
      { signal: abort.signal }
    );
    const reader = response.body!.getReader();
    const buffer = { value: '' };
    const current = await nextSseEvent(reader, buffer);
    expect(current.event).toBe('state');
    expect(current.id).toBeUndefined();
    expect(JSON.parse(current.data!).state).toBe('thinking');
    const stale = await nextSseEvent(reader, buffer);
    expect(stale.event).toBe('state');
    expect(stale.id).toBeUndefined();
    expect(stale.data).toBe('null');
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await stateServer.close();
  });

  it('returns 503 when the intake receipt write fails after append', async () => {
    const id = uuidV7(Date.now());
    const brokenRedis = redis.duplicate();
    const broken = new OwnerMessageIntake(brokenRedis, 'web-owner-recipient', {
      scriptOverride: `local stream_id = redis.call('XADD', KEYS[1], '*', 'type', 'inbound.message', 'messageId', ARGV[1], 'recipientId', ARGV[2], 'text', ARGV[3], 'timestamp', ARGV[4], 'signal', ARGV[6]); return redis.error_reply('receipt write failed')`,
    });
    const brokenServer = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: broken,
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    const response = await brokenServer.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'https://lifemodel.local' },
      payload: { id, text: 'retry' },
    });
    expect(response.statusCode).toBe(503);
    await brokenServer.close();
    await brokenRedis.quit();
    const retry = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'https://lifemodel.local' },
      payload: { id, text: 'retry' },
    });
    expect(retry.statusCode).toBe(202);
    const stream = new InboundMessageStream(redis);
    const inputs = await stream.readNew(true);
    expect(inputs.filter((message) => message.messageId === id)).toHaveLength(1);
  });
});
