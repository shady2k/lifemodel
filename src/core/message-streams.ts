import type { Redis } from 'iovalkey';
import type { Signal } from '../types/signal.js';
import type { SnapshotSectionOwner } from '../storage/snapshot-store.js';

export const INBOUND_STREAM = 'inbound';
export const OUTBOUND_STREAM = 'outbound';
const DEFAULT_DEDUP_LIMIT = 1_000;

export interface InboundMessage {
  streamId: string;
  messageId: string;
  recipientId: string;
  signal: Signal;
}

interface InboundSnapshot {
  version: 1;
  readOffset: string;
  recipientOffsets: Record<string, string>;
  recentMessageIds: string[];
  pending: InboundMessage[];
}

const emptySnapshot = (): InboundSnapshot => ({
  version: 1,
  readOffset: '0-0',
  recipientOffsets: {},
  recentMessageIds: [],
  pending: [],
});

/** Durable inbound stream reader and snapshot-owned offsets/dedup state. */
export class InboundMessageStream implements SnapshotSectionOwner<InboundSnapshot> {
  readonly section = 'inbound';
  private snapshot = emptySnapshot();
  private readonly queuedIds = new Set<string>();

  constructor(
    private readonly redis: Redis,
    private readonly streamKey = INBOUND_STREAM,
    private readonly dedupLimit = DEFAULT_DEDUP_LIMIT
  ) {
    if (!Number.isInteger(dedupLimit) || dedupLimit < 1)
      throw new Error('dedupLimit must be positive');
  }

  async append(signal: Signal): Promise<string> {
    if (signal.type !== 'user_message') throw new Error('Only user_message signals enter inbound');
    const data = signal.data as { recipientId?: unknown; updateId?: unknown; text?: unknown };
    if (typeof data.recipientId !== 'string' || !data.recipientId)
      throw new Error('Inbound message requires recipientId');
    const messageId =
      typeof data.updateId === 'string' && data.updateId ? data.updateId : signal.id;
    return this.redis.xadd(
      this.streamKey,
      '*',
      'type',
      'inbound.message',
      'messageId',
      messageId,
      'recipientId',
      data.recipientId,
      'text',
      typeof data.text === 'string' ? data.text : '',
      'timestamp',
      signal.timestamp.toISOString(),
      'signal',
      JSON.stringify(signal)
    );
  }

  async readNew(): Promise<InboundMessage[]> {
    const rows = await this.redis.xrange(this.streamKey, `(${this.snapshot.readOffset}`, '+');
    const known = new Set([
      ...this.snapshot.recentMessageIds,
      ...this.snapshot.pending.map((message) => message.messageId),
    ]);
    for (const [streamId, fields] of rows) {
      const values = this.fields(fields);
      this.snapshot.readOffset = streamId;
      if (values.type !== 'inbound.message')
        throw new Error(`Unexpected inbound event type: ${values.type ?? 'missing'}`);
      const messageId = values.messageId;
      const recipientId = values.recipientId;
      if (!messageId || !recipientId || !values.signal)
        throw new Error(`Malformed inbound message at ${streamId}`);
      if (known.has(messageId)) continue;
      const signal = JSON.parse(values.signal) as Signal;
      if (signal.type !== 'user_message')
        throw new Error(`Inbound stream payload at ${streamId} is not a user_message`);
      this.snapshot.pending.push({ streamId, messageId, recipientId, signal });
      known.add(messageId);
    }
    return this.takeUndelivered();
  }

  /** Replay every unsettled entry at startup, then only newly discovered entries. */
  private takeUndelivered(): InboundMessage[] {
    const result = this.snapshot.pending.filter((item) => !this.queuedIds.has(item.signal.id));
    for (const item of result) this.queuedIds.add(item.signal.id);
    return result;
  }

  settle(signalIds: string[]): void {
    const settled = new Set(signalIds);
    const remains: InboundMessage[] = [];
    for (const message of this.snapshot.pending) {
      if (!settled.has(message.signal.id)) {
        remains.push(message);
        continue;
      }
      this.snapshot.recipientOffsets[message.recipientId] = message.streamId;
      this.snapshot.recentMessageIds.push(message.messageId);
      this.queuedIds.delete(message.signal.id);
    }
    this.snapshot.pending = remains;
    this.snapshot.recentMessageIds = this.snapshot.recentMessageIds.slice(-this.dedupLimit);
  }

  exportSnapshot(): InboundSnapshot {
    return structuredClone(this.snapshot);
  }

  hydrateSnapshot(value: InboundSnapshot | undefined): void {
    if (value === undefined) {
      this.snapshot = emptySnapshot();
      this.queuedIds.clear();
      return;
    }
    if (
      value.version !== 1 ||
      typeof value.readOffset !== 'string' ||
      !Array.isArray(value.pending) ||
      !Array.isArray(value.recentMessageIds) ||
      typeof value.recipientOffsets !== 'object'
    ) {
      throw new Error('Invalid inbound snapshot section');
    }
    this.snapshot = structuredClone(value);
    this.queuedIds.clear();
  }

  private fields(fields: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) result[key] = value;
    }
    return result;
  }
}
