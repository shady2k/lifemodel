import { createHash } from 'node:crypto';
import type { Redis } from 'iovalkey';

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KEY = 'current';
export const SNAPSHOT_EPOCH_KEY = 'epoch';

export interface SnapshotEnvelope {
  version: number;
  epoch: number;
  tick: number;
  sections: Record<string, unknown>;
}

export interface SnapshotOutboxEvent {
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface SnapshotSectionOwner<T = unknown> {
  readonly section: string;
  exportSnapshot(): T;
  hydrateSnapshot(value: T | undefined): void | Promise<void>;
  completedSinceSnapshot?(): string[];
  snapshotCommitted?(): void;
}

const COMMIT_SCRIPT = `
local function key_type(key)
  local result = redis.call('TYPE', key)
  return type(result) == 'table' and result.ok or result
end
local expected = { 'string', 'string', 'stream', 'hash', 'zset' }
for index, kind in ipairs(expected) do
  local actual = key_type(KEYS[index])
  if actual ~= 'none' and actual ~= kind then
    return redis.error_reply('WRONGTYPE key ' .. KEYS[index] .. ' must be ' .. kind)
  end
end
local current_epoch = redis.call('GET', KEYS[1])
if current_epoch ~= ARGV[1] then return 0 end
local events = cjson.decode(ARGV[3])
local envelope = cjson.decode(ARGV[2])
local completed_ids = cjson.decode(ARGV[5])
local now = tonumber(ARGV[4])
for _, event in ipairs(events) do
  if redis.call('HEXISTS', KEYS[4], event.eventId) == 0 then
    local stream_id = redis.call('XADD', KEYS[3], '*', 'eventId', event.eventId, 'event', cjson.encode(event))
    redis.call('HSET', KEYS[4], event.eventId, stream_id)
  end
end
redis.call('SET', KEYS[2], ARGV[2])
for _, message_id in ipairs(completed_ids) do
  redis.call('ZADD', KEYS[5], now, message_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now - 90000000)
return 1
`;

// Infrastructure notices do not snapshot mutable tick state. Their receipt and
// append share the same epoch fence and outbound stream as tick CAS commits.
const NOTICE_SCRIPT = `
local expected = { 'string', 'stream', 'hash', 'string', 'zset' }
for index, kind in ipairs(expected) do
  local result = redis.call('TYPE', KEYS[index])
  local actual = type(result) == 'table' and result.ok or result
  if actual ~= 'none' and actual ~= kind then return redis.error_reply('WRONGTYPE notice store') end
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
local prior = redis.call('GET', KEYS[4])
if prior then return prior end
local event = cjson.decode(ARGV[2])
if ARGV[3] ~= 'historical' and redis.call('HEXISTS', KEYS[3], event.eventId) == 0 then
  local stream_id = redis.call('XADD', KEYS[2], '*', 'eventId', event.eventId, 'event', ARGV[2])
  redis.call('HSET', KEYS[3], event.eventId, stream_id)
end
redis.call('SET', KEYS[4], ARGV[2])
redis.call('ZADD', KEYS[5], 0, event.eventId)
return ARGV[2]
`;

export class StaleSnapshotEpochError extends Error {
  constructor(
    readonly committerEpoch: number,
    readonly storedEpoch: number
  ) {
    super(
      `Snapshot epoch mismatch: committer epoch ${String(committerEpoch)}, stored epoch ${String(storedEpoch)}`
    );
    this.name = 'StaleSnapshotEpochError';
  }
}

export interface SnapshotStoreConfig {
  keyPrefix?: string;
  /** Outbound stream shared with the message consumers. */
  outboundKey?: string;
  /** Durable identity set for committed inbound inputs. */
  completedInboundKey?: string;
}

/** Atomic Valkey snapshot and epoch fencing for the core tick writer. */
export class SnapshotStore {
  private readonly epochKey: string;
  private readonly snapshotKey: string;
  private readonly outboundKey: string;
  private readonly outboundKeysKey: string;
  private readonly completedInboundKey: string;
  private readonly noticesKey: string;
  private readonly scriptSha: string;
  private readonly owners = new Map<string, SnapshotSectionOwner>();

  constructor(
    private readonly redis: Redis,
    config: SnapshotStoreConfig = {}
  ) {
    const prefix = config.keyPrefix ?? 'lifemodel:core:snapshot:';
    this.epochKey = `${prefix}${SNAPSHOT_EPOCH_KEY}`;
    this.snapshotKey = `${prefix}${SNAPSHOT_KEY}`;
    this.noticesKey = `${prefix}notices:pending`;
    this.outboundKey = config.outboundKey ?? `${prefix}outbound`;
    this.outboundKeysKey = `${prefix}outbound:event-keys`;
    this.completedInboundKey = config.completedInboundKey ?? 'inbound:completed';
    this.scriptSha = createHash('sha1').update(COMMIT_SCRIPT).digest('hex');
  }

  register(owner: SnapshotSectionOwner): void {
    if (this.owners.has(owner.section))
      throw new Error(`Duplicate snapshot section: ${owner.section}`);
    this.owners.set(owner.section, owner);
  }

