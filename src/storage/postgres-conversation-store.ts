import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Storage } from './storage.js';

interface ConversationMessageRow {
  role: string;
  content: string | null;
  timestamp: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  channelMessageId?: string;
  channel?: string;
  messageId?: string;
}
interface ConversationSnapshot {
  messages: ConversationMessageRow[];
  status?: string;
  statusUpdatedAt?: string;
  completedActions?: { tool: string; summary: string; timestamp: string }[];
}
interface EventRow {
  message_id: string;
  kind: string;
  payload: ConversationSnapshot | ConversationMessageRow;
}

/** Storage adapter for conversations. Each save inserts keyed events; it never rewrites or deletes rows. */
export class PostgresConversationStore implements Storage {
  constructor(private readonly pool: Pool) {}

  async load(key: string): Promise<unknown> {
    const recipientId = this.recipientId(key);
    const { rows } = await this.pool.query<EventRow>(
      'SELECT message_id, kind, payload FROM core.conversation_messages WHERE recipient_id = $1 ORDER BY sequence',
      [recipientId]
    );
    const lastClear = rows.reduce((last, row, index) => (row.kind === 'clear' ? index : last), -1);
    const active = rows.slice(lastClear + 1);
    const result: ConversationSnapshot = { messages: [] };
    for (const row of active) {
      if (row.kind === 'message')
        result.messages.push({
          ...(row.payload as ConversationMessageRow),
          messageId: row.message_id,
        });
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
    return active.length ? result : null;
  }

  async save(key: string, data: unknown): Promise<void> {
    const recipientId = this.recipientId(key);
    const snapshot = data as ConversationSnapshot;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const message of snapshot.messages ?? []) {
        const messageId = message.messageId ?? this.messageId(message);
        message.messageId = messageId;
        await client.query(
          `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
           VALUES ($1, $2, 'message', $3::jsonb) ON CONFLICT (recipient_id, message_id) DO NOTHING`,
          [recipientId, messageId, JSON.stringify(message)]
        );
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
        const id = `action:${this.digest(action)}`;
        await this.insertEvent(client, recipientId, id, 'action', action);
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
