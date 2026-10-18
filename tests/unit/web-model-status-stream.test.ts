import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createWebServer } from '../../src/web/server.js';
import type { IOwnerMessageIntake } from '../../src/ports/owner-message-intake.js';
import type { CreatureStateReader } from '../../src/ports/creature-state.js';
import type { ModelStatusSource } from '../../src/web/model-status.js';
import type { ModelStatusEvent } from '../../src/web/contract.js';
import { ModelStatusPoller } from '../../src/web/model-status-poller.js';
import type { TranscriptRow } from '../../src/ports/transcript.js';
import { silentModelStatus, stubModelStatus } from '../helpers/model-status.js';

const GATEWAY_STATUS_URL = 'http://model-gateway.lifemodel-system.svc:8081/status';
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function creatureState(state: 'thinking' | 'awake' | 'asleep'): CreatureStateReader {
  return {
    readCreatureState: vi.fn().mockResolvedValue({
      state,
      epoch: 7,
      publishedAt: Date.now(),
      ageMs: 0,
    }),
  };
}

function createServer(options: {
  modelStatus: ModelStatusSource;
  creature?: CreatureStateReader;
  /** A transcript row the stream carries, if any. */
  message?: TranscriptRow;
  /** Receives the `after` cursor every watch starts from. */
  watchedAfter?: string[];
}): FastifyInstance {
  const server = createWebServer({
    allowedOrigin: 'https://lifemodel.local',
    instanceName: 'lifemodel',
    appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
    runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
    intake: { acceptOwnerMessage: vi.fn() } as unknown as IOwnerMessageIntake,
    transcript: {
      readTranscript: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
      watchTranscript: vi.fn(async function* (after: string) {
        options.watchedAfter?.push(after);
        if (options.message !== undefined) yield options.message;
        await new Promise<void>(() => undefined);
      }),
      acquireStreamLease: vi.fn().mockResolvedValue('lease'),
      releaseStreamLease: vi.fn().mockResolvedValue(undefined),
    } as never,
    creatureState: options.creature ?? creatureState('thinking'),
    modelStatus: options.modelStatus,
    logger: { info: vi.fn() },
  });
  servers.push(server);
  return server;
}

interface OpenStream {
  text(): string;
  frames(event: string): string[];
  waitFor(event: string, count: number, timeoutMs?: number): Promise<string[]>;
  close(): Promise<void>;
}

const bases = new WeakMap<FastifyInstance, string>();

async function baseOf(server: FastifyInstance): Promise<string> {
  const known = bases.get(server);
  if (known !== undefined) return known;
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  bases.set(server, address);
  return address;
}

