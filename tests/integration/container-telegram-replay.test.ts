/**
 * The CONTAINER's own start order (lifemodel-ctc.2.1, review round 2 finding
 * 7): the replay of uncommitted inbound messages runs while the Telegram
 * channel has not started polling yet - index.ts calls
 * `telegramChannel.start()` only after createContainerAsync returned. A
 * replayed photo receipt must still be able to DOWNLOAD.
 *
 * This test builds the REAL container with the REAL TelegramChannel; only
 * grammY (the Bot class) and the photo download (global fetch) are doubles.
 * The fake channel of the restart tests proves the replay branch; this test
 * proves the branch can actually fetch before the channel runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface MockBotLike {
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  api: { getFile: ReturnType<typeof vi.fn> };
}

vi.mock('grammy', () => {
  class MockBot {
    static instances: MockBot[] = [];
    handlers = new Map<string, Function>();
    on = vi.fn().mockImplementation(function (this: MockBot, event: string, handler: Function) {
      this.handlers.set(event, handler);
    });
    catch = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/photo-file-1.jpg' }),
    };
    constructor() {
      MockBot.instances.push(this);
    }
  }
  return { Bot: MockBot };
});

import { Bot } from 'grammy';
import { createContainerAsync, type Container } from '../../src/core/container.js';
import { createInboundLog } from '../../src/core/inbound-log.js';
import { createRecipientRegistry } from '../../src/core/recipient-registry.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import { openStorage, rmDir } from '../helpers/core-loop-drain-harness.js';

/** A logger that keeps the seeded log quiet (the container logs itself). */
const quiet = {
  child: () => quiet,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
};

const mockBots = (Bot as unknown as { instances: MockBotLike[] }).instances;
const scratch: string[] = [];
const containers: Container[] = [];

afterEach(async () => {
  mockBots.length = 0;
  for (const container of containers.splice(0)) {
    await container.shutdown().catch(() => undefined);
  }
  for (const dir of scratch.splice(0)) {
    await rmDir(dir);
  }
  delete process.env['DATA_PATH'];
  vi.unstubAllGlobals();
});

/** Seed what a killed run leaves on disk: an uncommitted photo RECEIPT. */
async function seedPhotoReceipt(
  dataPath: string,
  updateId: string,
  fileId: string
): Promise<string> {
  const statePath = join(dataPath, 'state');
  const storage = await openStorage(statePath, quiet as never);
  const log = createInboundLog({ storage, logger: quiet as never, storagePath: statePath });
  await log.load();
  // The id the container's own registry derives for this route (a pure
  // function of channel+destination), so the replayed route resolves.
  const recipientId = createRecipientRegistry().getOrCreate('telegram', '777');
  await log.record(
    createUserMessageSignal({
      text: 'look at this picture',
      channel: 'telegram',
      userId: '7',
      recipientId,
      updateId,
      pendingPhoto: { fileId },
    }),
    { channel: 'telegram', destination: '777' }
  );
  await storage.flush();
  return recipientId;
}

async function freshDataPath(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  process.env['DATA_PATH'] = dir;
  return dir;
}

describe(
  'container start order: telegram photo replay (lifemodel-ctc.2.1)',
  { timeout: 30_000 },
  () => {
    it('re-fetches a replayed photo receipt BEFORE the channel polls (finding 7)', async () => {
      const dataPath = await freshDataPath('ctc2-container-photo-');
      const fileUrl = 'https://api.telegram.org/file/bottest-token/photos/photo-file-1.jpg';
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(Buffer.from('fake-jpeg-data'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);
      await seedPhotoReceipt(dataPath, 'u-photo-1', 'photo-file-1');

      // The container: its replay runs inside createContainerAsync, i.e. while
      // index.ts has not called start() on the channel yet.
      const container = await createContainerAsync({
        logDir: join(dataPath, 'logs'),
        // No log FILE: a pino file target writes from a worker thread, which
        // cannot be fenced or awaited, so it kept appending while the teardown
        // removed this data directory (ENOTEMPTY, review round 7).
        logToFile: false,
        telegram: { botToken: 'test-token' },
      });
      containers.push(container);

      expect(mockBots).toHaveLength(1);
      const bot = mockBots[0]!;
      // the download happened, through a client that is NOT polling
      expect(bot.api.getFile).toHaveBeenCalledWith('photo-file-1');
      expect(bot.start).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(fileUrl);

      // the receipt was REPLACED in place by the completed photo: still one
      // entry per update, now carrying the image
      const entries = container.inboundLog!.replayable();
      expect(entries).toHaveLength(1);
      const data = entries[0]!.signal.data as {
        images?: { mediaType: string }[];
        pendingPhoto?: unknown;
      };
      expect(data.pendingPhoto).toBeUndefined();
      expect(data.images).toHaveLength(1);
      expect(data.images![0]!.mediaType).toBe('image/jpeg');

      // and the completed photo is what the loop has QUEUED (not the caption)
      const queued = container.coreLoop.takePendingSignals();
      expect(queued).toHaveLength(1);
      const queuedData = queued[0]!.data as { text: string; images?: unknown[] };
      expect(queuedData.text).toBe('look at this picture');
      expect(queuedData.images).toHaveLength(1);

      // nothing committed yet: the answer has not been delivered
      expect(container.inboundLog!.size()).toEqual({ total: 1, uncommitted: 1 });
    });

    it('queues the caption text when the re-fetch fails before start (finding 7 fallback)', async () => {
      const dataPath = await freshDataPath('ctc2-container-photofail-');
      // the re-fetch cannot complete: the file download answers 404
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
      await seedPhotoReceipt(dataPath, 'u-photo-2', 'photo-file-2');

      const container = await createContainerAsync({
        logDir: join(dataPath, 'logs'),
        // No log FILE: a pino file target writes from a worker thread, which
        // cannot be fenced or awaited, so it kept appending while the teardown
        // removed this data directory (ENOTEMPTY, review round 7).
        logToFile: false,
        telegram: { botToken: 'test-token' },
      });
      containers.push(container);

      const bot = mockBots[0]!;
      expect(bot.api.getFile).toHaveBeenCalledWith('photo-file-2');
      expect(bot.start).not.toHaveBeenCalled();

      // the receipt itself is queued as its caption text: the message is not lost
      const queued = container.coreLoop.takePendingSignals();
      expect(queued).toHaveLength(1);
      const data = queued[0]!.data as { text: string; images?: unknown[]; pendingPhoto?: unknown };
      expect(data.text).toBe('look at this picture');
      expect(data.images).toBeUndefined();
      expect(container.inboundLog!.size()).toEqual({ total: 1, uncommitted: 1 });
    });
  }
);
