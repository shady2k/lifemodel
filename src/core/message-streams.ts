import type { Redis } from 'iovalkey';
import type { Signal } from '../types/signal.js';
import type { SnapshotOutboxEvent, SnapshotSectionOwner } from '../storage/snapshot-store.js';
import type { ConversationManager } from '../storage/conversation-manager.js';
import type { Channel, Logger } from '../types/index.js';

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

  messageIdForSignal(signal: Signal): string {
    const data = signal.data as { updateId?: unknown } | undefined;
    return typeof data?.updateId === 'string' && data.updateId ? data.updateId : signal.id;
  }

  async append(signal: Signal): Promise<string> {
    if (signal.type !== 'user_message') throw new Error('Only user_message signals enter inbound');
    const data = signal.data as { recipientId?: unknown; updateId?: unknown; text?: unknown };
    if (typeof data.recipientId !== 'string' || !data.recipientId)
      throw new Error('Inbound message requires recipientId');
    const messageId = this.messageIdForSignal(signal);
    const existing = this.snapshot.pending.find((entry) => entry.messageId === messageId);
    if (existing) {
      const previous = existing.signal.data as { pendingPhoto?: unknown };
      const next = signal.data as { pendingPhoto?: unknown };
      if (previous.pendingPhoto != null && next.pendingPhoto == null) {
        existing.signal = signal;
        return existing.streamId;
      }
    }
    const id = await this.redis.xadd(
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
    if (id === null) throw new Error('Valkey returned no inbound stream id');
    return id;
  }

  async readNew(includePhotoReceipts = false): Promise<InboundMessage[]> {
    const rows = await this.redis.xrange(this.streamKey, `(${this.snapshot.readOffset}`, '+');
    const known = new Set([
      ...this.snapshot.recentMessageIds,
      ...this.snapshot.pending.map((message) => message.messageId),
    ]);
    for (const [streamId, fields] of rows) {
      const values = this.fields(fields);
      this.snapshot.readOffset = streamId;
      if (values['type'] !== 'inbound.message')
        throw new Error(`Unexpected inbound event type: ${values['type'] ?? 'missing'}`);
      const messageId = values['messageId'];
      const recipientId = values['recipientId'];
      if (!messageId || !recipientId || !values['signal'])
        throw new Error(`Malformed inbound message at ${streamId}`);
      const signal = JSON.parse(values['signal']) as Signal;
      if (signal.type !== 'user_message')
        throw new Error(`Inbound stream payload at ${streamId} is not a user_message`);
      if (known.has(messageId)) {
        const pending = this.snapshot.pending.find((item) => item.messageId === messageId);
        const oldData = pending?.signal.data as { pendingPhoto?: unknown } | undefined;
        const newData = signal.data as { pendingPhoto?: unknown } | undefined;
        if (pending && oldData?.pendingPhoto != null && newData?.pendingPhoto == null) {
          pending.signal = signal;
        }
        continue;
      }
      this.snapshot.pending.push({ streamId, messageId, recipientId, signal });
      known.add(messageId);
    }
    return this.takeUndelivered(includePhotoReceipts);
  }

  /** Replay every unsettled entry at startup, then only newly discovered entries. */
  private takeUndelivered(includePhotoReceipts: boolean): InboundMessage[] {
    const result = this.snapshot.pending.filter((item) => {
      if (this.queuedIds.has(item.signal.id)) return false;
      const data = item.signal.data as { pendingPhoto?: unknown };
      return includePhotoReceipts || data.pendingPhoto == null;
    });
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

export interface OutboundMessagePayload extends Record<string, unknown> {
  recipientId: string;
  channel: string;
  destination: string;
  text: string;
  replyTo?: string;
}

/** Trim only the prefix both outbound consumers have durably passed.
 * MINID is inclusive, so the event at the slower cursor stays available. */
export async function trimOutboundEvents(
  redis: Redis,
  options: { streamKey?: string; postgresOffsetKey?: string; deliveryOffsetKey?: string } = {}
): Promise<void> {
  const streamKey = options.streamKey ?? OUTBOUND_STREAM;
  const postgresOffsetKey = options.postgresOffsetKey ?? 'outbound:pg-applied';
  const deliveryOffsetKey = options.deliveryOffsetKey ?? 'outbound:delivery-offset';
  const [postgresOffset, deliveryOffset] = await Promise.all([
    redis.get(postgresOffsetKey),
    redis.get(deliveryOffsetKey),
  ]);
  const minimum = minStreamId(postgresOffset ?? '0-0', deliveryOffset ?? '0-0');
  if (minimum !== '0-0') await redis.xtrim(streamKey, 'MINID', minimum);
}

function minStreamId(left: string, right: string): string {
  const [leftMillisText, leftSequenceText] = left.split('-');
  const [rightMillisText, rightSequenceText] = right.split('-');
  if (!leftMillisText || !leftSequenceText || !rightMillisText || !rightSequenceText) {
    throw new Error('Invalid outbound stream cursor');
  }
  const leftMillis = BigInt(leftMillisText);
  const rightMillis = BigInt(rightMillisText);
  if (leftMillis !== rightMillis) return leftMillis < rightMillis ? left : right;
  return BigInt(leftSequenceText) <= BigInt(rightSequenceText) ? left : right;
}

/** Apply committed outbound message rows in stream order. Replaying a row is safe
 * because eventId is its Postgres natural key. The offset advances only after
 * the row write succeeds. */
export async function applyCommittedOutboundEvents(
  redis: Redis,
  conversations: ConversationManager,
  offsetKey = 'outbound:pg-applied',
  streamKey = OUTBOUND_STREAM
): Promise<number> {
  let offset = (await redis.get(offsetKey)) ?? '0-0';
  let applied = 0;
  for (;;) {
    const entries = await redis.xrange(streamKey, `(${offset}`, '+', 'COUNT', 100);
    if (entries.length === 0) {
      await trimOutboundEvents(redis, { streamKey, postgresOffsetKey: offsetKey });
      return applied;
    }
    for (const [streamId, fields] of entries) {
      const values = fieldsToRecord(fields);
      const event = JSON.parse(values['event'] ?? 'null') as SnapshotOutboxEvent | null;
      if (event?.type !== 'send.command')
        throw new Error(`Invalid outbound message event at ${streamId}`);
      const payload = event.payload as OutboundMessagePayload;
      if (!payload.recipientId || !payload.channel || !payload.text)
        throw new Error(`Incomplete outbound message event ${event.eventId}`);
      await conversations.addMessage(
        payload.recipientId,
        { role: 'assistant', content: payload.text },
        { channelMessageId: event.eventId, channel: payload.channel }
      );
      await redis.set(offsetKey, streamId);
      offset = streamId;
      applied += 1;
    }
  }
}

/** In-process stand-in for the future ingress gateway send applier. Delivery is
 * at-least-once: the cursor advances only after a successful channel send. */
export function startOutboundDelivery(
  redis: Redis,
  channels: Map<string, Channel>,
  logger: Logger,
  options: { streamKey?: string; offsetKey?: string } = {}
): { stop(): void; done: Promise<void> } {
  const streamKey = options.streamKey ?? OUTBOUND_STREAM;
  const offsetKey = options.offsetKey ?? 'outbound:delivery-offset';
  let active = true;
  const done = (async () => {
    let offset = (await redis.get(offsetKey)) ?? '0-0';
    await trimOutboundEvents(redis, { streamKey, deliveryOffsetKey: offsetKey });
    while (active) {
      const entries = await redis.xrange(streamKey, `(${offset}`, '+', 'COUNT', 20);
      if (entries.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      for (const [streamId, fields] of entries) {
        if (!active) return;
        const values = fieldsToRecord(fields);
        const event = JSON.parse(values['event'] ?? 'null') as SnapshotOutboxEvent | null;
        if (event?.type !== 'send.command')
          throw new Error(`Invalid outbound message event at ${streamId}`);
        const payload = event.payload as OutboundMessagePayload;
        const channel = channels.get(payload.channel);
        if (!channel) {
          logger.info(
            { eventId: event.eventId, channel: payload.channel },
            'Outbound event committed for the future gateway; no channel is registered'
          );
          // Advance only this process's scan position. Persisting the channel
          // delivery cursor here would let trimming discard events before the
          // future gateway has delivered them.
          offset = streamId;
          continue;
        }
        try {
          const result = await channel.sendMessage(payload.destination, payload.text, {
            ...(typeof payload.replyTo === 'string' ? { replyTo: payload.replyTo } : {}),
          });
          if (!result.success) throw new Error('channel returned unsuccessful send');
          await redis.set(offsetKey, streamId);
          offset = streamId;
          try {
            await trimOutboundEvents(redis, { streamKey, deliveryOffsetKey: offsetKey });
          } catch (trimError) {
            logger.warn({ err: trimError }, 'Could not trim completed outbound events');
          }
        } catch (error) {
          logger.warn(
            { err: error, eventId: event.eventId },
            'Outbound delivery failed; event remains pending for retry'
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          break;
        }
      }
    }
  })();
  return {
    stop: () => {
      active = false;
    },
    done,
  };
}

function fieldsToRecord(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}
