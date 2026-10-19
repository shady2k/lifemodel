export type {
  TranscriptMessage,
  TranscriptPage,
  CreatureStateEvent,
  ModelStatusEvent,
} from '../../../src/web/contract.js';
import type {
  TranscriptMessage,
  TranscriptPage,
  CreatureStateEvent,
  ModelStatusEvent,
  MessageInput,
} from '../../../src/web/contract.js';
import { parseModelStatus } from '../../../src/web/model-status.js';

export function parseCreatureStateEvent(value: unknown): CreatureStateEvent | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Creature state has an invalid shape');
  const state = value as Partial<CreatureStateEvent>;
  if (
    (state.state !== 'thinking' && state.state !== 'awake' && state.state !== 'asleep') ||
    typeof state.epoch !== 'string' ||
    typeof state.publishedAt !== 'string' ||
    Number.isNaN(Date.parse(state.publishedAt))
  )
    throw new Error('Creature state has an invalid shape');
  return state as CreatureStateEvent;
}

export function parseTranscriptMessage(value: unknown): TranscriptMessage {
  if (!value || typeof value !== 'object')
    throw new Error('Transcript message has an invalid shape');
  const message = value as Partial<TranscriptMessage>;
  if (
    typeof message.sequence !== 'string' ||
    typeof message.text !== 'string' ||
    (message.role !== 'user' && message.role !== 'assistant') ||
    typeof message.createdAt !== 'string'
  )
    throw new Error('Transcript message has an invalid shape');
  return message as TranscriptMessage;
}

/**
 * A model status frame. Anything the browser cannot read — a malformed frame,
 * a status without its safe fields — is "status unavailable", never an outage
 * (ADR-013 D6).
 */
export function parseModelStatusFrame(data: string): ModelStatusEvent | null {
  try {
    return parseModelStatus(JSON.parse(data) as unknown);
  } catch {
    return null;
  }
}

export type SendResult = 'accepted' | 'conflict' | 'stale';

/**
 * A read proved the owner's session is gone: the loader's ForwardAuth answers
 * a GET without a session with a redirect to its login page, and a request
 * that is not a GET with a 401 (ADR-011 D6).
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('The owner session has ended');
    this.name = 'SessionExpiredError';
  }
}

const sessionExpiredListeners = new Set<() => void>();

function reportSessionExpired(): void {
  for (const listener of [...sessionExpiredListeners]) listener();
}

/**
 * A redirect the read was told not to follow (the browser reports it as an
 * `opaqueredirect`, another fetch implementation as the 3xx itself), or a 401,
 * is an ended session. A 5xx or a network failure is a module that is
 * unavailable, which the page keeps retrying in silence.
 */
function isSessionExpired(response: { type: string; status: number }): boolean {
  return (
    response.type === 'opaqueredirect' ||
    response.status === 401 ||
    (response.status >= 300 && response.status < 400)
  );
}

async function readTranscriptPage(
  before: string | undefined,
  after: string | undefined
): Promise<TranscriptPage> {
  const query = new URLSearchParams({ limit: String(CATCH_UP_PAGE_SIZE) });
  if (before !== undefined) query.set('before', before);
  if (after !== undefined) query.set('after', after);
  const response = await fetch(`/api/transcript?${query.toString()}`, {
    cache: 'no-store',
    // The login redirect is the page's own business: it leaves with its draft
    // saved, and a login page must never be read as a transcript.
    redirect: 'manual',
  });
  if (isSessionExpired(response)) {
    reportSessionExpired();
    throw new SessionExpiredError();
  }
  if (!response.ok) throw new Error(`Transcript request failed (${String(response.status)})`);
  const page = (await response.json()) as TranscriptPage;
  if (!Array.isArray(page.messages) || !(page.cursor === null || typeof page.cursor === 'string'))
    throw new Error('Transcript response has an invalid shape');
  return page;
}

/** Rows read per catch-up page; the server's page limit is 50. */
const CATCH_UP_PAGE_SIZE = 50;
const CATCH_UP_PAGES = 10;
/** The first retry waits this long; each further failure doubles it, up to the cap. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15_000;
/** A stream open at least this long proves the server admits streams, so retries start over. */
const HEALTHY_STREAM_MS = 1_000;

export interface WebTransport {
  sendMessage(input: MessageInput): Promise<SendResult>;
  readTranscript(before?: string, after?: string): Promise<TranscriptPage>;
  /**
   * Registers what the page does when a read proves the owner's session has
   * ended (ADR-011 D6): the transport stops retrying and the page leaves for
   * the loader's login, which brings it back to where it was. Returns the way
   * to unregister.
   */
  onSessionExpired(listener: () => void): () => void;
  subscribe(
    after: string | null,
    onMessage: (message: TranscriptMessage) => void,
    onState: (state: CreatureStateEvent | null) => void,
    onModelStatus: (status: ModelStatusEvent | null) => void
  ): () => void;
}

