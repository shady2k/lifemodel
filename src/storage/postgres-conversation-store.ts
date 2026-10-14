import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Storage } from './storage.js';

interface ConversationMessageRow {
  role: string;
  content: string | null;
  timestamp: string;
  tool_calls?: { id: string }[];
  tool_call_id?: string;
  channelMessageId?: string;
  channel?: string;
  messageId?: string;
  sequence?: string;
}
interface CompactionMarker {
  id?: string;
  summary: string;
  retainedMessageIds: string[];
  timestamp: string;
  coveredThroughSequence?: string;
  expectedMessageCount?: number;
}
interface ConversationSnapshot {
  messages: ConversationMessageRow[];
  status?: string;
  statusUpdatedAt?: string;
  completedActions?: { tool: string; summary: string; timestamp: string }[];
  compactionMarker?: CompactionMarker;
}
interface EventRow {
  message_id: string;
  sequence: string;
  kind: string;
  payload: ConversationSnapshot | ConversationMessageRow;
}

export class ConversationCompactionConflictError extends Error {
  constructor() {
    super('Conversation changed while compaction was being prepared');
  }
}

/** Storage adapter for conversations. Each save inserts keyed events; it never rewrites or deletes rows. */
export class PostgresConversationStore implements Storage {
  constructor(private readonly pool: Pool) {}

