import { createHash } from 'node:crypto';
import { Redis } from 'iovalkey';
import { Pool } from 'pg';
import { closeTranscriptWakeBroker, PostgresTranscriptStore } from './postgres-transcript-store.js';
import { CreatureStateStore } from './creature-state-store.js';
import type { IOwnerMessageIntake, OwnerMessageAcceptance } from '../ports/owner-message-intake.js';
import type { CreatureStateReader } from '../ports/creature-state.js';
import type { TranscriptReader } from '../ports/transcript.js';
import type { AttachmentAuthorizer } from '../ports/message-attachment.js';
import type { WebOperationalMetrics } from '../web/operations.js';
import type { WebRuntimeMetrics } from '../web/server.js';
import { createUserMessageSignal } from '../types/signal.js';

const RECEIPT_TTL_SECONDS = 7 * 24 * 60 * 60;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACCEPT_OWNER_MESSAGE_SCRIPT = `
local receipt = redis.call('GET', KEYS[2])
if receipt then
  local decoded = cjson.decode(receipt)
  if decoded.hash == ARGV[5] then return { 'duplicate', decoded.streamId } end
  return { 'conflict' }
end
local stream_id = redis.call('XADD', KEYS[1], '*',
  'type', 'inbound.message',
  'messageId', ARGV[1],
  'recipientId', ARGV[2],
  'text', ARGV[3],
  'timestamp', ARGV[4],
  'signal', ARGV[6])
redis.call('SET', KEYS[2], cjson.encode({ streamId = stream_id, hash = ARGV[5] }), 'EX', ARGV[7])
return { 'accepted', stream_id }
`;

const loadedScripts = new WeakMap<Redis, Promise<string>>();

function validIdTime(id: string): number | null {
  if (!UUID_V7.test(id)) return null;
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}

function validate(id: string, text: string, replyTo?: string): number {
  const timestamp = validIdTime(id);
  if (timestamp === null) throw new Error('id must be a UUIDv7');
  if (
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    Buffer.byteLength(text, 'utf8') > 16 * 1024
  )
    throw new Error('text must be non-empty and at most 16 KiB');
  if (replyTo !== undefined && (typeof replyTo !== 'string' || !/^[1-9]\d*$/.test(replyTo)))
    throw new Error('replyTo must be a positive decimal sequence');
  return timestamp;
}

/** Atomically appends an owner message and retains its retry receipt in Valkey. */
export class OwnerMessageIntake implements IOwnerMessageIntake {
  private readonly streamKey: string;
  private readonly script: string;

  constructor(
    private readonly redis: Redis,
    private readonly recipientId: string,
    private readonly options: {
      streamKey?: string;
      scriptOverride?: string;
      transcript?: TranscriptReader;
    } = {}
  ) {
    if (!recipientId) throw new Error('recipientId is required');
    this.streamKey = options.streamKey ?? 'inbound';
    this.script = options.scriptOverride ?? ACCEPT_OWNER_MESSAGE_SCRIPT;
  }

  async acceptOwnerMessage(
    id: string,
    text: string,
    replyTo?: string
  ): Promise<OwnerMessageAcceptance> {
    const idTime = validate(id, text, replyTo);
    let quotedMessage:
      | { sequence: string; role: 'user' | 'assistant'; excerpt: string }
      | undefined;
    if (replyTo !== undefined) {
      if (!this.options.transcript) return { status: 'reply_not_found' };
      const previous = (BigInt(replyTo) - 1n).toString();
      const page = await this.options.transcript.readTranscript({ after: previous, limit: 1 });
      const row = page.rows.find((candidate) => candidate.sequence === replyTo);
      if (!row) return { status: 'reply_not_found' };
      quotedMessage = { sequence: row.sequence, role: row.role, excerpt: row.text.slice(0, 280) };
    }
    const now = Date.now();
    if (idTime < now - 24 * 60 * 60 * 1_000 || idTime > now + 5 * 60 * 1_000)
      return { status: 'stale' };

    const signal = createUserMessageSignal({
      text,
      updateId: id,
      recipientId: this.recipientId,
      channel: 'web',
      ...(quotedMessage === undefined ? {} : { replyTo: quotedMessage }),
    });
    signal.id = id;
    signal.source = 'sense.web';
    const hash = createHash('sha256').update(text).digest('hex');
    const sha = await this.scriptSha();
    let result: unknown;
    try {
      result = await this.redis.evalsha(
        sha,
        2,
        this.streamKey,
        `inbound:receipt:${id}`,
        id,
        this.recipientId,
        text,
        signal.timestamp.toISOString(),
        hash,
        JSON.stringify(signal),
        String(RECEIPT_TTL_SECONDS)
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      const loadedSha = await this.redis.script('LOAD', this.script);
      if (typeof loadedSha !== 'string') throw new Error('Valkey did not return intake script SHA');
      loadedScripts.set(this.redis, Promise.resolve(loadedSha));
      result = await this.redis.evalsha(
        loadedSha,
        2,
        this.streamKey,
        `inbound:receipt:${id}`,
        id,
        this.recipientId,
        text,
        signal.timestamp.toISOString(),
        hash,
        JSON.stringify(signal),
        String(RECEIPT_TTL_SECONDS)
      );
    }
    if (!Array.isArray(result)) throw new Error('Valkey returned an invalid owner-message result');
    const [status, streamId] = result.map(String);
    if (status === 'conflict') return { status };
    if ((status === 'accepted' || status === 'duplicate') && streamId) return { status, streamId };
    throw new Error('Valkey returned an invalid owner-message result');
  }

  private scriptSha(): Promise<string> {
    let sha = loadedScripts.get(this.redis);
    if (!sha) {
      const loading = this.redis.script('LOAD', this.script).then((value) => {
        if (typeof value !== 'string') throw new Error('Valkey did not return intake script SHA');
        return value;
      });
      sha = loading;
      loadedScripts.set(this.redis, loading);
      void loading.catch(() => {
        if (loadedScripts.get(this.redis) === loading) loadedScripts.delete(this.redis);
      });
    }
    return sha;
  }
}

/** Build the web module's domain operation from the configured durable stores. */
export function createWebPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 3_000,
  });
}

