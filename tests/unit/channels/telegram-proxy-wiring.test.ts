/**
 * Both Bot construction sites carry the proxy-aware client
 * (lifemodel-q4x.3.2 review finding 4).
 *
 * grammY builds its own https.Agent for node-fetch and never looks at the
 * proxy environment; the kernel rule refuses that direct socket, so every Bot
 * the channel makes must be handed the ONE shared proxy transport. grammy is
 * doubled here only to capture the constructor's arguments: the transport
 * itself is driven with the real library against real sockets in
 * telegram-proxy.test.ts, and through the real vault in the finding's e2e
 * proof.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramChannel, type TelegramConfig } from '../../../src/plugins/channels/telegram.js';
import { proxyFetch } from '../../../src/utils/proxy-fetch.js';
import type { IRecipientRegistry } from '../../../src/core/recipient-registry.js';

/** The constructor arguments every Bot the channel makes received. */
const botConstructorArgs: unknown[][] = [];

vi.mock('grammy', () => {
  class MockBot {
    on = vi.fn();
    catch = vi.fn();
    start = vi.fn().mockImplementation(function (this: MockBot, opts?: { onStart?: () => void }) {
      opts?.onStart?.();
      return Promise.resolve();
    });
    stop = vi.fn().mockResolvedValue(undefined);
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_1.jpg' }),
    };
    constructor(...args: unknown[]) {
      botConstructorArgs.push(args);
    }
  }
  return { Bot: MockBot };
});

vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue(
    new Response(Buffer.from('fake image bytes'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  )
);

function createMockLogger() {
  const mock = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  mock.child.mockReturnValue(mock);
  return mock;
}

const registry = {
  getOrCreate: vi.fn().mockReturnValue('rcpt_1'),
  resolve: vi.fn().mockReturnValue(null),
  lookup: vi.fn().mockReturnValue(null),
  getRecord: vi.fn().mockReturnValue(null),
  touch: vi.fn(),
  getAll: vi.fn().mockReturnValue([]),
  size: vi.fn().mockReturnValue(0),
} as unknown as IRecipientRegistry;

describe('Telegram channel gives both of its Bots the proxy transport (finding 4)', () => {
  let channel: TelegramChannel;
  const config: TelegramConfig = {
    botToken: '__telegram_bot_token__',
    timeout: 5000,
    maxRetries: 3,
    retryDelay: 100,
  };

  beforeEach(() => {
    botConstructorArgs.length = 0;
    channel = new TelegramChannel(config, createMockLogger() as never, registry);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("the polling client's Bot is constructed with the proxy fetch", async () => {
    await channel.start();
    expect(botConstructorArgs).toHaveLength(1);
    const [token, options] = botConstructorArgs[0] as [string, { client?: { fetch?: unknown } }];
    expect(token).toBe('__telegram_bot_token__');
    expect(options?.client?.fetch).toBe(proxyFetch);
  });

  it("the download client's Bot is constructed with the proxy fetch", async () => {
    // A replayed photo receipt reaches the download client while the channel
    // has not started: the download Bot is the second construction site.
    await (
      channel as unknown as {
        downloadPhoto: (fileId: string, maxBytes: number) => Promise<unknown>;
      }
    ).downloadPhoto('file_1', 1024);
    expect(botConstructorArgs).toHaveLength(1);
    const [, options] = botConstructorArgs[0] as [string, { client?: { fetch?: unknown } }];
    expect(options?.client?.fetch).toBe(proxyFetch);
  });
});