  async load(key: string): Promise<unknown> {
    const recipientId = this.recipientId(key);
    const { rows } = await this.pool.query<EventRow>(
      'SELECT message_id, sequence, kind, payload FROM core.conversation_messages WHERE recipient_id = $1 ORDER BY sequence',
      [recipientId]
    );
    const lastClear = rows.reduce((last, row, index) => (row.kind === 'clear' ? index : last), -1);
    const active = rows.slice(lastClear + 1);
    const markerRow = active.filter((row) => row.kind === 'compaction').at(-1);
    const marker = markerRow?.payload as CompactionMarker | undefined;
    const retainedIds = new Set(marker?.retainedMessageIds ?? []);
    const markerSequence = markerRow
      ? BigInt(marker?.coveredThroughSequence ?? markerRow.sequence)
      : 0n;
    const result: ConversationSnapshot = { messages: [] };
    if (marker) result.compactionMarker = { ...marker };
    for (const row of active) {
      if (
        row.kind === 'message' &&
        (!markerRow || BigInt(row.sequence) > markerSequence || retainedIds.has(row.message_id))
      ) {
        result.messages.push({
          ...(row.payload as ConversationMessageRow),
          messageId: row.message_id,
          sequence: row.sequence,
        });
      }
      if (row.kind === 'status') {
        const state = row.payload as { status: string; statusUpdatedAt: string };
        result.status = state.status;
        result.statusUpdatedAt = state.statusUpdatedAt;
      }
      if (row.kind === 'actions_clear') result.completedActions = [];
      if (row.kind === 'action') {
        result.completedActions ??= [];
        result.completedActions.push(
          row.payload as unknown as NonNullable<ConversationSnapshot['completedActions']>[number]
        );
      }
    }
    if (result.completedActions) {
      const cutoff = Date.now() - 4 * 60 * 60 * 1000;
      result.completedActions = result.completedActions
        .filter((action) => new Date(action.timestamp).getTime() > cutoff)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, 20);
    }
    return active.length ? result : null;
  }

  async save(key: string, data: unknown): Promise<void> {
    const recipientId = this.recipientId(key);
    const snapshot = data as ConversationSnapshot;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [recipientId]);
      if (
        snapshot.compactionMarker &&
        snapshot.compactionMarker.id === undefined &&
        snapshot.compactionMarker.expectedMessageCount !== undefined
      ) {
        const { rows } = await client.query<EventRow>(
          'SELECT message_id, sequence, kind, payload FROM core.conversation_messages WHERE recipient_id = $1 ORDER BY sequence',
          [recipientId]
        );
        const clearIndex = rows.reduce(
          (last, row, index) => (row.kind === 'clear' ? index : last),
          -1
        );
        const activeRows = rows.slice(clearIndex + 1);
        const existingMarkerRow = activeRows.filter((row) => row.kind === 'compaction').at(-1);
        const existingMarker = existingMarkerRow?.payload as CompactionMarker | undefined;
        const cutoff = existingMarkerRow
          ? BigInt(existingMarker?.coveredThroughSequence ?? existingMarkerRow.sequence)
          : 0n;
        const retained = new Set(existingMarker?.retainedMessageIds ?? []);
        const count = activeRows.filter(
          (row) =>
            row.kind === 'message' &&
            (BigInt(row.sequence) > cutoff || retained.has(row.message_id))
        ).length;
        if (count !== snapshot.compactionMarker.expectedMessageCount)
          throw new ConversationCompactionConflictError();
      }
      for (const message of snapshot.messages ?? []) {
        const messageId = message.messageId ?? this.messageId(message);
        message.messageId = messageId;
        await client.query(
          `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
           VALUES ($1, $2, 'message', $3::jsonb) ON CONFLICT (recipient_id, message_id) DO NOTHING`,
          [recipientId, messageId, JSON.stringify(message)]
        );
      }
      if (snapshot.compactionMarker) {
        const marker = snapshot.compactionMarker;
        marker.id ??= `compaction:${randomUUID()}`;
        await this.insertEvent(client, recipientId, marker.id, 'compaction', marker);
      }
      if (snapshot.status && snapshot.statusUpdatedAt) {
        const payload = { status: snapshot.status, statusUpdatedAt: snapshot.statusUpdatedAt };
        await this.insertEvent(
          client,
          recipientId,
          `status:${snapshot.statusUpdatedAt}`,
          'status',
          payload
        );
      }
      if (Object.hasOwn(snapshot, 'completedActions') && snapshot.completedActions?.length === 0) {
        await this.insertEvent(
          client,
          recipientId,
          `actions-clear:${randomUUID()}`,
          'actions_clear',
          {}
        );
      }
      for (const action of snapshot.completedActions ?? []) {
        const id = `action:${this.digest({ tool: action.tool, summary: action.summary })}`;
        await client.query(
          `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
           VALUES ($1, $2, 'action', $3::jsonb)
           ON CONFLICT (recipient_id, message_id) DO UPDATE SET payload = EXCLUDED.payload`,
          [recipientId, id, JSON.stringify(action)]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(key: string): Promise<boolean> {
    const recipientId = this.recipientId(key);
    await this.insertEvent(this.pool, recipientId, `clear:${randomUUID()}`, 'clear', {});
    return true;
  }

  async exists(key: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM core.conversation_messages
       WHERE recipient_id = $1
         AND sequence > COALESCE((SELECT MAX(sequence) FROM core.conversation_messages
                                  WHERE recipient_id = $1 AND kind = 'clear'), 0)
       LIMIT 1`,
      [this.recipientId(key)]
    );
    return Boolean(rowCount);
  }

  private messageId(message: ConversationMessageRow): string {
    if (message.channelMessageId && message.channel)
      return `channel:${message.channel}:${message.channelMessageId}`;
    if (message.role === 'tool' && message.tool_call_id) return `tool:${message.tool_call_id}`;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return `turn:${this.digest(message.tool_calls.map((call) => call.id).sort())}`;
    }
    return randomUUID();
  }

  private async insertEvent(
    client: Pick<Pool, 'query'>,
    recipientId: string,
    id: string,
    kind: string,
    payload: unknown
  ): Promise<void> {
    await client.query(
      `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (recipient_id, message_id) DO NOTHING`,
      [recipientId, id, kind, JSON.stringify(payload)]
    );
  }

  private recipientId(key: string): string {
    if (!key.startsWith('conversation:') || key.length === 'conversation:'.length) {
      throw new Error(`Invalid conversation storage key: ${key}`);
    }
    return key.slice('conversation:'.length);
  }

  private digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
