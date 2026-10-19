import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpTransport, type TranscriptPage } from '../../web/app/src/transport';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.dispatchEvent(new Event('open'));
  }
  /** A refused subscription: the browser fails the connection and never retries. */
  refuse() {
    this.dispatchEvent(new Event('error'));
  }
  message(data: unknown, id: string) {
    const event = new MessageEvent('message', { data: JSON.stringify(data), lastEventId: id });
    this.dispatchEvent(event);
  }
  state(data: unknown) {
    this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(data) }));
  }
}

const row = (sequence: string, text: string) => ({
  sequence,
  role: 'assistant' as const,
  text,
  createdAt: '2026-10-15T12:00:00Z',
});

function stubFetch(pages: TranscriptPage[]) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return { ok: true, json: async () => pages.shift() ?? { messages: [], cursor: null } };
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

const flush = async () => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeEventSource.instances = [];
});

describe('web transport contract', () => {
  it('reads pages with the ADR cursor and the fixed page limit', async () => {
    const page = { messages: [], cursor: '91' };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => page });
    vi.stubGlobal('fetch', fetch);
    expect(await httpTransport.readTranscript('42')).toEqual(page);
    expect(fetch).toHaveBeenCalledWith('/api/transcript?limit=50&before=42', { cache: 'no-store' });
  });

  it('subscribes after the page cursor and separates message ids from state data', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetch([]);
    const onMessage = vi.fn();
    const onState = vi.fn();
    const close = httpTransport.subscribe('91', onMessage, onState, () => undefined);
    await flush();
    const source = FakeEventSource.instances.at(-1);
    expect(source?.url).toBe('/api/events?after=91');
    const state = { state: 'thinking', epoch: 'e1', publishedAt: '2026-10-15T12:00:01Z' };
    source?.message(row('92', 'hello'), '92');
    source?.state(state);
    expect(onMessage).toHaveBeenCalledWith(row('92', 'hello'));
    expect(onState).toHaveBeenCalledWith(state);
    close();
    expect(source?.closed).toBe(true);
  });

  it('recovers from a refused stream and shows the reply committed while it was down', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const calls = stubFetch([
      { messages: [], cursor: '7' },
      { messages: [row('8', 'the reply')], cursor: '8' },
    ]);
    const onMessage = vi.fn();
    const close = httpTransport.subscribe(
      '7',
      onMessage,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    // The first stream is refused, as a 429 answer is: the transport retries itself.
    FakeEventSource.instances[0]?.refuse();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(onMessage).toHaveBeenCalledWith(row('8', 'the reply'));
    expect(FakeEventSource.instances).toHaveLength(2);
    // The new subscription resumes from the row the page now has.
    expect(FakeEventSource.instances[1]?.url).toBe('/api/events?after=8');
    // The catch-up read asked from the last sequence the page had, not from zero.
    expect(calls).toEqual(['/api/transcript?limit=50&after=7', '/api/transcript?limit=50&after=7']);
    close();
  });

  it('delivers each row once when the stream repeats a catch-up row', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    stubFetch([
      { messages: [], cursor: '1' },
      { messages: [row('2', 'the reply')], cursor: '2' },
    ]);
    const onMessage = vi.fn();
    const close = httpTransport.subscribe(
      '1',
      onMessage,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    FakeEventSource.instances[0]?.refuse();
    await vi.advanceTimersByTimeAsync(500);
    const resumed = FakeEventSource.instances[1];
    resumed?.message(row('2', 'the reply'), '2');
    resumed?.message(row('3', 'later'), '3');
    expect(onMessage.mock.calls.map(([message]) => message.sequence)).toEqual(['2', '3']);
    close();
  });

  it('keeps the retry wait bounded and growing while a server stays unavailable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    stubFetch([]);
    const close = httpTransport.subscribe(
      '1',
      () => undefined,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    FakeEventSource.instances[0]?.refuse();
    for (let round = 0; round < 40; round += 1) {
      await vi.advanceTimersByTimeAsync(3_000);
      FakeEventSource.instances.at(-1)?.refuse();
    }
    // Two minutes of refusals: a bounded number of attempts, never a hot loop.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeEventSource.instances.length).toBeGreaterThan(3);
    expect(FakeEventSource.instances.length).toBeLessThan(120);
    close();
  });

  it('stops retrying when the page unsubscribes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    stubFetch([]);
    const close = httpTransport.subscribe(
      '1',
      () => undefined,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    FakeEventSource.instances[0]?.refuse();
    close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
