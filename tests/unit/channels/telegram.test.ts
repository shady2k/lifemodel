import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramChannel, type TelegramConfig, splitMessage } from '../../../src/plugins/channels/telegram.js';
import type { IRecipientRegistry } from '../../../src/core/recipient-registry.js';

// Mock the grammy module with a proper class
vi.mock('grammy', () => {
  class MockBot {
    on = vi.fn();
    catch = vi.fn();
    start = vi.fn().mockImplementation(function(this: MockBot, opts?: { onStart?: () => void }) {
      opts?.onStart?.();
      return Promise.resolve();
    });
    stop = vi.fn().mockResolvedValue(undefined);
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
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
  // Make child() return a new mock with same methods
  mock.child.mockReturnValue(mock);
  return mock;
}

function createMockRecipientRegistry(): IRecipientRegistry {
  const records = new Map<string, { channel: string; destination: string }>();
  const byRoute = new Map<string, string>();

  return {
    getOrCreate: vi.fn().mockImplementation((channel: string, destination: string) => {
      const key = `${channel}:${destination}`;
      let recipientId = byRoute.get(key);
      if (!recipientId) {
        recipientId = `rcpt_${destination}`;
        byRoute.set(key, recipientId);
        records.set(recipientId, { channel, destination });
      }
      return recipientId;
    }),
    resolve: vi.fn().mockImplementation((recipientId: string) => {
      return records.get(recipientId) ?? null;
    }),
    lookup: vi.fn().mockImplementation((channel: string, destination: string) => {
      return byRoute.get(`${channel}:${destination}`) ?? null;
    }),
    getRecord: vi.fn().mockReturnValue(null),
    touch: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    size: vi.fn().mockReturnValue(0),
  };
}

describe('TelegramChannel', () => {
  let channel: TelegramChannel;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockRegistry: IRecipientRegistry;

  const config: TelegramConfig = {
    botToken: 'test-bot-token',
    timeout: 5000,
    maxRetries: 3,
    retryDelay: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    mockRegistry = createMockRecipientRegistry();
    channel = new TelegramChannel(config, mockLogger as any, mockRegistry);
  });

  describe('isAvailable', () => {
    it('returns true when bot token is configured', () => {
      expect(channel.isAvailable()).toBe(true);
    });

    it('returns false when bot token is empty', () => {
      const noTokenChannel = new TelegramChannel(
        { botToken: '' },
        mockLogger as any,
        mockRegistry
      );
      expect(noTokenChannel.isAvailable()).toBe(false);
    });
  });

  describe('name', () => {
    it('returns "telegram"', () => {
      expect(channel.name).toBe('telegram');
    });
  });

  describe('start', () => {
    it('starts the bot when configured', async () => {
      await channel.start();
      expect(mockLogger.info).toHaveBeenCalledWith('Telegram channel started');
    });

    it('skips start when not configured', async () => {
      const noTokenChannel = new TelegramChannel(
        { botToken: '' },
        mockLogger as any,
        mockRegistry
      );
      await noTokenChannel.start();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Telegram bot token not configured, skipping start'
      );
    });

    it('warns when already running', async () => {
      await channel.start();
      await channel.start();
      expect(mockLogger.warn).toHaveBeenCalledWith('Telegram channel already running');
    });
  });

  describe('stop', () => {
    it('stops the bot after starting', async () => {
      await channel.start();
      await channel.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Telegram channel stopped');
    });

    it('does nothing if not running', async () => {
      await channel.stop();
      // Should not throw
    });
  });

  describe('sendMessage', () => {
    it('returns { success: false } when not configured', async () => {
      const noTokenChannel = new TelegramChannel(
        { botToken: '' },
        mockLogger as any,
        mockRegistry
      );
      const result = await noTokenChannel.sendMessage('123', 'test');
      expect(result.success).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('Cannot send message: Telegram not configured');
    });

    it('returns { success: false } when bot not started', async () => {
      const result = await channel.sendMessage('123', 'test');
      expect(result.success).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('Cannot send message: Telegram bot not started');
    });

    it('sends message successfully after starting and returns messageId', async () => {
      await channel.start();
      const result = await channel.sendMessage('123456', 'Hello world');
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('123'); // Mock returns message_id: 123
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: '123456', textLength: 11, messageId: '123' }),
        'Message sent'
      );
    });
  });

  describe('getCircuitStats', () => {
    it('returns circuit breaker statistics', () => {
      const stats = channel.getCircuitStats();
      expect(stats).toHaveProperty('state');
      expect(stats).toHaveProperty('failures');
      expect(stats).toHaveProperty('lastFailureTime');
    });
  });

  describe('recipientRegistry integration', () => {
    it('registers recipient on getOrCreate', () => {
      // The TelegramChannel uses recipientRegistry when receiving messages
      // This tests that the mock is properly wired
      const recipientId = mockRegistry.getOrCreate('telegram', '12345');
      expect(recipientId).toBe('rcpt_12345');
      expect(mockRegistry.getOrCreate).toHaveBeenCalledWith('telegram', '12345');
    });

    it('resolves recipient to route', () => {
      // First create the recipient
      mockRegistry.getOrCreate('telegram', '67890');

      // Then resolve should return the route
      const route = mockRegistry.resolve('rcpt_67890');
      expect(route).toEqual({ channel: 'telegram', destination: '67890' });
    });
  });
});

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('returns single chunk at exact limit', () => {
    const text = 'a'.repeat(4096);
    expect(splitMessage(text)).toEqual([text]);
  });

  it('splits at paragraph boundary', () => {
    const p1 = 'a'.repeat(3000);
    const p2 = 'b'.repeat(3000);
    const text = `${p1}\n\n${p2}`;
    const chunks = splitMessage(text);
    expect(chunks).toEqual([p1, p2]);
  });

  it('splits at newline when no paragraph boundary', () => {
    const l1 = 'a'.repeat(3000);
    const l2 = 'b'.repeat(3000);
    const text = `${l1}\n${l2}`;
    const chunks = splitMessage(text);
    expect(chunks).toEqual([l1, l2]);
  });

  it('splits at space when no newline', () => {
    const w1 = 'a'.repeat(3000);
    const w2 = 'b'.repeat(3000);
    const text = `${w1} ${w2}`;
    const chunks = splitMessage(text);
    expect(chunks).toEqual([w1, w2]);
  });

  it('hard cuts when no whitespace', () => {
    const text = 'x'.repeat(5000);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(904);
  });

  it('handles multiple chunks', () => {
    const text = Array.from({ length: 5 }, (_, i) => String(i).repeat(2000)).join('\n\n');
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('respects custom maxLength', () => {
    const text = 'a'.repeat(50);
    const chunks = splitMessage(text, 20);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(20);
    expect(chunks[1]).toHaveLength(20);
    expect(chunks[2]).toHaveLength(10);
  });

  it('strips leading whitespace from subsequent chunks', () => {
    const text = 'a'.repeat(10) + '\n\n\n' + 'b'.repeat(10);
    const chunks = splitMessage(text, 12);
    expect(chunks[1]).toBe('b'.repeat(10));
    expect(chunks[1][0]).not.toBe('\n');
  });
});