  /** Hot original-payload receipt until module confirmation and Postgres proof.
   * A historical Postgres row suppresses append but rehydrates a temporary
   * receipt, so every confirmation still has a receipt-time admission witness.
   */
  async commitNotice(
    epoch: number,
    event: SnapshotOutboxEvent,
    historical = false
  ): Promise<SnapshotOutboxEvent> {
    const receiptKey = `${this.snapshotKey}:notice:${event.eventId}`;
    const result = await this.redis.eval(
      NOTICE_SCRIPT,
      5,
      this.epochKey,
      this.outboundKey,
      this.outboundKeysKey,
      receiptKey,
      this.noticesKey,
      String(epoch),
      JSON.stringify(event),
      historical ? 'historical' : 'new'
    );
    if (typeof result !== 'string')
      throw new StaleSnapshotEpochError(epoch, await this.currentEpoch());
    return JSON.parse(result) as SnapshotOutboxEvent;
  }

  /** Bounded pending work survives a lost confirmation whose plan stops listing. */
  async pendingNotices(): Promise<SnapshotOutboxEvent[]> {
    const ids = await this.redis.zrange(this.noticesKey, '0', '99');
    if (ids.length === 0) return [];
    const values = await this.redis.mget(...ids.map((id) => `${this.snapshotKey}:notice:${id}`));
    return values.flatMap((value) =>
      value === null ? [] : [JSON.parse(value) as SnapshotOutboxEvent]
    );
  }

  /** Caller has just confirmed the physical Postgres natural-key row. */
  async releaseNotice(epoch: number, eventId: string): Promise<void> {
    const result = await this.redis.eval(
      `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[2])
      redis.call('ZREM', KEYS[3], ARGV[2])
      return 1
    `,
      3,
      this.epochKey,
      `${this.snapshotKey}:notice:${eventId}`,
      this.noticesKey,
      String(epoch),
      eventId
    );
    if (Number(result) !== 1) throw new StaleSnapshotEpochError(epoch, await this.currentEpoch());
  }

  async takeEpoch(): Promise<number> {
    return this.redis.incr(this.epochKey);
  }

  async currentEpoch(): Promise<number> {
    return Number((await this.redis.get(this.epochKey)) ?? 0);
  }

  async read(): Promise<SnapshotEnvelope | null> {
    const raw = await this.redis.get(this.snapshotKey);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Invalid snapshot envelope');
    const envelope = value as SnapshotEnvelope;
    if (typeof envelope.version !== 'number') throw new Error('Snapshot envelope has no version');
    if (envelope.version > SNAPSHOT_VERSION) {
      throw new Error(
        `Snapshot version ${String(envelope.version)} is newer than supported version ${String(SNAPSHOT_VERSION)}`
      );
    }
    if (
      typeof envelope.epoch !== 'number' ||
      typeof envelope.tick !== 'number' ||
      !envelope.sections ||
      typeof envelope.sections !== 'object'
    ) {
      throw new Error('Invalid snapshot envelope fields');
    }
    return envelope;
  }

  async hydrate(envelope: SnapshotEnvelope | null): Promise<void> {
    if (!envelope) return;
    for (const [name, owner] of this.owners) {
      await owner.hydrateSnapshot(envelope.sections[name]);
    }
  }

  async commit(
    epoch: number,
    envelope: SnapshotEnvelope,
    outbox: SnapshotOutboxEvent[] = []
  ): Promise<boolean> {
    if (envelope.epoch !== epoch)
      throw new Error(
        `Snapshot epoch ${String(envelope.epoch)} does not match committer epoch ${String(epoch)}`
      );
    const serialized = JSON.stringify(envelope);
    const completedIds = [
      ...new Set([
        ...[...this.owners.values()].flatMap((owner) => owner.completedSinceSnapshot?.() ?? []),
        ...((envelope.sections['inbound'] as { recentMessageIds?: string[] } | undefined)
          ?.recentMessageIds ?? []),
      ]),
    ];
    try {
      const result = await this.redis.evalsha(
        this.scriptSha,
        5,
        this.epochKey,
        this.snapshotKey,
        this.outboundKey,
        this.outboundKeysKey,
        this.completedInboundKey,
        String(epoch),
        serialized,
        JSON.stringify(outbox),
        String(Date.now()),
        JSON.stringify(completedIds)
      );
      const committed = Number(result) === 1;
      if (committed) for (const owner of this.owners.values()) owner.snapshotCommitted?.();
      return committed;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      await this.redis.script('LOAD', COMMIT_SCRIPT);
      const result = await this.redis.evalsha(
        this.scriptSha,
        5,
        this.epochKey,
        this.snapshotKey,
        this.outboundKey,
        this.outboundKeysKey,
        this.completedInboundKey,
        String(epoch),
        serialized,
        JSON.stringify(outbox),
        String(Date.now()),
        JSON.stringify(completedIds)
      );
      const committed = Number(result) === 1;
      if (committed) for (const owner of this.owners.values()) owner.snapshotCommitted?.();
      return committed;
    }
  }

  async commitOwners(
    epoch: number,
    tick: number,
    outbox: SnapshotOutboxEvent[] = []
  ): Promise<boolean> {
    const sections: Record<string, unknown> = {};
    for (const [name, owner] of this.owners) sections[name] = owner.exportSnapshot();
    const envelope: SnapshotEnvelope = { version: SNAPSHOT_VERSION, epoch, tick, sections };
    if (!(await this.commit(epoch, envelope, outbox))) {
      throw new StaleSnapshotEpochError(epoch, await this.currentEpoch());
    }
    return true;
  }
}

export function createSnapshotStore(redis: Redis, config?: SnapshotStoreConfig): SnapshotStore {
  return new SnapshotStore(redis, config);
}
