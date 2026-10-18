/**
 * The one bounded poll of the gateway's `/status` shared by every client of
 * this web module (ADR-013 D6).
 *
 * The poll keeps its own timer and caches its last answer, so a slow or
 * hanging gateway never delays the event stream that reads the cache. A fetch
 * that fails, or answers nothing within the bound, is "unavailable"
 * (`read()` is `null`) — never an outage.
 */
import type { ModelStatusEvent } from './contract.js';
import {
  MODEL_STATUS_POLL_MS,
  MODEL_STATUS_TIMEOUT_MS,
  parseModelStatus,
  type ModelStatusSource,
} from './model-status.js';

export interface ModelStatusPollerOptions {
  url: string;
  pollMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ModelStatusPoller implements ModelStatusSource {
  private readonly url: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly fetchStatus: typeof fetch;
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private inFlight = false;
  private current: ModelStatusEvent | null = null;
  private answered = false;

  constructor(options: ModelStatusPollerOptions) {
    if (!options.url) throw new Error('a model status URL is required');
    this.url = options.url;
    this.pollMs = options.pollMs ?? MODEL_STATUS_POLL_MS;
    this.timeoutMs = options.timeoutMs ?? MODEL_STATUS_TIMEOUT_MS;
    this.fetchStatus = options.fetch ?? fetch;
  }

  start(): void {
    if (this.timer !== undefined) return;
    const generation = (this.generation += 1);
    this.timer = setInterval(() => {
      void this.poll(generation);
    }, this.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.poll(generation);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.generation += 1;
    this.current = null;
    this.answered = false;
  }

  read(): ModelStatusEvent | null {
    return this.current;
  }

  settled(): boolean {
    return this.answered;
  }

  private async poll(generation: number): Promise<void> {
    if (this.inFlight || generation !== this.generation) return;
    this.inFlight = true;
    try {
      const status = await this.fetchOnce();
      if (generation !== this.generation) return;
      this.current = status;
      this.answered = true;
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchOnce(): Promise<ModelStatusEvent | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('expired');
      }, this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const response = await Promise.race([
        this.fetchStatus(this.url, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null),
        expired,
      ]);
      if (response === 'expired' || response?.ok !== true) return null;
      const body = await Promise.race([response.text().catch(() => null), expired]);
      if (body === 'expired' || body === null) return null;
      try {
        return parseModelStatus(JSON.parse(body));
      } catch {
        return null;
      }
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
