/**
 * Telegram photo handling with durable receipts (lifemodel-ctc.2.1, review
 * round 2 finding 7): a receipt is emitted at handler entry BEFORE any
 * network work; the completed photo (or the caption-only fallback when the
 * download is unusable) is emitted afterwards.
 */
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
    start = vi.fn().mockImplementation(function (this: MockBot, opts?: { onStart?: () => void }) {
      opts?.onStart?.();
      return Promise.resolve();
    });
    stop = vi.fn().mockResolvedValue(undefined);
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn(),
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

describe('TelegramChannel photo handling (durable receipts)', () => {
  let channel: TelegramChannel;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockRegistry: IRecipientRegistry;
  let capturedSignals: Signal[];

  const config: TelegramConfig = {
    botToken: 'test-bot-token',
    timeout: 5000,
    maxRetries: 3,
    retryDelay: 100,
  };

  /** Call the private onPhoto method directly (avoids the fire-and-forget in start()) */
  async function callOnPhoto(target: TelegramChannel, ctx: unknown): Promise<void> {
    await (target as any).onPhoto(ctx);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedSignals = [];
    mockLogger = createMockLogger();
    mockRegistry = createMockRecipientRegistry();
    channel = new TelegramChannel(config, mockLogger as any, mockRegistry);
    channel.setSignalCallback((signal: Signal) => {
      capturedSignals.push(signal);
    });

    await channel.start();

    // Verify the photo handler was registered
    const bot = (channel as any).bot;
    const photoCall = bot.on.mock.calls.find((call: unknown[]) => call[0] === 'message:photo');
    expect(photoCall).toBeDefined();
  });

  function setBotGetFile(
    result: { file_path?: string } | never[] | Promise<never>,
    opts?: { rejects?: boolean }
  ): ReturnType<typeof vi.fn> {
    const bot = (channel as any).bot;
    const getFile = opts?.rejects
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
    bot.api.getFile = getFile;
    return bot.api.getFile;
  }

  function createPhotoCtx(overrides?: {
    caption?: string;
    fileSize?: number;
    filePath?: string;
    chatId?: number;
    fetchResponse?: Response;
    fetchFails?: boolean;
  }) {
    const fileSize = overrides?.fileSize ?? 1000;
    const filePath = overrides?.filePath ?? 'photos/file_1.jpg';

    // Mock global fetch
    if (overrides?.fetchFails) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    } else {
      const mockResponse =
        overrides?.fetchResponse ??
        new Response(Buffer.from('fake-jpeg-data'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
    }

    setBotGetFile({ file_path: filePath });

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
      update: { update_id: 42_042 },
    };
  }

  it('records a durable receipt BEFORE the download and the full photo after it', async () => {
    const ctx = createPhotoCtx({ caption: 'Look at this!' });
    await callOnPhoto(channel, ctx);

    expect(capturedSignals).toHaveLength(2);
    // FIRST: the receipt (no images, pendingPhoto carries the file id)
    const receipt = capturedSignals[0] as Signal;
    const receiptData = receipt.data as UserMessageData;
    expect(receiptData.text).toBe('Look at this!');
    expect(receiptData.images).toBeUndefined();
    expect(receiptData.pendingPhoto?.fileId).toBe('large_id');
    expect(receiptData.updateId).toBe('42042');
    // THEN: the completed photo message (same update_id, now with images)
    const photo = capturedSignals[1] as Signal;
    const photoData = photo.data as UserMessageData;
    expect(photoData.text).toBe('Look at this!');
    expect(photoData.channel).toBe('telegram');
    expect(photoData.images).toHaveLength(1);
    expect(photoData.images![0]!.data).toBe(TINY_JPEG);
    expect(photoData.images![0]!.mediaType).toBe('image/jpeg');
    expect(photoData.updateId).toBe('42042');
    expect(photoData.pendingPhoto).toBeUndefined();
  });

  it('uses [Photo] as caption fallback when no caption provided', async () => {
    const ctx = createPhotoCtx();
    await callOnPhoto(channel, ctx);

    const data = (capturedSignals[1] as Signal)!.data as UserMessageData;
    expect(data.text).toBe('[Photo]');
  });

  it('downloads through the largest photo variant file id', async () => {
    const ctx = createPhotoCtx();
    await callOnPhoto(channel, ctx);

    // Called (once for the receipt is not needed): the download fetches the
    // largest photo's file id
    expect(capturedSignals[0]).toBeDefined();
    // the fetch used the bot token + the resolved path
    const fetchMock = vi.mocked(globalThis.fetch as unknown as ReturnType<typeof vi.fn>);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('photos/file_1.jpg'));
  });

  it('determines mediaType from Content-Type header', async () => {
    const ctx = createPhotoCtx({
      fetchResponse: new Response(Buffer.from('fake-png'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    });
    await callOnPhoto(channel, ctx);

    const data = (capturedSignals[1] as Signal)!.data as UserMessageData;
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

    const data = (capturedSignals[1] as Signal)!.data as UserMessageData;
    expect(data.images![0]!.mediaType).toBe('image/png');
  });

  it('an oversized photo (metadata) delivers the caption-only fallback', async () => {
    const ctx = createPhotoCtx({ fileSize: 6 * 1024 * 1024 });
    await callOnPhoto(channel, ctx);

    expect(capturedSignals).toHaveLength(1);
    const last = capturedSignals[0] as Signal;
    const data = last.data as UserMessageData;
    expect(data.images).toBeUndefined();
    expect(data.pendingPhoto).toBeUndefined();
    expect(data.text).toBe('[Photo]');
  });

  it('an oversized photo (after download) delivers the caption-only fallback', async () => {
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
    const ctx = createPhotoCtx({
      fileSize: 1000, // Metadata says small
      fetchResponse: new Response(bigBuffer, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    });
    await callOnPhoto(channel, ctx);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ byteLength: 6 * 1024 * 1024 }),
      'Photo too large after download, skipping'
    );
    const data = (capturedSignals[1] as Signal)!.data as UserMessageData;
    expect(data.images).toBeUndefined();
  });

  it('a transport failure delivers the caption-only fallback', async () => {
    const ctx = createPhotoCtx({ fetchFails: true });
    await callOnPhoto(channel, ctx);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Network error' }),
      'Failed to download incoming photo; the caption-only fallback is queued'
    );
    const last = capturedSignals.at(-1) as Signal;
    expect((last.data as UserMessageData).images).toBeUndefined();
  });

  it('a non-200 response delivers the caption-only fallback', async () => {
    const ctx = createPhotoCtx({
      fetchResponse: new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    });
    await callOnPhoto(channel, ctx);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, statusText: 'Not Found' }),
      'Photo download failed'
    );
    const data = (capturedSignals.at(-1) as Signal)!.data as UserMessageData;
    expect(data.images).toBeUndefined();
  });

  it('a missing file_path delivers the caption-only fallback', async () => {
    const ctx = createPhotoCtx();
    setBotGetFile({ file_path: undefined });
    await callOnPhoto(channel, ctx);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Photo file_path missing from Telegram API response'
    );
    const data = (capturedSignals.at(-1) as Signal)!.data as UserMessageData;
    expect(data.images).toBeUndefined();
  });

  it('a getFile API failure delivers the caption-only fallback', async () => {
    const ctx = createPhotoCtx();
    setBotGetFile(new Error('API error') as never, { rejects: true });
    await callOnPhoto(channel, ctx);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'API error' }),
      'Failed to download incoming photo; the caption-only fallback is queued'
    );
    const last = capturedSignals.at(-1) as Signal;
    expect((last.data as UserMessageData).images).toBeUndefined();
  });

  it('respects allowedChatIds filter (no receipt, no message)', async () => {
    const restrictedChannel = new TelegramChannel(
      { ...config, allowedChatIds: ['999'] },
      mockLogger as any,
      mockRegistry
    );
    restrictedChannel.setSignalCallback((signal: Signal) => {
      capturedSignals.push(signal);
    });
    await restrictedChannel.start();

    const ctx = createPhotoCtx({ chatId: 100 }); // Not in allowed list
    await callOnPhoto(restrictedChannel, ctx);

    expect(capturedSignals).toEqual([]);
  });

  it('completes a replayed receipt by re-fetching the file (finding 7)', async () => {
    const ctx = createPhotoCtx({ caption: 'later' });
    const receiptSignal = (capturedSignals[0] as Signal | undefined) ?? null;
    void ctx;
    // simulate a restart replay: the receipt arrives alone, with the route
    // already re-registered (what the container's replay does from the entry)
    capturedSignals = [];
    mockRegistry.getOrCreate('telegram', '100');
    const receipt = (async () => {
      const { createUserMessageSignal } =
        (await import('../../../src/types/signal.js')) as typeof import('../../../src/types/signal.js');
      return createUserMessageSignal({
        text: 'later',
        channel: 'telegram',
        userId: '42',
        recipientId: 'rcpt_100',
        pendingPhoto: { fileId: 'large_id' },
        updateId: '42042',
      });
    })();
    const receipt2 = await receipt;
    void receiptSignal;
    const done = await channel.completePhotoReceipt(receipt2);
    expect(done).toBe(true);
    expect(capturedSignals).toHaveLength(1);
    const data = (capturedSignals[0] as Signal)!.data as UserMessageData;
    expect(data.images).toHaveLength(1);
    expect(data.pendingPhoto).toBeUndefined();
    expect(data.updateId).toBe('42042');
  });
});
