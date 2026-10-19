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

/** Response-like stand-ins for the catch-up read, most useful for its failures. */
function stubFetchResponses(responses: Array<{ type?: string; status?: number }>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses.shift() ?? { type: 'basic', status: 200 };
    return {
      type: next.type ?? 'basic',
      status: next.status ?? 200,
      ok: (next.status ?? 200) === 200,
      json: async () => ({ messages: [], cursor: null }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

/** The loader's ForwardAuth answer to a GET without a session: a login redirect. */
const LOGIN_REDIRECT = { type: 'opaqueredirect', status: 0 };

function stubFetch(pages: TranscriptPage[]) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return {
      type: 'basic',
      status: 200,
      ok: true,
      json: async () => pages.shift() ?? { messages: [], cursor: null },
    };
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
    const fetch = vi
      .fn()
      .mockResolvedValue({ type: 'basic', status: 200, ok: true, json: async () => page });
    vi.stubGlobal('fetch', fetch);
    expect(await httpTransport.readTranscript('42')).toEqual(page);
    expect(fetch).toHaveBeenCalledWith('/api/transcript?limit=50&before=42', {
      cache: 'no-store',
      redirect: 'manual',
    });
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

  it('catches up from the start of the transcript when the page had no rows', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const calls = stubFetch([{ messages: [row('2', 'the question')], cursor: '2' }]);
    const onMessage = vi.fn();
    const close = httpTransport.subscribe(
      null,
      onMessage,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    // An empty page has no cursor: the catch-up reads the transcript ascending
    // from its start, never the store's newest-first latest page.
    expect(calls).toEqual(['/api/transcript?limit=50&after=0']);
    expect(onMessage).toHaveBeenCalledWith(row('2', 'the question'));
    // The row the catch-up read is the resume cursor of the stream that follows.
    expect(FakeEventSource.instances[0]?.url).toBe('/api/events?after=2');
    close();
  });

  it('doubles the retry wait to a 15 s cap, with half of it as jitter', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    stubFetch([]);
    const close = httpTransport.subscribe(
      '1',
      () => undefined,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    // Half of each step is fixed and half is jitter: with random at 0.5 the
    // wait is three quarters of the step.
    for (const step of [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]) {
      const before = FakeEventSource.instances.length;
      FakeEventSource.instances.at(-1)?.refuse();
      const wait = (step * 3) / 4;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(FakeEventSource.instances).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.instances).toHaveLength(before + 1);
    }
    close();
  });

  it('uses the whole step as the jitter range', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    stubFetch([]);
    const close = httpTransport.subscribe(
      '1',
      () => undefined,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    FakeEventSource.instances.at(-1)?.refuse();
    // Just under the whole 500 ms step, and past its half.
    await vi.advanceTimersByTimeAsync(498);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeEventSource.instances).toHaveLength(2);
    close();
  });

  it('keeps the grown wait when a stream fails immediately after opening', async () => {
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
    for (const step of [500, 1_000, 2_000]) {
      FakeEventSource.instances.at(-1)?.refuse();
      await vi.advanceTimersByTimeAsync(step / 2);
    }
    // The fourth stream opens and fails inside the healthy interval: a flapping
    // server must not fall back to the base rate. Three failures put the step
    // at 4 s, so this retry waits its half of the step, 2 s.
    const fourth = FakeEventSource.instances.at(-1);
    expect(FakeEventSource.instances).toHaveLength(4);
    fourth?.open();
    await vi.advanceTimersByTimeAsync(10);
    fourth?.refuse();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeEventSource.instances).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(5);
    close();
  });

  it('starts the retry wait over after a stream stayed healthy', async () => {
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
    for (const step of [500, 1_000, 2_000]) {
      FakeEventSource.instances.at(-1)?.refuse();
      await vi.advanceTimersByTimeAsync(step / 2);
    }
    const healthy = FakeEventSource.instances.at(-1);
    expect(FakeEventSource.instances).toHaveLength(4);
    healthy?.open();
    // A stream that stayed open past the healthy interval proves the server
    // admits streams again, so the grown wait starts over at its base.
    await vi.advanceTimersByTimeAsync(1_000);
    healthy?.refuse();
    await vi.advanceTimersByTimeAsync(249);
    expect(FakeEventSource.instances).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(5);
    close();
  });

  it('drops the pending retry the moment the page unsubscribes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    stubFetch([]);
    const onMessage = vi.fn();
    const close = httpTransport.subscribe(
      '1',
      onMessage,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    FakeEventSource.instances.at(-1)?.refuse();
    // The retry is scheduled, and nothing else in the page's transport is.
    expect(vi.getTimerCount()).toBe(1);
    close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('abandons an in-flight catch-up when the page unsubscribes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let answer!: (page: TranscriptPage) => void;
    const pending = new Promise<TranscriptPage>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => await pending }))
    );
    const onMessage = vi.fn();
    const close = httpTransport.subscribe(
      '1',
      onMessage,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(0);
    close();
    // The page has gone: the answer it was waiting for must not open a stream
    // or render a row.
    answer({ messages: [row('2', 'late')], cursor: '2' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('leaves for the login page when the catch-up read is redirected', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const calls = stubFetchResponses([LOGIN_REDIRECT]);
    const onSessionExpired = vi.fn();
    const unsubscribe = httpTransport.onSessionExpired(onSessionExpired);
    const onMessage = vi.fn();
    const close = httpTransport.subscribe(
      '1',
      onMessage,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    // The read is asked not to follow the redirect: the answer itself is the
    // news that the session is gone.
    expect(calls).toEqual(['/api/transcript?limit=50&after=1']);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    // Retrying would only meet the same redirect: the page is leaving.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onMessage).not.toHaveBeenCalled();
    unsubscribe();
    close();
  });

  it('treats a 401 answer to the catch-up read as an ended session', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    stubFetchResponses([{ status: 401 }]);
    const onSessionExpired = vi.fn();
    const unsubscribe = httpTransport.onSessionExpired(onSessionExpired);
    const close = httpTransport.subscribe(
      '1',
      () => undefined,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeEventSource.instances).toHaveLength(0);
    unsubscribe();
    close();
  });

  it('keeps retrying silently while the catch-up read fails with a server error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    stubFetchResponses([{ status: 503 }, { status: 503 }, { status: 502 }]);
    const onSessionExpired = vi.fn();
    const unsubscribe = httpTransport.onSessionExpired(onSessionExpired);
    const close = httpTransport.subscribe(
      '1',
      () => undefined,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]?.refuse();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]?.refuse();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeEventSource.instances).toHaveLength(3);
    // A module or a proxy that is down is not an ended session: no navigation.
    expect(onSessionExpired).not.toHaveBeenCalled();
    unsubscribe();
    close();
  });

  it('keeps retrying silently while the catch-up read cannot reach the module', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetch);
    const onSessionExpired = vi.fn();
    const unsubscribe = httpTransport.onSessionExpired(onSessionExpired);
    const close = httpTransport.subscribe(
      '1',
      () => undefined,
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]?.refuse();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(onSessionExpired).not.toHaveBeenCalled();
    unsubscribe();
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
