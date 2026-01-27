import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramChannel, type TelegramConfig, type TelegramMessagePayload } from '../../../src/channels/telegram.js';
import { Priority } from '../../../src/types/index.js';
import type { EventQueue, Event } from '../../../src/types/index.js';

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
    };
  }
  return { Bot: MockBot };
});

function createMockEventQueue(): EventQueue & { events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    push: vi.fn().mockImplementation(async (event: Event) => {
      events.push(event);
    }),
    pull: vi.fn().mockImplementation(async () => {
      return events.shift() ?? null;
    }),
    peek: vi.fn().mockImplementation(async () => {
      return events[0] ?? null;
    }),
    size: vi.fn().mockImplementation(() => events.length),
    sizeByPriority: vi.fn().mockReturnValue(new Map()),
  };
}

function createMockLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('TelegramChannel', () => {
  let channel: TelegramChannel;
  let eventQueue: ReturnType<typeof createMockEventQueue>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  const config: TelegramConfig = {
    botToken: 'test-bot-token',
    timeout: 5000,
    maxRetries: 2,
    retryDelay: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    eventQueue = createMockEventQueue();
    mockLogger = createMockLogger();
    channel = new TelegramChannel(config, eventQueue, mockLogger as unknown as Parameters<typeof TelegramChannel['prototype']['constructor']>[2]);
  });

  describe('isAvailable', () => {
    it('returns true when bot token is configured', () => {
      expect(channel.isAvailable()).toBe(true);
    });

    it('returns false when bot token is empty', () => {
      const noTokenChannel = new TelegramChannel(
        { botToken: '' },
        eventQueue,
        mockLogger as unknown as Parameters<typeof TelegramChannel['prototype']['constructor']>[2]
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
        eventQueue,
        mockLogger as unknown as Parameters<typeof TelegramChannel['prototype']['constructor']>[2]
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
    it('returns false when not configured', async () => {
      const noTokenChannel = new TelegramChannel(
        { botToken: '' },
        eventQueue,
        mockLogger as unknown as Parameters<typeof TelegramChannel['prototype']['constructor']>[2]
      );
      const result = await noTokenChannel.sendMessage('123', 'test');
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('Cannot send message: Telegram not configured');
    });

    it('returns false when bot not started', async () => {
      const result = await channel.sendMessage('123', 'test');
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('Cannot send message: Telegram bot not started');
    });

    it('sends message successfully after starting', async () => {
      await channel.start();
      const result = await channel.sendMessage('123456', 'Hello world');
      expect(result).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: '123456', textLength: 11 },
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

  describe('message conversion', () => {
    it('converts Telegram message to Event with correct structure', async () => {
      // Access private method via casting
      const privateChannel = channel as unknown as {
        onMessage: (ctx: {
          from?: { id: number; username?: string; first_name?: string; last_name?: string };
          chat: { id: number };
          message: { message_id: number; text?: string };
        }) => Promise<void>;
      };

      const mockCtx = {
        from: {
          id: 12345,
          username: 'testuser',
          first_name: 'Test',
          last_name: 'User',
        },
        chat: { id: 67890 },
        message: {
          message_id: 111,
          text: 'Hello from Telegram',
        },
      };

      await privateChannel.onMessage(mockCtx);

      expect(eventQueue.push).toHaveBeenCalledTimes(1);
      const event = eventQueue.events[0];

      expect(event.source).toBe('communication');
      expect(event.channel).toBe('telegram');
      expect(event.type).toBe('message_received');
      expect(event.priority).toBe(Priority.HIGH);

      const payload = event.payload as TelegramMessagePayload;
      expect(payload.userId).toBe('12345');
      expect(payload.chatId).toBe('67890');
      expect(payload.text).toBe('Hello from Telegram');
      expect(payload.messageId).toBe(111);
      expect(payload.username).toBe('testuser');
      expect(payload.firstName).toBe('Test');
      expect(payload.lastName).toBe('User');
    });

    it('skips messages without from field', async () => {
      const privateChannel = channel as unknown as {
        onMessage: (ctx: {
          from?: { id: number; username?: string; first_name?: string };
          chat: { id: number };
          message: { message_id: number; text?: string };
        }) => Promise<void>;
      };

      const mockCtx = {
        from: undefined,
        chat: { id: 67890 },
        message: {
          message_id: 111,
          text: 'Hello',
        },
      };

      await privateChannel.onMessage(mockCtx);
      expect(eventQueue.push).not.toHaveBeenCalled();
    });

    it('skips messages without text', async () => {
      const privateChannel = channel as unknown as {
        onMessage: (ctx: {
          from?: { id: number; username?: string; first_name?: string };
          chat: { id: number };
          message: { message_id: number; text?: string };
        }) => Promise<void>;
      };

      const mockCtx = {
        from: {
          id: 12345,
          username: 'testuser',
          first_name: 'Test',
        },
        chat: { id: 67890 },
        message: {
          message_id: 111,
          text: undefined,
        },
      };

      await privateChannel.onMessage(mockCtx);
      expect(eventQueue.push).not.toHaveBeenCalled();
    });
  });
});
