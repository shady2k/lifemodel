export interface TranscriptMessage {
  sequence: string;
  clientId?: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  replyTo?: { sequence: string; role: 'user' | 'assistant'; excerpt: string };
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  cursor: string;
}

export interface CreatureStateEvent {
  state: 'thinking' | 'awake' | 'asleep';
  epoch: string;
  publishedAt: string;
}

export type SendResult = 'accepted' | 'conflict' | 'stale';

export interface WebTransport {
  sendMessage(input: { id: string; text: string; replyTo?: string }): Promise<SendResult>;
  readTranscript(before?: string): Promise<TranscriptPage>;
  subscribe(
    after: string,
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
  async readTranscript(before) {
    const query = new URLSearchParams({ limit: '50' });
    if (before !== undefined) query.set('before', before);
    const response = await fetch(`/api/transcript?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Transcript request failed (${String(response.status)})`);
    return (await response.json()) as TranscriptPage;
  },

  subscribe(after, onMessage, onState) {
    const query = new URLSearchParams({ after });
    const source = new EventSource(`/api/events?${query.toString()}`);
    source.addEventListener('message', (event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as TranscriptMessage;
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
