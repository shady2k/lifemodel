import type { Redis } from 'iovalkey';
import { decodeSignal, type Signal } from '../types/signal.js';
import type { SnapshotSectionOwner } from '../storage/snapshot-store.js';

export interface BusSignalEntry {
  id: string;
  signal: Signal;
}

export interface BusSignalStream extends SnapshotSectionOwner<string> {
  append(signal: Signal): Promise<string>;
  readAfter(offset: string, limit: number): Promise<BusSignalEntry[]>;
  trimBefore(offset: string): Promise<void>;
  committedOffset(): string;
  setCommittedOffset(offset: string): void;
}

/** Durable FIFO for internal signals, sharing the snapshot store's key prefix. */
export class ValkeyBusSignalStream implements BusSignalStream {
  readonly section = 'busOffset';
  private readonly key: string;
  private offset = '0-0';

  constructor(
    private readonly redis: Redis,
    keyPrefix = 'lifemodel:core:snapshot:'
  ) {
    this.key = `${keyPrefix}bus`;
  }

  async append(signal: Signal): Promise<string> {
    return (await this.redis.xadd(this.key, '*', 'signal', JSON.stringify(signal))) as string;
  }

  async readAfter(offset: string, limit: number): Promise<BusSignalEntry[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Bus read limit must be positive');
    const records = await this.redis.xrange(this.key, `(${offset}`, '+', 'COUNT', limit);
    return records.map(([id, fields]) => {
      const payload = fields[fields.indexOf('signal') + 1];
      if (!payload) throw new Error(`Bus entry ${id} has no signal payload`);
      try {
        return { id, signal: decodeSignal(JSON.parse(payload)) };
      } catch (error) {
        throw new Error(`Bus entry ${id} has an invalid signal payload`, { cause: error });
      }
    });
  }

  async trimBefore(offset: string): Promise<void> {
    await this.redis.xtrim(this.key, 'MINID', offset);
  }

  committedOffset(): string {
    return this.offset;
  }

  setCommittedOffset(offset: string): void {
    this.offset = offset;
  }

  exportSnapshot(): string {
    return this.offset;
  }

  hydrateSnapshot(value: string | undefined): void {
    if (value !== undefined && !/^\d+-\d+$/.test(value)) {
      throw new Error(`Invalid bus offset: ${value}`);
    }
    this.offset = value ?? '0-0';
  }
}

export function createBusSignalStream(redis: Redis, keyPrefix?: string): ValkeyBusSignalStream {
  return new ValkeyBusSignalStream(redis, keyPrefix);
}
