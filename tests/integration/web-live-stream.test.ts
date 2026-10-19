import { describe, expect, it } from 'vitest';
import type { TestStores } from '../helpers/test-stores.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';
import { createWebServer } from '../../src/web/server.js';
import { silentModelStatus } from '../helpers/model-status.js';
import {
  installBrowserFetch,
  waitUntil,
  type InstalledBrowser,
} from '../helpers/browser-event-source.js';
import { httpTransport, type TranscriptMessage } from '../../web/app/src/transport.js';

/** The session key the server derives for a page that sends no session cookie. */
const SESSION = 'client:127.0.0.1';

interface WebModule {
  server: ReturnType<typeof createWebServer>;
  base: string;
  port: number;
}

async function startWebModule(
  transcript: PostgresTranscriptStore,
  options: { port?: number; streamMaxAgeMs?: number } = {}
): Promise<WebModule> {
  const server = createWebServer({
    allowedOrigin: 'https://lifemodel.local',
    instanceName: 'lifemodel',
    appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
    runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
    intake: { acceptOwnerMessage: async () => ({ status: 'accepted', streamId: '1-0' }) } as never,
    transcript,
    creatureState: { readCreatureState: async () => null },
    modelStatus: silentModelStatus(),
    logger: { info: () => undefined },
    ...(options.streamMaxAgeMs === undefined ? {} : { streamMaxAgeMs: options.streamMaxAgeMs }),
  });
  await server.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('the test server has no address');
  return { server, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function stopWebModule(module: WebModule): Promise<void> {
  module.server.server.closeAllConnections?.();
  await module.server.close();
}

async function insertRow(
  stores: TestStores,
  recipientId: string,
  messageId: string,
  role: 'user' | 'assistant',
  text: string
): Promise<void> {
  await stores.postgres.query(
    `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
     VALUES ($1, $2, 'message', $3::jsonb)`,
    [
      recipientId,
      messageId,
      JSON.stringify({ role, content: text, timestamp: new Date().toISOString() }),
    ]
  );
}

interface Page {
  stores: TestStores;
  transcript: PostgresTranscriptStore;
  recipientId: string;
  module: WebModule;
  browser: InstalledBrowser;
  received: TranscriptMessage[];
  subscribe: (after: string | null) => void;
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A page in a browser: the real transport, a spec-faithful event source, a
 * real web server and the real Postgres transcript behind it.
 */
async function openPage(
  recipientId: string,
  options: { streamMaxAgeMs?: number } = {}
): Promise<Page> {
  const stores = await createTestStores();
  await applyTestMigrations(stores.postgres);
  const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipientId);
  const page: Page = {
    stores,
    transcript,
    recipientId,
    module: await startWebModule(transcript, options),
    browser: {} as InstalledBrowser,
    received: [],
    subscribe: () => undefined,
    restart: async () => undefined,
    close: async () => undefined,
  };
  page.browser = installBrowserFetch(page.module.base);
  let stop: () => void = () => undefined;
  page.subscribe = (after) => {
    stop = httpTransport.subscribe(
      after,
      (message) => page.received.push(message),
      () => undefined,
      () => undefined
    );
  };
  page.restart = async () => {
    const port = page.module.port;
    await stopWebModule(page.module);
    page.module = await startWebModule(transcript, { ...options, port });
  };
  page.close = async () => {
    stop();
    page.browser.restore();
    await stopWebModule(page.module);
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  };
  return page;
}

function exactlyOnce(messages: TranscriptMessage[]): void {
  const sequences = messages.map((message) => message.sequence);
  expect(new Set(sequences).size).toBe(sequences.length);
}

describe('a reply reaches an open page through the real web server', () => {
  it('shows a reply committed after the first stream was refused with too many streams', async () => {
    const page = await openPage('web-live-refused');
    try {
      // Four leases of a web module that restarted; nothing releases them.
      const held: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const lease = await page.transcript.acquireStreamLease(SESSION, Date.now() + 60_000);
        if (!lease) throw new Error('the test could not hold a lease');
        held.push(lease);
      }
      page.subscribe('0');
      await waitUntil(
        () => page.browser.sources().some((source) => source.lastStatus === 429),
        'the first stream to be refused'
      );
      await insertRow(page.stores, page.recipientId, 'channel:web:refused', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply committed while the stream was refused'
      );
      for (const lease of held) await page.transcript.releaseStreamLease(SESSION, lease);
      await insertRow(
        page.stores,
        page.recipientId,
        'channel:web:live',
        'assistant',
        'второй ответ'
      );
      await waitUntil(
        () => page.received.some((message) => message.text === 'второй ответ'),
        'a live reply after the stream recovered'
      );
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('shows a reply committed after the stream ended at its max age', async () => {
    const page = await openPage('web-live-max-age', { streamMaxAgeMs: 1_500 });
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:max-age', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await insertRow(page.stores, page.recipientId, 'channel:web:max-age', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply committed after the stream ended'
      );
      expect(page.browser.sources().length).toBeGreaterThan(1);
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('shows the reply committed while the web module was restarted', async () => {
    const page = await openPage('web-live-restart');
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:restart', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      await page.restart();
      await insertRow(page.stores, page.recipientId, 'channel:web:restart', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply committed while the module was down'
      );
      expect(page.browser.sources().length).toBeGreaterThan(1);
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('keeps the stream open for a reply slower than a minute', async () => {
    const page = await openPage('web-live-slow-reply');
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:slow', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      await insertRow(page.stores, page.recipientId, 'channel:web:slow', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the slow reply'
      );
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 180_000);
});
