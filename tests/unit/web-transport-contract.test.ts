import { describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../../src/web/server.js';
import { silentModelStatus } from '../helpers/model-status.js';
import type { IOwnerMessageIntake } from '../../src/ports/owner-message-intake.js';
import type { TranscriptRow } from '../../src/ports/transcript.js';
import {
  httpTransport,
  parseCreatureStateEvent,
  parseTranscriptMessage,
} from '../../web/app/src/transport.js';

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
      .mockResolvedValueOnce({ rows: [row], cursor: '7' })
      .mockResolvedValueOnce({ rows: [], cursor: null });
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
        renewStreamLease: vi.fn().mockResolvedValue(true),
        releaseStreamLease: vi.fn(),
      } as never,
      creatureState: { readCreatureState: vi.fn().mockResolvedValue(null) },
      modelStatus: silentModelStatus(),
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
      expect(await httpTransport.readTranscript('9')).toEqual({
        messages: [row],
        cursor: '7',
      });
      expect(readTranscript).toHaveBeenNthCalledWith(1, { limit: 50 });
      expect(readTranscript).toHaveBeenNthCalledWith(2, { before: '9', limit: 50 });
      expect(await httpTransport.readTranscript(undefined, '3')).toEqual({
        messages: [],
        cursor: null,
      });
      expect(readTranscript).toHaveBeenNthCalledWith(3, { after: '3', limit: 50 });
      expect(parseTranscriptMessage(row)).toEqual(row);
    } finally {
      vi.unstubAllGlobals();
      await server.close();
    }
  });

  it('emits non-null state frames in the shared browser state shape', async () => {
    const publishedAt = '2026-01-01T00:00:00.000Z';
    const server = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: { acceptOwnerMessage: vi.fn() } as unknown as IOwnerMessageIntake,
      transcript: {
        readTranscript: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
        watchTranscript: vi.fn(() => new Promise<never>(() => undefined)),
        acquireStreamLease: vi.fn().mockResolvedValue('lease'),
        renewStreamLease: vi.fn().mockResolvedValue(true),
        releaseStreamLease: vi.fn().mockResolvedValue(undefined),
      } as never,
      creatureState: {
        readCreatureState: vi.fn().mockResolvedValue({
          state: 'thinking',
          epoch: 55,
          publishedAt: Date.parse(publishedAt),
        }),
      },
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/api/events?after=0`, { signal: controller.signal });
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('event: state')) {
        const part = await reader.read();
        if (part.done) throw new Error('SSE stream ended before the state event');
        text += new TextDecoder().decode(part.value);
      }
      const frame = text.split('\n\n').find((chunk) => chunk.includes('event: state'))!;
      expect(frame).not.toContain('id:');
      const json = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice(6);
      expect(parseCreatureStateEvent(JSON.parse(json))).toEqual({
        state: 'thinking',
        epoch: '55',
        publishedAt,
      });
      expect(parseCreatureStateEvent(null)).toBeNull();
      await reader.cancel();
    } finally {
      controller.abort();
      await server.close();
    }
  });

  it('emits SSE message data in the shared browser message shape', async () => {
    const server = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: { acceptOwnerMessage: vi.fn() } as unknown as IOwnerMessageIntake,
      transcript: {
        readTranscript: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
        async *watchTranscript() {
          yield row;
        },
        acquireStreamLease: vi.fn().mockResolvedValue('lease'),
        renewStreamLease: vi.fn().mockResolvedValue(true),
        releaseStreamLease: vi.fn().mockResolvedValue(undefined),
      },
      creatureState: { readCreatureState: vi.fn().mockResolvedValue(null) },
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/api/events?after=0`, { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('event: message')) {
        const part = await reader.read();
        if (part.done) throw new Error('SSE stream ended before the message event');
        text += new TextDecoder().decode(part.value);
      }
      const frame = text.split('\n\n').find((chunk) => chunk.includes('event: message'))!;
      const json = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice(6);
      expect(parseTranscriptMessage(JSON.parse(json))).toEqual(row);
      expect(frame).toContain('id: 7');
      await reader.cancel();
    } finally {
      controller.abort();
      await server.close();
    }
  });
});
