import { describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../../src/web/server.js';
import type { IOwnerMessageIntake } from '../../src/ports/owner-message-intake.js';
import type { TranscriptRow } from '../../src/ports/transcript.js';
import { httpTransport, parseTranscriptMessage } from '../../web/app/src/transport.js';

const row: TranscriptRow = {
  sequence: '7',
  role: 'assistant',
  text: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('web server and browser transport contract', () => {
  it('parses empty and populated transcript pages from the real server', async () => {
    const readTranscript = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], cursor: null })
      .mockResolvedValueOnce({ rows: [row], cursor: '7' });
    const server = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: { acceptOwnerMessage: vi.fn() } as unknown as IOwnerMessageIntake,
      transcript: {
        readTranscript,
        watchTranscript: vi.fn(),
        acquireStreamLease: vi.fn().mockResolvedValue('lease'),
        releaseStreamLease: vi.fn(),
      } as never,
      creatureState: { readCreatureState: vi.fn().mockResolvedValue(null) },
      logger: { info: vi.fn() },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const response = await server.inject({
        method: 'GET',
        url: String(input).replace(/^\//, '/'),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers as HeadersInit,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(await httpTransport.readTranscript()).toEqual({ messages: [], cursor: null });
      expect(await httpTransport.readTranscript({ before: '9' })).toEqual({
        messages: [row],
        cursor: '7',
      });
      expect(readTranscript).toHaveBeenNthCalledWith(1, { limit: 50 });
      expect(readTranscript).toHaveBeenNthCalledWith(2, { before: '9', limit: 50 });
      expect(parseTranscriptMessage(row)).toEqual(row);
    } finally {
      vi.unstubAllGlobals();
      await server.close();
    }
  });
});
