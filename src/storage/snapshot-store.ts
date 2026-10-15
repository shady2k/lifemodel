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
}

const COMMIT_SCRIPT = `
local current_epoch = redis.call('GET', KEYS[1])
if current_epoch ~= ARGV[1] then return 0 end
local events = cjson.decode(ARGV[3])
for _, event in ipairs(events) do
  if redis.call('HEXISTS', KEYS[4], event.eventId) == 0 then
    local stream_id = redis.call('XADD', KEYS[3], '*', 'eventId', event.eventId, 'event', cjson.encode(event))
    redis.call('HSET', KEYS[4], event.eventId, stream_id)
  end
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
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
}

/** Atomic Valkey snapshot and epoch fencing for the core tick writer. */
export class SnapshotStore {
  private readonly epochKey: string;
  private readonly snapshotKey: string;
  private readonly outboundKey: string;
  private readonly outboundKeysKey: string;
  private readonly scriptSha: string;
  private readonly owners = new Map<string, SnapshotSectionOwner>();

  constructor(
    private readonly redis: Redis,
    config: SnapshotStoreConfig = {}
  ) {
    const prefix = config.keyPrefix ?? 'lifemodel:core:snapshot:';
    this.epochKey = `${prefix}${SNAPSHOT_EPOCH_KEY}`;
    this.snapshotKey = `${prefix}${SNAPSHOT_KEY}`;
    this.outboundKey = config.outboundKey ?? `${prefix}outbound`;
    this.outboundKeysKey = `${prefix}outbound:event-keys`;
    this.scriptSha = createHash('sha1').update(COMMIT_SCRIPT).digest('hex');
  }

  register(owner: SnapshotSectionOwner): void {
    if (this.owners.has(owner.section))
      throw new Error(`Duplicate snapshot section: ${owner.section}`);
    this.owners.set(owner.section, owner);
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
    try {
      const result = await this.redis.evalsha(
        this.scriptSha,
        4,
        this.epochKey,
        this.snapshotKey,
        this.outboundKey,
        this.outboundKeysKey,
        String(epoch),
        serialized,
        JSON.stringify(outbox)
      );
      return Number(result) === 1;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      await this.redis.script('LOAD', COMMIT_SCRIPT);
      const result = await this.redis.evalsha(
        this.scriptSha,
        4,
        this.epochKey,
        this.snapshotKey,
        this.outboundKey,
        this.outboundKeysKey,
        String(epoch),
        serialized,
        JSON.stringify(outbox)
      );
      return Number(result) === 1;
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
