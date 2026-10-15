import type { Pool } from 'pg';
import type { Redis } from 'iovalkey';
import type {
  ReadTranscriptOptions,
  TranscriptPage,
  TranscriptReader,
  TranscriptRow,
} from '../ports/transcript.js';

const MAX_PAGE_SIZE = 50;
const OUTBOUND_STREAM = 'outbound';
const WAKE_POLL_MS = 1_000;

interface TranscriptDbRow {
  sequence: string;
  message_id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at: Date | string;
  reply_to: unknown;
  has_reply_to: boolean;
  newest_sequence: string | null;
}

/** Direct, recipient-scoped transcript projection and wake-hint watcher. */
export class PostgresTranscriptStore implements TranscriptReader {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly recipientId: string
  ) {
    if (!recipientId) throw new Error('Transcript recipient id is required');
  }

  async readTranscript(options: ReadTranscriptOptions): Promise<TranscriptPage> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_PAGE_SIZE)
      throw new Error('Transcript limit must be between 1 and 50');
    if (options.before !== undefined && options.after !== undefined)
      throw new Error('Transcript cursor cannot specify both before and after');
    const cursor = options.before ?? options.after;
    if (cursor !== undefined && !/^(0|[1-9][0-9]*)$/.test(cursor))
      throw new Error('Transcript cursor must be a decimal sequence');

    const direction = options.after !== undefined ? 'ASC' : 'DESC';
    const comparator = options.after !== undefined ? '>' : '<';
    const cursorPredicate =
      cursor === undefined ? '' : `AND sequence::bigint ${comparator} $2::bigint`;
    const limitParam = cursor === undefined ? '$2' : '$3';
    const values =
      cursor === undefined
        ? [this.recipientId, options.limit]
        : [this.recipientId, cursor, options.limit];
    const { rows } = await this.pool.query<TranscriptDbRow>(
      `WITH visible AS (
         SELECT sequence::text, message_id, payload->>'role' AS role,
                payload->>'content' AS text, created_at, payload->'replyTo' AS reply_to,
                payload ? 'replyTo' AS has_reply_to
         FROM core.conversation_messages
         WHERE recipient_id = $1 AND kind = 'message'
           AND (payload->>'role' = 'user' OR
                (payload->>'role' = 'assistant'
                 AND jsonb_typeof(payload->'content') = 'string'
                 AND (payload->'tool_calls' IS NULL OR payload->'tool_calls' = '[]'::jsonb)))
       ), newest AS (
         SELECT (SELECT sequence FROM visible ORDER BY sequence::bigint DESC LIMIT 1) AS newest_sequence
       ), page AS (
         SELECT * FROM visible WHERE true ${cursorPredicate}
         ORDER BY sequence::bigint ${direction} LIMIT ${limitParam}
       )
       SELECT page.sequence, page.message_id, page.role, page.text, page.created_at,
              page.reply_to, page.has_reply_to, newest.newest_sequence
       FROM newest LEFT JOIN page ON true
       ORDER BY page.sequence::bigint ${direction}`,
      values
    );
    const newestSequence = rows[0]?.newest_sequence ?? null;
    const resultRows = rows.filter((row) => row.sequence !== null).map((row) => this.toDto(row));
    return {
      rows: resultRows,
      cursor: newestSequence,
    };
  }

  async *watchTranscript(after: string, signal?: AbortSignal): AsyncIterable<TranscriptRow> {
    if (!/^(0|[1-9][0-9]*)$/.test(after))
      throw new Error('Transcript cursor must be a decimal sequence');
    let cursor = after;
    const wakeRedis = this.redis.duplicate();
    try {
      while (!signal?.aborted) {
        const page = await this.readTranscript({ after: cursor, limit: MAX_PAGE_SIZE });
        if (page.rows.length) {
          for (const row of page.rows) {
            if (signal?.aborted) return;
            cursor = row.sequence;
            yield row;
          }
          continue;
        }
        if (signal?.aborted) return;
        await wakeRedis.xread('BLOCK', WAKE_POLL_MS, 'STREAMS', OUTBOUND_STREAM, '$');
      }
    } finally {
      await wakeRedis.quit();
    }
  }

  private parseReplyTo(value: unknown): NonNullable<TranscriptRow['replyTo']> {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('sequence' in value) ||
      !('role' in value) ||
      !('excerpt' in value)
    ) {
      throw new Error('Stored transcript replyTo is missing required fields');
    }
    const replyTo = value as Record<string, unknown>;
    if (
      typeof replyTo['sequence'] !== 'string' ||
      !/^[1-9][0-9]*$/.test(replyTo['sequence']) ||
      (replyTo['role'] !== 'user' && replyTo['role'] !== 'assistant') ||
      typeof replyTo['excerpt'] !== 'string' ||
      replyTo['excerpt'].length > 280
    ) {
      throw new Error('Stored transcript replyTo is malformed');
    }
    return {
      sequence: replyTo['sequence'],
      role: replyTo['role'],
      excerpt: replyTo['excerpt'],
    };
  }

  private toDto(row: TranscriptDbRow): TranscriptRow {
    const clientId = row.message_id.startsWith('inbound:')
      ? row.message_id.slice('inbound:'.length)
      : undefined;
    return {
      sequence: row.sequence,
      ...(clientId ? { clientId } : {}),
      role: row.role,
      text: row.text,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.has_reply_to ? { replyTo: this.parseReplyTo(row.reply_to) } : {}),
    };
  }
}
