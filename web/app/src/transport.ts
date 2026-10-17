export type {
  TranscriptMessage,
  TranscriptPage,
  CreatureStateEvent,
} from '../../../src/web/contract.js';
import type {
  TranscriptMessage,
  TranscriptPage,
  CreatureStateEvent,
  MessageInput,
} from '../../../src/web/contract.js';

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

export type SendResult = 'accepted' | 'conflict' | 'stale';

export interface WebTransport {
  sendMessage(input: MessageInput): Promise<SendResult>;
  readTranscript(before?: string, after?: string): Promise<TranscriptPage>;
  subscribe(
    after: string | null,
    onMessage: (message: TranscriptMessage) => void,
    onState: (state: CreatureStateEvent) => void
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
    const query = new URLSearchParams({ limit: '50' });
    if (before !== undefined) query.set('before', before);
    if (after !== undefined) query.set('after', after);
    const response = await fetch(`/api/transcript?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Transcript request failed (${String(response.status)})`);
    const page = (await response.json()) as TranscriptPage;
    if (!Array.isArray(page.messages) || !(page.cursor === null || typeof page.cursor === 'string'))
      throw new Error('Transcript response has an invalid shape');
    return page;
  },

  subscribe(after, onMessage, onState) {
    const query = new URLSearchParams();
    if (after !== null) query.set('after', after);
    const source = new EventSource(`/api/events?${query.toString()}`);
    source.addEventListener('message', (event) => {
      const message = parseTranscriptMessage(JSON.parse((event as MessageEvent<string>).data));
      onMessage(message);
    });
    source.addEventListener('state', (event) => {
      const state = JSON.parse((event as MessageEvent<string>).data) as CreatureStateEvent;
      onState(state);
    });
    return () => {
      source.close();
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