async function openStream(
  server: FastifyInstance,
  headers: Record<string, string> = {}
): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${await baseOf(server)}/api/events?after=0`, {
    signal: controller.signal,
    headers,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  // The whole raw frame, exactly as the wire carries it: an `id:` line before
  // `event:` is part of the frame and must stay visible to the assertions.
  const frames = (event: string): string[] =>
    text
      .split('\n\n')
      .filter((chunk) => chunk.split('\n').includes(`event: ${event}`));
  const waitFor = async (event: string, count: number, timeoutMs = 2_000): Promise<string[]> => {
    const deadline = Date.now() + timeoutMs;
    while (frames(event).length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`only ${String(frames(event).length)} ${event} frames within the bound`);
      const next = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => {
            resolve('timeout');
          }, remaining);
        }),
      ]);
      if (next === 'timeout')
        throw new Error(`no ${event} frame within the bound; the stream carried: ${text}`);
      if (next.done) throw new Error(`the stream ended before ${event}`);
      text += decoder.decode(next.value, { stream: true });
    }
    return frames(event);
  };
  return {
    text: () => text,
    frames,
    waitFor,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

/**
 * The cursor a browser's EventSource would resume from after reading `text`: the
 * value of the last `id:` line it saw, across frames of every kind (ADR-011 D6).
 */
function resumeCursor(text: string): string | null {
  let cursor: string | null = null;
  for (const frame of text.split('\n\n')) {
    const line = frame.split('\n').find((part) => part.startsWith('id:'));
    if (line !== undefined) cursor = line.slice('id:'.length).trim();
  }
  return cursor;
}

function statusData(frame: string): unknown {
  const line = frame
    .split('\n')
    .find((part) => part.startsWith('data: '))!
    .slice('data: '.length);
  return JSON.parse(line) as unknown;
}

describe('the model status in the event stream (ADR-013 D6)', () => {
  it('carries a status change alone as its own envelope, without a resume id', async () => {
    const source = stubModelStatus({ state: 'ok', outageSince: null, lastErrorCode: null });
    const server = createServer({ modelStatus: source });
    const stream = await openStream(server);
    try {
      const first = await stream.waitFor('model', 1);
      expect(statusData(first[0]!)).toEqual({ state: 'ok', outageSince: null, lastErrorCode: null });
      expect(first[0]).not.toContain('id:');
      source.set({
        state: 'down',
        outageSince: new Date(Date.now() - 60_000).toISOString(),
        lastErrorCode: 'unreachable',
      });
      const frames = await stream.waitFor('model', 2);
      expect(frames).toHaveLength(2);
      expect(statusData(frames[1]!)).toEqual({
        state: 'down',
        outageSince: expect.any(String),
        lastErrorCode: 'unreachable',
      });
      expect(source.starts()).toBe(1);
    } finally {
      await stream.close();
    }
  });

  it('shows unavailable, never an outage, when the status fetch fails', async () => {
    const poller = new ModelStatusPoller({
      url: GATEWAY_STATUS_URL,
      pollMs: 50,
      timeoutMs: 20,
      fetch: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.43.0.7:8081')),
    });
    const server = createServer({ modelStatus: poller });
    const stream = await openStream(server);
    try {
      const frames = await stream.waitFor('model', 1);
      expect(statusData(frames[0]!)).toBeNull();
      expect(stream.text()).not.toContain('down');
      expect(stream.text()).not.toContain('outageSince');
      expect(stream.text()).not.toContain('model-gateway.lifemodel-system');
    } finally {
      await stream.close();
    }
  });

  it('keeps the state stream moving while the status fetch hangs', async () => {
    const poller = new ModelStatusPoller({
      url: GATEWAY_STATUS_URL,
      pollMs: 25,
      timeoutMs: 10_000,
      fetch: vi.fn(() => new Promise<Response>(() => undefined)),
    });
    let state: 'thinking' | 'awake' = 'thinking';
    const creature: CreatureStateReader = {
      readCreatureState: vi.fn(async () => ({
        state,
        epoch: 7,
        publishedAt: Date.now(),
        ageMs: 0,
      })),
    };
    const server = createServer({ modelStatus: poller, creature });
    const stream = await openStream(server);
    try {
      const started = Date.now();
      const first = await stream.waitFor('state', 1, 1_500);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(statusData(first[0]!)).toMatchObject({ state: 'thinking' });
      state = 'awake';
      const second = await stream.waitFor('state', 2, 1_500);
      expect(statusData(second[1]!)).toMatchObject({ state: 'awake' });
      expect(stream.frames('model')).toHaveLength(0);
    } finally {
      await stream.close();
    }
  });

  it('shows unavailable when the status never answers within its bound', async () => {
    const poller = new ModelStatusPoller({
      url: GATEWAY_STATUS_URL,
      pollMs: 50,
      timeoutMs: 100,
      fetch: vi.fn(() => new Promise<Response>(() => undefined)),
    });
    const server = createServer({ modelStatus: poller });
    const stream = await openStream(server);
    try {
      const frames = await stream.waitFor('model', 1, 2_000);
      expect(statusData(frames[0]!)).toBeNull();
      expect(stream.text()).not.toContain('outageSince');
    } finally {
      await stream.close();
    }
  });

  it('polls once per period however many clients watch, and only while one does', async () => {
    const calls: number[] = [];
    const poller = new ModelStatusPoller({
      url: GATEWAY_STATUS_URL,
      pollMs: 300,
      timeoutMs: 100,
      fetch: vi.fn(async () => {
        calls.push(Date.now());
        return new Response(JSON.stringify({ state: 'ok' }), { status: 200 });
      }),
    });
    const server = createServer({ modelStatus: poller });
    const streams: OpenStream[] = [];
    expect(calls.length).toBe(0);
    try {
      streams.push(await openStream(server), await openStream(server), await openStream(server));
      // The first fetch starts the one shared poll; measure what three clients
      // cost over three periods: one poll each, never one per client.
      const deadline = Date.now() + 2_000;
      while (calls.length < 1 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const baseline = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 950));
      const observed = calls.length - baseline;
      expect(observed).toBeGreaterThanOrEqual(2);
      expect(observed).toBeLessThanOrEqual(4);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
    const afterClose = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls.length).toBe(afterClose);
  });

  it('leaves the resume cursor on the last message when a model frame arrives', async () => {
    const row: TranscriptRow = {
      sequence: '7',
      role: 'assistant',
      text: 'hello',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const watchedAfter: string[] = [];
    const source = stubModelStatus(null);
    const server = createServer({ modelStatus: source, message: row, watchedAfter });
    const stream = await openStream(server);
    let cursor: string | null;
    try {
      await stream.waitFor('message', 1);
      source.set({ state: 'ok', outageSince: null, lastErrorCode: null });
      const modelFrames = await stream.waitFor('model', 1);
      // A model event is not a transcript row: the browser must not resume past it.
      expect(modelFrames[0]).not.toMatch(/^id:/m);
      cursor = resumeCursor(stream.text());
      expect(cursor).toBe('7');
    } finally {
      await stream.close();
    }
    // The cursor a reconnecting browser sends asks for what follows row 7.
    watchedAfter.length = 0;
    const resumed = await openStream(server, { 'last-event-id': cursor });
    try {
      await resumed.waitFor('state', 1);
    } finally {
      await resumed.close();
    }
    expect(watchedAfter).toEqual(['7']);
  });

  it('stays quiet about a source that has not answered yet', async () => {
    const server = createServer({ modelStatus: silentModelStatus() });
    const stream = await openStream(server);
    try {
      await stream.waitFor('state', 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(stream.frames('model')).toHaveLength(0);
    } finally {
      await stream.close();
    }
  });
});
