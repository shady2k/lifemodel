/**
 * The Telegram channel carries the Telegram update_id on user_message
 * signals (the durable inbound log deduplicates on it), and the inbound
 * callback is AWAITED so the log flushes at emit time (lifemodel-ctc.2.1).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramChannel, type TelegramConfig } from '../../../src/plugins/channels/telegram.js';
import type { IRecipientRegistry } from '../../../src/core/recipient-registry.js';
import type { Signal } from '../../../src/types/index.js';

vi.mock('grammy', () => {
  class MockBot {
    handlers = new Map<string, Function>();
    on = vi.fn().mockImplementation(function (this: MockBot, event: string, handler: Function) {
      this.handlers.set(event, handler);
    });
    catch = vi.fn();
    start = vi.fn().mockImplementation(function (this: MockBot, opts?: { onStart?: () => void }) {
      opts?.onStart?.();
      return Promise.resolve();
    });
    stop = vi.fn().mockResolvedValue(undefined);
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendChatAction: vi.fn().mockResolvedValue(true),
    };
  }
  return { Bot: MockBot };
});

function createMockLogger() {
  const mock = {
    child: vi.fn(),
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

function createMockRecipientRegistry(): IRecipientRegistry {
  const records = new Map<string, { channel: string; destination: string }>();
  return {
    getOrCreate: vi.fn().mockImplementation((channel: string, destination: string) => {
      const key = `${channel}:${destination}`;
      let id = [...records.keys()].find((k) => key === `${records.get(k)?.channel}:${records.get(k)?.destination}`);
      if (!id) {
        id = `rcpt_${destination}`;
        records.set(id, { channel, destination });
      }
      return id;
    }),
    resolve: vi.fn().mockImplementation((id: string) => records.get(id) ?? null),
    lookup: vi.fn().mockReturnValue(null),
    getRecord: vi.fn().mockReturnValue(null),
    touch: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    size: vi.fn().mockReturnValue(0),
  } as unknown as IRecipientRegistry;
}

const config: TelegramConfig = {
  botToken: 'test-bot-token',
  timeout: 5000,
  maxRetries: 3,
  retryDelay: 100,
};

describe('TelegramChannel update_id propagation (lifemodel-ctc.2.1)', () => {
  let channel: TelegramChannel;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockRegistry: IRecipientRegistry;
  let captured: Signal | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    captured = null;
    mockLogger = createMockLogger();
    mockRegistry = createMockRecipientRegistry();
    channel = new TelegramChannel(config, mockLogger as never, mockRegistry);
    await channel.start();
  });

  function textHandler(): Function {
    const bot = (channel as unknown as { bot: { handlers: Map<string, Function> } }).bot;
    const call = bot.handlers.get('message:text');
    expect(call).toBeDefined();
    return call as Function;
  }

  it('a text message signal carries the wrapping update_id and the async callback is awaited', async () => {
    let settled = false;
    channel.setSignalCallback(async (signal: Signal) => {
      await new Promise((r) => setTimeout(r, 10));
      captured = signal;
      settled = true;
    });

    const handler = textHandler();
    const emitDone = handler({
      from: { id: 7, username: 'u', first_name: 'U', last_name: '' },
      chat: { id: 42 },
      message: { message_id: 5, text: 'hello' },
      update: { update_id: 991_234 },
    });
    // the handler must not resolve before the awaited callback settled
    expect(settled).toBe(false);
    await emitDone;
    expect(settled).toBe(true);
    const data = captured?.data as { updateId?: string } | undefined;
    expect(data?.updateId).toBe('991234');
  });

  it('a photo message signal carries the update_id too', async () => {
    const bot = (channel as unknown as { bot: { handlers: Map<string, Function> } }).bot;
    const photoHandler = bot.handlers.get('message:photo');
    expect(photoHandler).toBeDefined();

    channel.setSignalCallback(async (signal: Signal) => {
      captured = signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]) as unknown as Headers,
        arrayBuffer: async () => new ArrayBuffer(4),
      })
    );

    await photoHandler({
      from: { id: 7, username: 'u', first_name: 'U', last_name: '' },
      chat: { id: 42 },
      message: { message_id: 6, photo: [{ file_id: 'f1', file_size: 4 }] },
      api: { getFile: async () => ({ file_path: 'photos/f1.jpg' }) },
      update: { update_id: 777_001 },
    });

    const data = captured?.data as { updateId?: string } | undefined;
    expect(data?.updateId).toBe('777001');
    vi.unstubAllGlobals();
  });

  it('stopIntake awaits in-flight emits (bounded), so the log flush lands', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    channel.setSignalCallback(() => gate);

    const handler = textHandler();
    const emitDone = handler({
      from: { id: 7 },
      chat: { id: 42 },
      message: { message_id: 8, text: 'held' },
      update: { update_id: 1_000_000 },
    });
    const stopping = channel.stopIntake();
    // the in-flight emit is awaited, bounded by the internal cap
    release?.();
    await Promise.all([emitDone, stopping]);
  });
});
