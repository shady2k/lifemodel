import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramChannel, type TelegramConfig } from '../../../src/plugins/channels/telegram.js';
import type { IRecipientRegistry } from '../../../src/core/recipient-registry.js';
import type { Signal } from '../../../src/types/index.js';
import type { UserMessageData, ImageAttachment } from '../../../src/types/signal.js';

// Mock the grammy module with a proper class
vi.mock('grammy', () => {
  class MockBot {
    handlers = new Map<string, Function>();
    on = vi.fn().mockImplementation(function (this: MockBot, event: string, handler: Function) {
      this.handlers.set(event, handler);
    });
    catch = vi.fn();
    start = vi
      .fn()
      .mockImplementation(function (this: MockBot, opts?: { onStart?: () => void }) {
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

// Helper to create a small valid JPEG-like base64 (just enough for testing)
const TINY_JPEG = Buffer.from('fake-jpeg-data').toString('base64');

describe('TelegramChannel photo handling', () => {
  let channel: TelegramChannel;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockRegistry: IRecipientRegistry;
  let capturedSignal: Signal | null;

  const config: TelegramConfig = {
    botToken: 'test-bot-token',
    timeout: 5000,
    maxRetries: 3,
    retryDelay: 100,
  };

  /** Call the private onPhoto method directly (avoids the `void` fire-and-forget in start()) */
  async function callOnPhoto(target: TelegramChannel, ctx: unknown): Promise<void> {
    await (target as any).onPhoto(ctx);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedSignal = null;
    mockLogger = createMockLogger();
    mockRegistry = createMockRecipientRegistry();
    channel = new TelegramChannel(config, mockLogger as any, mockRegistry);
    channel.setSignalCallback((signal: Signal) => {
      capturedSignal = signal;
    });

    await channel.start();

    // Verify the photo handler was registered
    const bot = (channel as any).bot;
    const photoCall = bot.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message:photo'
    );
    expect(photoCall).toBeDefined();
  });

  function createPhotoCtx(overrides?: {
    caption?: string;
    fileSize?: number;
    filePath?: string;
    chatId?: number;
    fetchResponse?: Response;
    fetchFails?: boolean;
    getFileFails?: boolean;
    noFilePath?: boolean;
  }) {
    const fileSize = overrides?.fileSize ?? 1000;
    const filePath = overrides?.filePath ?? 'photos/file_1.jpg';

    // Mock global fetch
    if (overrides?.fetchFails) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Network error'))
      );
    } else {
      const mockResponse =
        overrides?.fetchResponse ??
        new Response(Buffer.from('fake-jpeg-data'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
    }

    return {
      from: { id: 42, username: 'testuser', first_name: 'Test' },
      chat: { id: overrides?.chatId ?? 100 },
      message: {
        message_id: 999,
        photo: [
          { file_id: 'small_id', file_size: 100 },
          { file_id: 'large_id', file_size: fileSize },
        ],
        caption: overrides?.caption,
      },
      api: {
        getFile: overrides?.getFileFails
          ? vi.fn().mockRejectedValue(new Error('API error'))
          : vi.fn().mockResolvedValue({
              file_path: overrides?.noFilePath ? undefined : filePath,
            }),
      },
    };
  }

  it('creates signal with image data for a photo message', async () => {
    const ctx = createPhotoCtx({ caption: 'Look at this!' });
    await callOnPhoto(channel, ctx);

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.type).toBe('user_message');

    const data = capturedSignal!.data as UserMessageData;
    expect(data.text).toBe('Look at this!');
    expect(data.channel).toBe('telegram');
    expect(data.images).toHaveLength(1);
    expect(data.images![0]!.data).toBe(TINY_JPEG);
    expect(data.images![0]!.mediaType).toBe('image/jpeg');
  });

  it('uses [Photo] as caption fallback when no caption provided', async () => {
    const ctx = createPhotoCtx();
    await callOnPhoto(channel, ctx);

    const data = capturedSignal!.data as UserMessageData;
    expect(data.text).toBe('[Photo]');
  });

  it('selects the largest photo variant', async () => {
    const ctx = createPhotoCtx();
    await callOnPhoto(channel, ctx);

    // Should have called getFile with the last (largest) photo's file_id
    expect(ctx.api.getFile).toHaveBeenCalledWith('large_id');
  });

  it('determines mediaType from Content-Type header', async () => {
    const ctx = createPhotoCtx({
      fetchResponse: new Response(Buffer.from('fake-png'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    });
    await callOnPhoto(channel, ctx);

    const data = capturedSignal!.data as UserMessageData;
    expect(data.images![0]!.mediaType).toBe('image/png');
  });

  it('falls back to extension-based mediaType when Content-Type is not image/*', async () => {
    const ctx = createPhotoCtx({
      filePath: 'photos/file_1.png',
      fetchResponse: new Response(Buffer.from('fake-png'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    });
    await callOnPhoto(channel, ctx);

    const data = capturedSignal!.data as UserMessageData;
    expect(data.images![0]!.mediaType).toBe('image/png');
  });

  it('rejects photos exceeding 5MB from Telegram metadata', async () => {
    const ctx = createPhotoCtx({ fileSize: 6 * 1024 * 1024 });
    await callOnPhoto(channel, ctx);

    expect(capturedSignal).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fileSize: 6 * 1024 * 1024 }),
      'Photo too large, skipping'
    );
  });

  it('rejects photos exceeding 5MB after download', async () => {
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
    const ctx = createPhotoCtx({
      fileSize: 1000, // Metadata says small
      fetchResponse: new Response(bigBuffer, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    });
    await callOnPhoto(channel, ctx);

    expect(capturedSignal).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ byteLength: 6 * 1024 * 1024 }),
      'Photo too large after download, skipping'
    );
  });

  it('handles download failure gracefully', async () => {
    const ctx = createPhotoCtx({ fetchFails: true });
    await callOnPhoto(channel, ctx);

    expect(capturedSignal).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Network error' }),
      'Failed to process incoming photo'
    );
  });

  it('handles non-200 response gracefully', async () => {
    const ctx = createPhotoCtx({
      fetchResponse: new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    });
    await callOnPhoto(channel, ctx);

    expect(capturedSignal).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, statusText: 'Not Found' }),
      'Photo download failed'
    );
  });

  it('handles missing file_path from Telegram API', async () => {
    const ctx = createPhotoCtx({ noFilePath: true });
    await callOnPhoto(channel, ctx);

    expect(capturedSignal).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Photo file_path missing from Telegram API response'
    );
  });

  it('handles getFile API failure gracefully', async () => {
    const ctx = createPhotoCtx({ getFileFails: true });
    await callOnPhoto(channel, ctx);

    expect(capturedSignal).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'API error' }),
      'Failed to process incoming photo'
    );
  });

  it('respects allowedChatIds filter', async () => {
    const restrictedChannel = new TelegramChannel(
      { ...config, allowedChatIds: ['999'] },
      mockLogger as any,
      mockRegistry
    );
    restrictedChannel.setSignalCallback((signal: Signal) => {
      capturedSignal = signal;
    });
    await restrictedChannel.start();

    const ctx = createPhotoCtx({ chatId: 100 }); // Not in allowed list
    await callOnPhoto(restrictedChannel, ctx);

    expect(capturedSignal).toBeNull();
  });
});
