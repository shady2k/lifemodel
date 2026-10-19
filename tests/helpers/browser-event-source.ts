import { vi } from 'vitest';

/**
 * A spec-faithful double of the browser's `EventSource` over a real server.
 *
 * It follows the HTML event-stream rules the page depends on: a non-200
 * answer fails the connection for good (no reconnect), while a stream that
 * ends or a network error is retried by the browser after its own delay with
 * the last event id. The transport's own reconnection must not need that
 * second behaviour, but the double has it so a test never passes because the
 * double was gentler than the browser.
 */

export interface SpecEventSourceState {
  url: string;
  /** Every instance created, in order: one per connection attempt. */
  attempts: number;
  lastStatus: number | null;
  closed: boolean;
}

const RETRY_MS = 3_000;

export class SpecEventSource extends EventTarget {
  static readonly instances: SpecEventSource[] = [];

  readonly url: string;
  readyState = 0;
  lastEventId = '';
  lastStatus: number | null = null;
  closed = false;
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string) {
    super();
    this.url = url;
    SpecEventSource.instances.push(this);
    void this.connect();
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.controller?.abort();
  }

  private async connect(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.readyState = 0;
    let response: Response;
    try {
      response = await fetch(this.url, {
        cache: 'no-store',
        signal: controller.signal,
        headers: this.lastEventId ? { 'Last-Event-ID': this.lastEventId } : {},
      });
    } catch {
      if (!this.closed) this.reestablish();
      return;
    }
    this.lastStatus = response.status;
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status !== 200 || !contentType.startsWith('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      // The HTML rules: a wrong status or type fails the connection for good.
      this.readyState = 2;
      this.dispatchEvent(new Event('error'));
      return;
    }
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
    const reader = response.body?.getReader();
    if (!reader) {
      this.reestablish();
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          this.dispatch(frame);
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (this.closed) return;
      this.reestablish();
      return;
    }
    if (!this.closed) this.reestablish();
  }

  /** The browser reconnects by itself after a network error or a closed stream. */
  private reestablish(): void {
    this.readyState = 0;
    this.dispatchEvent(new Event('error'));
    if (this.closed) return;
    this.retryTimer = setTimeout(() => {
      void this.connect();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  private dispatch(frame: string): void {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
      else if (line.startsWith('id: ')) this.lastEventId = line.slice(4);
    }
    if (!data) return;
    this.dispatchEvent(new MessageEvent(event, { data, lastEventId: this.lastEventId }));
  }
}

export interface InstalledBrowser {
  /** Every EventSource the page created, oldest first. */
  sources(): SpecEventSource[];
  restore(): void;
}

/** Installs the double and makes the page's relative requests reach `base`. */
export function installBrowserFetch(base: string): InstalledBrowser {
  const realFetch = globalThis.fetch;
  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(typeof input === 'string' ? input : String(input), base), init)
  );
  const original = globalThis.EventSource;
  SpecEventSource.instances.length = 0;
  vi.stubGlobal('fetch', fetchStub);
  vi.stubGlobal('EventSource', SpecEventSource);
  return {
    sources: () => SpecEventSource.instances,
    restore: () => {
      vi.stubGlobal('fetch', realFetch);
      vi.stubGlobal('EventSource', original);
      vi.unstubAllGlobals();
    },
  };
}

export async function waitUntil(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