export function createOwnerMessageIntakeFromEnv(env: NodeJS.ProcessEnv = process.env): {
  intake: IOwnerMessageIntake;
  attachments: AttachmentAuthorizer;
  transcript: TranscriptReader;
  creatureState: CreatureStateReader;
  close(): Promise<void>;
  checkStores(): Promise<void>;
  readMetrics(runtime: WebRuntimeMetrics): Promise<WebOperationalMetrics>;
} {
  const valkeyUrl = env['LIFEMODEL_VALKEY_URL'];
  const databaseUrl = env['LIFEMODEL_DATABASE_URL'];
  if (!valkeyUrl) throw new Error('LIFEMODEL_VALKEY_URL is required');
  if (!databaseUrl) throw new Error('LIFEMODEL_DATABASE_URL is required');
  void new URL(databaseUrl);
  const redis = new Redis(valkeyUrl);
  const pool = createWebPool(databaseUrl);
  const recipientId = `rcpt_${createHash('sha256').update('web\0owner').digest('hex').slice(0, 16)}`;
  const transcript = new PostgresTranscriptStore(pool, redis, recipientId);
  const creatureState = new CreatureStateStore(redis);
  return {
    intake: new OwnerMessageIntake(redis, recipientId, { transcript }),
    attachments: transcript,
    transcript,
    creatureState,
    async checkStores() {
      await Promise.all([redis.ping(), pool.query('SELECT 1')]);
    },
    async readMetrics(runtime) {
      const [snapshotRaw, outboundOffset, state] = await Promise.all([
        redis.get('lifemodel:core:snapshot:current'),
        redis.get('outbound:pg-applied'),
        creatureState.readCreatureState(),
      ]);
      const outboundRows = await redis.xrange(
        'outbound',
        `(${outboundOffset ?? '0-0'}`,
        '+',
        'COUNT',
        1
      );
      let pendingTimestamps: number[] = [];
      let inboundReadOffset = '0-0';
      if (snapshotRaw) {
        const snapshot = JSON.parse(snapshotRaw) as {
          sections?: {
            inbound?: {
              readOffset?: string;
              pending?: { signal?: { timestamp?: string } }[];
            };
          };
        };
        const inbound = snapshot.sections?.inbound;
        inboundReadOffset = inbound?.readOffset ?? '0-0';
        pendingTimestamps = (inbound?.pending ?? [])
          .map((entry) => Date.parse(entry.signal?.timestamp ?? ''))
          .filter(Number.isFinite);
      }
      const unreadInbound = await redis.xrange('inbound', `(${inboundReadOffset}`, '+', 'COUNT', 1);
      const unreadFields = unreadInbound[0]?.[1] ?? [];
      for (let index = 0; index < unreadFields.length; index += 2) {
        const fieldValue = unreadFields[index + 1];
        if (unreadFields[index] === 'timestamp' && fieldValue) {
          const timestamp = Date.parse(fieldValue);
          if (Number.isFinite(timestamp)) pendingTimestamps.push(timestamp);
          break;
        }
      }
      const pendingAge = pendingTimestamps.length
        ? Math.max(0, (Date.now() - Math.min(...pendingTimestamps)) / 1000)
        : 0;
      const outboundAge = outboundRows.length
        ? Math.max(0, (Date.now() - Number(outboundRows[0]?.[0].split('-')[0])) / 1000)
        : 0;
      return {
        oldestUnappliedOutboundAgeSeconds: outboundAge,
        oldestPendingInboundAgeSeconds: pendingAge,
        intakeFailures: runtime.intakeFailures,
        sseLag: runtime.sseLag,
        reconnects: runtime.reconnects,
        stateFreshnessSeconds: state ? Math.max(0, state.ageMs / 1000) : 15,
      };
    },
    async close() {
      await closeTranscriptWakeBroker(redis);
      const poolEnd = pool.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.all([
        redis.quit(),
        Promise.race([
          poolEnd,
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Web Postgres pool shutdown timed out'));
            }, 4_000);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        }),
      ]);
    },
  };
}
