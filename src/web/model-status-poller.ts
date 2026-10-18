/**
 * The one bounded poll of the gateway's `/status` shared by every client of
 * this web module (ADR-013 D6).
 *
 * The poll keeps its own timer and caches its last answer, so a slow or
 * hanging gateway never delays the event stream that reads the cache. A fetch
 * that fails, answers something other than a 200, or answers nothing within
 * the bound is "unavailable" (`read()` is `null`) — never an outage. Every
 * response it does not consume is cancelled.
 *
 * The answer and the attempt's clock outlive a period with no readers: a
 * browser that reconnects inside the period reuses the answer and waits out
 * the rest of the period, and an attempt already in flight answers the reader
 * that reconnected during it.
 *
 * Exactly one scheduler owns the next tick. A reconnect clears the timer the
 * previous run armed, and a tick that resumes after a stop and a restart arms
 * nothing, so a reconnect inside an in-flight fetch cannot leave a second
 * polling chain behind.
 */
import type { ModelStatusEvent } from './contract.js';
import {
  MODEL_STATUS_POLL_MS,
  MODEL_STATUS_TIMEOUT_MS,
  parseModelStatus,
  type ModelStatusSource,
} from './model-status.js';

/** The most a status body may be; a larger answer is not a status. */
export const MODEL_STATUS_MAX_BODY_BYTES = 4 * 1024;

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
  private running = false;
  /** Bumped by each start, so a tick from an earlier run cannot re-arm. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt: Promise<void> | undefined;
  private current: ModelStatusEvent | null = null;
  private answered = false;
  private lastAttemptAt = 0;

  constructor(options: ModelStatusPollerOptions) {
    if (!options.url) throw new Error('a model status URL is required');
    this.url = options.url;
    this.pollMs = options.pollMs ?? MODEL_STATUS_POLL_MS;
    this.timeoutMs = options.timeoutMs ?? MODEL_STATUS_TIMEOUT_MS;
    this.fetchStatus = options.fetch ?? fetch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    const delay = this.untilNextAttempt();
    if (delay === 0) void this.tick(this.generation);
    else this.arm(delay);
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  read(): ModelStatusEvent | null {
    return this.current;
  }

  settled(): boolean {
    return this.answered;
  }

  /** Milliseconds left of the period the last attempt belongs to. */
  private untilNextAttempt(): number {
    if (this.lastAttemptAt === 0) return 0;
    return Math.max(0, this.lastAttemptAt + this.pollMs - Date.now());
  }

  /**
   * Arm the next tick. A single scheduler owns it: the timer already armed is
   * cleared first, so an arm can never leave a second chain behind.
   */
  private arm(delay: number): void {
    this.clearTimer();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick(generation);
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * One period: attempt, then arm the next one; a stop ends the chain. A tick
   * that resumes after a stop and a restart belongs to the run that ended, so
   * it arms nothing — the run that replaced it already owns the next tick.
   */
  private async tick(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    await this.poll();
    if (!this.running || generation !== this.generation) return;
    this.arm(this.untilNextAttempt());
  }

  /** The attempt this period shares; a period never starts a second one. */
  private poll(): Promise<void> {
    const started =
      this.attempt ??
      this.attemptOnce().finally(() => {
        this.attempt = undefined;
      });
    this.attempt = started;
    return started;
  }

  private async attemptOnce(): Promise<void> {
    this.lastAttemptAt = Date.now();
    const status = await this.fetchOnce();
    // The answer belongs to the module, not to one period: a reader that
    // reconnects while this attempt is in flight adopts it.
    this.current = status;
    this.answered = true;
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
    let response: Response | null = null;
    let reading = false;
    try {
      const answer = await Promise.race([
        this.fetchStatus(this.url, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null),
        expired,
      ]);
      if (answer === 'expired' || answer === null) return null;
      response = answer;
      // Exactly one answer is a status body; another 2xx is not one.
      if (response.status !== 200) return null;
      reading = true;
      const body = await Promise.race([
        readBoundedBody(response, MODEL_STATUS_MAX_BODY_BYTES, controller.signal),
        expired,
      ]);
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
      // The body reader owns the cancel once it holds the stream; every other
      // path aborts the request and cancels what it did not consume.
      if (response !== null && !reading) {
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
      }
    }
  }
}

/**
 * The status body up to `limit` bytes; `null` when it overflows, ends empty or
 * cannot be read. The reader is cancelled on every path that does not consume
 * it, including an abort while a read is pending.
 */
async function readBoundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<string | null> {
  const body = response.body;
  if (body === null) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  let text = '';
  let ended = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        ended = true;
        break;
      }
      size += part.value.byteLength;
      if (size > limit) return null;
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!ended) await reader.cancel().catch(() => undefined);
  }
}