export const httpTransport: WebTransport = {
  async sendMessage(input) {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (response.status === 202) return 'accepted';
    if (response.status === 409) {
      const body = (await response.json()) as { reason?: string };
      if (body.reason === 'stale') return 'stale';
      if (body.reason === 'conflict') return 'conflict';
      throw new Error('Message conflict response has no valid reason');
    }
    throw new Error(`Message request failed (${String(response.status)})`);
  },
  async readTranscript(before, after) {
    return await readTranscriptPage(before, after);
  },
  onSessionExpired(listener) {
    sessionExpiredListeners.add(listener);
    return () => {
      sessionExpiredListeners.delete(listener);
    };
  },

  /**
   * The page's live stream (ADR-011 D6), with its own recovery. The browser's
   * `EventSource` gives up for good on any non-200 answer — a refused
   * subscription (429 too many streams), an unavailable module (503) or a
   * gateway error page — so one refusal would leave an open page without new
   * rows until a reload. This subscription therefore owns both reconnection
   * and catch-up:
   *
   * - every failure resubscribes after a bounded, jittered delay, resuming
   *   from the last sequence the page has, so the ended or refused stream is
   *   replaced and no row is asked for twice;
   * - before each attempt the transcript is read from that same sequence, so a
   *   reply committed while no stream was open appears even if the stream is
   *   refused again;
   * - a row at or below the last delivered sequence is dropped, so a catch-up
   *   page and the stream never render the same reply twice.
   */
  subscribe(after, onMessage, onState, onModelStatus) {
    let closed = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let openedAt = 0;
    let failures = 0;
    let delivered = after;

    const isNew = (sequence: string) => delivered === null || BigInt(sequence) > BigInt(delivered);

    const deliver = (message: TranscriptMessage) => {
      if (closed || !isNew(message.sequence)) return;
      delivered = message.sequence;
      onMessage(message);
    };

    const catchUp = async () => {
      for (let page = 0; page < CATCH_UP_PAGES; page += 1) {
        // Always an explicit ascending cursor: a page read without a cursor is
        // the store's latest page, newest first, which would deliver the newest
        // row alone and skip every row older than it. A null cursor is an empty
        // history, so it reads from the start of the transcript.
        const read = await readTranscriptPage(undefined, delivered ?? '0');
        for (const message of read.messages) deliver(message);
        if (closed || read.messages.length < CATCH_UP_PAGE_SIZE) return;
      }
    };

    const scheduleRetry = () => {
      const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 6));
      // Half the delay is jitter, so tabs reconnecting together spread out.
      const delay = step / 2 + Math.random() * (step / 2);
      failures += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void attempt();
      }, delay);
    };

    const open = () => {
      const query = new URLSearchParams();
      if (delivered !== null) query.set('after', delivered);
      const current = new EventSource(`/api/events?${query.toString()}`);
      source = current;
      openedAt = 0;
      current.addEventListener('open', () => {
        openedAt = Date.now();
      });
      current.addEventListener('message', (event) => {
        deliver(parseTranscriptMessage(JSON.parse((event as MessageEvent<string>).data)));
      });
      current.addEventListener('state', (event) => {
        onState(parseCreatureStateEvent(JSON.parse((event as MessageEvent<string>).data)));
      });
      current.addEventListener('model', (event) => {
        onModelStatus(parseModelStatusFrame((event as MessageEvent<string>).data));
      });
      current.addEventListener('error', () => {
        if (closed || source !== current) return;
        current.close();
        source = undefined;
        if (openedAt > 0 && Date.now() - openedAt >= HEALTHY_STREAM_MS) failures = 0;
        scheduleRetry();
      });
    };

    const attempt = async () => {
      if (closed) return;
      try {
        await catchUp();
      } catch (error) {
        // An ended session is not a failed stream to retry: the page is
        // already leaving for the login, and a retry would meet the same
        // redirect.
        if (error instanceof SessionExpiredError) return;
      }
      if (closed) return;
      open();
    };

    void attempt();

    return () => {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      source?.close();
      source = undefined;
    };
  },
};

export function mergeTranscript(
  messages: TranscriptMessage[],
  incoming: TranscriptMessage
): TranscriptMessage[] {
  const sequenceMatch = messages.find((message) => message.sequence === incoming.sequence);
  const clientMatch = incoming.clientId
    ? messages.find((message) => message.clientId === incoming.clientId)
    : undefined;
  const existing = clientMatch ?? sequenceMatch;
  const retained = messages.filter(
    (message) =>
      message.sequence !== incoming.sequence &&
      (!incoming.clientId || message.clientId !== incoming.clientId)
  );
  retained.push(existing ? { ...existing, ...incoming } : incoming);
  const seenClients = new Set<string>();
  return retained
    .filter((message) => {
      if (!message.clientId) return true;
      if (seenClients.has(message.clientId)) return false;
      seenClients.add(message.clientId);
      return true;
    })
    .sort((left, right) => {
      const a = BigInt(left.sequence);
      const b = BigInt(right.sequence);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}
