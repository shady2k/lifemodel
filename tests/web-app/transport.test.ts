import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpTransport } from '../../web/app/src/transport';

class FakeEventSource extends EventTarget {
  static latest?: FakeEventSource;
  url: string;
  closed = false;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.latest = this;
  }
  close() {
    this.closed = true;
  }
  message(data: unknown, id: string) {
    const event = new MessageEvent('message', { data: JSON.stringify(data), lastEventId: id });
    this.dispatchEvent(event);
  }
  state(data: unknown) {
    this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(data) }));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('web transport contract', () => {
  it('reads pages with the ADR cursor and the fixed page limit', async () => {
    const page = { messages: [], cursor: '91' };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => page });
    vi.stubGlobal('fetch', fetch);
    expect(await httpTransport.readTranscript('42')).toEqual(page);
    expect(fetch).toHaveBeenCalledWith('/api/transcript?limit=50&before=42', { cache: 'no-store' });
  });

  it('subscribes after the page cursor and separates message ids from state data', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onMessage = vi.fn();
    const onState = vi.fn();
    const close = httpTransport.subscribe('91', onMessage, onState);
    const row = {
      sequence: '92',
      role: 'assistant',
      text: 'hello',
      createdAt: '2026-10-15T12:00:00Z',
    };
    const state = { state: 'thinking', epoch: 'e1', publishedAt: '2026-10-15T12:00:01Z' };
    const source = FakeEventSource.latest;
    expect(source?.url).toBe('/api/events?after=91');
    source?.message(row, '92');
    source?.state(state);
    expect(onMessage).toHaveBeenCalledWith(row);
    expect(onState).toHaveBeenCalledWith(state);
    close();
    expect(source?.closed).toBe(true);
  });
});
