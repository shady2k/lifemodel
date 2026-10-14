import type { Redis } from 'iovalkey';
import { decodeSignal, type Signal } from '../types/signal.js';
import type { SnapshotSectionOwner } from '../storage/snapshot-store.js';

export const MAX_BUS_LEDGER_ENTRIES = 100;

export interface BusSignalEntry {
  id: string;
  signal: Signal;
}

export type BusEntryState =
  | { status: 'owned'; turnId: string; retries: number }
  | { status: 'failed'; turnId: string; retries: number }
  | { status: 'completed' };

export interface BusSnapshot {
  version: 1;
  watermark: string;
  entries: Record<string, BusEntryState>;
}

export interface BusSignalStream extends SnapshotSectionOwner<BusSnapshot> {
  append(signal: Signal): Promise<string>;
  readAfter(offset: string, limit: number): Promise<BusSignalEntry[]>;
  trimBefore(offset: string): Promise<void>;
  committedOffset(): string;
  stateFor(id: string): BusEntryState | undefined;
  ensureOwned(id: string, turnId: string): void;
  markOwned(ids: string[], turnId: string): void;
  markCompleted(ids: string[]): void;
  markFailed(ids: string[]): void;
  admissionCapacity(): number;
}

/** Durable FIFO for internal signals, sharing the snapshot store's key prefix. */
export class ValkeyBusSignalStream implements BusSignalStream {
  readonly section = 'busOffset';
  private readonly key: string;
  private snapshot: BusSnapshot = { version: 1, watermark: '0-0', entries: {} };

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
    return this.snapshot.watermark;
  }

  stateFor(id: string): BusEntryState | undefined {
    const state = this.snapshot.entries[id];
    return state ? structuredClone(state) : undefined;
  }

  admissionCapacity(): number {
    return Math.max(0, MAX_BUS_LEDGER_ENTRIES - Object.keys(this.snapshot.entries).length);
  }

  ensureOwned(id: string, turnId: string): void {
    if (this.snapshot.entries[id]) return;
    if (this.admissionCapacity() === 0) return;
    this.snapshot.entries[id] = { status: 'owned', turnId, retries: 0 };
  }

  markOwned(ids: string[], turnId: string): void {
    for (const id of ids) {
      const current = this.snapshot.entries[id];
      if (current?.status === 'completed') continue;
      this.snapshot.entries[id] = { status: 'owned', turnId, retries: current?.retries ?? 0 };
    }
  }

  markCompleted(ids: string[]): void {
    for (const id of ids) {
      if (this.snapshot.entries[id]) this.snapshot.entries[id] = { status: 'completed' };
    }
    this.advanceWatermark();
  }

  markFailed(ids: string[]): void {
    for (const id of ids) {
      const current = this.snapshot.entries[id];
      if (!current || current.status === 'completed') continue;
      this.snapshot.entries[id] = {
        status: 'failed',
        turnId: current.turnId,
        retries: current.retries + 1,
      };
    }
  }

  exportSnapshot(): BusSnapshot {
    return structuredClone(this.snapshot);
  }

  hydrateSnapshot(value: BusSnapshot | undefined): void {
    if (value === undefined) {
      this.snapshot = { version: 1, watermark: '0-0', entries: {} };
      return;
    }
    if (
      value.version !== 1 ||
      typeof value.watermark !== 'string' ||
      !/^\d+-\d+$/.test(value.watermark) ||
      !value.entries ||
      typeof value.entries !== 'object' ||
      Array.isArray(value.entries)
    ) {
      throw new Error('Invalid bus snapshot section');
    }
    for (const [id, state] of Object.entries(value.entries)) {
      if (
        !/^\d+-\d+$/.test(id) ||
        compareStreamIds(id, value.watermark) <= 0 ||
        !state ||
        !['owned', 'failed', 'completed'].includes(state.status)
      ) {
        throw new Error(`Invalid bus entry state at ${id}`);
      }
      if (
        state.status !== 'completed' &&
        (typeof state.turnId !== 'string' || !Number.isInteger(state.retries) || state.retries < 0)
      ) {
        throw new Error(`Invalid bus turn ownership at ${id}`);
      }
    }
    this.snapshot = structuredClone(value);
  }

  private advanceWatermark(): void {
    const ids = Object.keys(this.snapshot.entries).sort(compareStreamIds);
    let watermark = this.snapshot.watermark;
    for (const id of ids) {
      if (compareStreamIds(id, watermark) <= 0) continue;
      if (this.snapshot.entries[id]?.status !== 'completed') break;
      watermark = id;
    }
    this.snapshot.watermark = watermark;
    this.snapshot.entries = Object.fromEntries(
      Object.entries(this.snapshot.entries).filter(([id]) => compareStreamIds(id, watermark) > 0)
    );
  }
}

function compareStreamIds(left: string, right: string): number {
  const [leftMs, leftSeq] = left.split('-');
  const [rightMs, rightSeq] = right.split('-');
  if (!leftMs || !leftSeq || !rightMs || !rightSeq) throw new Error('Invalid Valkey stream ID');
  const a = BigInt(leftMs),
    b = BigInt(rightMs);
  if (a !== b) return a < b ? -1 : 1;
  const x = BigInt(leftSeq),
    y = BigInt(rightSeq);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function createBusSignalStream(redis: Redis, keyPrefix?: string): ValkeyBusSignalStream {
  return new ValkeyBusSignalStream(redis, keyPrefix);
}
