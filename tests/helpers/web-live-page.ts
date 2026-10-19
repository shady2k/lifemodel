import { expect } from 'vitest';
import { createWebServer } from '../../src/web/server.js';
import type { TranscriptReader } from '../../src/ports/transcript.js';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';
import { httpTransport, type TranscriptMessage } from '../../web/app/src/transport.js';
import type { TestStores } from './test-stores.js';
import { createTestStores } from './test-stores.js';
import { applyTestMigrations } from './apply-test-migrations.js';
import { silentModelStatus } from './model-status.js';
import { installBrowserFetch, type InstalledBrowser } from './browser-event-source.js';
import { createForwardAuthProxy, type ForwardAuthProxy } from './forward-auth-proxy.js';

/** The session key the server derives for a page that sends no session cookie. */
export const SESSION = 'client:127.0.0.1';

export interface WebModule {
  server: ReturnType<typeof createWebServer>;
  base: string;
  port: number;
}

export async function startWebModule(
  transcript: TranscriptReader,
  options: { port?: number; streamMaxAgeMs?: number; streamLeaseTtlMs?: number } = {}
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
    ...(options.streamLeaseTtlMs === undefined
      ? {}
      : { streamLeaseTtlMs: options.streamLeaseTtlMs }),
  });
  await server.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('the test server has no address');
  return { server, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

export async function stopWebModule(module: WebModule): Promise<void> {
  module.server.server.closeAllConnections?.();
  await module.server.close();
}

export async function insertRow(
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

export interface Page {
  stores: TestStores;
  transcript: PostgresTranscriptStore;
  recipientId: string;
  module: WebModule;
  /** Present when the page reaches the module through a ForwardAuth-style proxy. */
  proxy?: ForwardAuthProxy;
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
export async function openPage(
  recipientId: string,
  options: { streamMaxAgeMs?: number; forwardAuth?: boolean; streamLeaseTtlMs?: number } = {}
): Promise<Page> {
  const stores = await createTestStores();
  await applyTestMigrations(stores.postgres);
  const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipientId);
  const module = await startWebModule(transcript, options);
  const proxy = options.forwardAuth ? await createForwardAuthProxy(module.port) : undefined;
  const page: Page = {
    stores,
    transcript,
    recipientId,
    module,
    ...(proxy ? { proxy } : {}),
    browser: {} as InstalledBrowser,
    received: [],
    subscribe: () => undefined,
    restart: async () => undefined,
    close: async () => undefined,
  };
  page.browser = installBrowserFetch(proxy?.base ?? page.module.base);
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
    await page.proxy?.close();
    await stopWebModule(page.module);
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  };
  return page;
}

/** Every received row is distinct, in the order it arrived. */
export function exactlyOnce(messages: TranscriptMessage[]): void {
  const sequences = messages.map((message) => message.sequence);
  expect(new Set(sequences).size).toBe(sequences.length);
}
