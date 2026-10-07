/**
 * Durable inbound log (Kafka-like, in-process) - lifemodel-ctc.2.1.
 *
 * Every inbound user message is appended here at emit time and flushed at
 * once through the unified storage path (DeferredStorage -> JSONStorage,
 * AGENTS.md lesson 4). An entry only leaves the log when its answer is
 * DELIVERED: the consumer offset advances per recipient in commit(), and a
 * start replays every uncommitted entry in order as signals. A re-delivered
 * Telegram update_id is dropped instead of appended, so the same external
 * message never produces a second turn.
 *
 * Offset decision (see the stage report): the offset is PER RECIPIENT, not
 * global. With a global offset one slow or failed send to chat A would hold
 * back chat B's commits; after a restart B's already-answered messages would
 * replay and be answered twice. Per-recipient offsets make a failure visible
 * only to the recipient whose answer was not delivered.
 *
 * Commits are tied to cognition turns by CoreLoop: a turn owns the log
 * entries of its trigger signals and of the messages it absorbed mid-loop;
 * CoreLoop commits them per recipient when the turn settles and every send
 * of that turn to that recipient succeeded - or when the turn settled with
 * no send at all (core.defer, a message that needs no reply). A rejecting,
 * overrunning turn or a failed/hung send never commits: the entry stays in
 * the log and is replayed once at the next start.
 *
 * Compaction keeps the file bounded: committed entries are dropped, while
 * the dedup index survives (Telegram update ids are monotone, so the
 * highest seen update id plus a bounded ring of recent keys is enough).
 *
 * The persisted file is a versioned envelope under the unified storage path;
 * a missing file is a fresh log (first run), a corrupt one fails loudly with
 * its path and the original error as `cause`.
 */
import { join } from 'node:path';

import type { Signal } from '../types/signal.js';
import type { Logger } from '../types/logger.js';
import type { Storage } from '../storage/storage.js';
import { encodeDates, decodeDates } from '../utils/json-dates.js';

/** Colon-delimited storage key; maps to <statePath>/core/inbound_log.json. */
export const INBOUND_LOG_KEY = 'core:inbound_log';

const ENVELOPE_VERSION = 1;

/** Default number of entries before a commit compacts them away. */
const DEFAULT_MAX_ENTRIES = 1_000;

/** Default size of the recent-keys ring (non-monotone dedup fallback). */
const DEFAULT_MAX_RECENT_KEYS = 1_000;

export interface InboundLogEntry {
  /** Monotone append-order sequence number across all recipients. */
  seq: number;
  /** Dedup key: the Telegram update_id, or the signal id when it is absent. */
  key: string;
  /** Opaque recipient the answer for this message goes to. */
  recipientId: string;
  /** The signal as the channel emitted it. */
  signal: Signal;
}

export interface ReplayEntry {
  seq: number;
  signal: Signal;
}

/** A recipient's consumer offset: everything <= committedThrough is committed
 * (a contiguous prefix); entries beyond it that are committed anyway (holes
 * an earlier unresolved turn left) are listed individually. */
export interface RecipientProgress {
  committedThrough: number;
  committedBeyond: number[];
}

interface InboundLogEnvelope {
  version: 1;
  savedAt: string;
  nextSeq: number;
  /** Highest Telegram update id ever appended (monotone dedup index). */
  maxUpdateId: string | null;
  /** Bounded ring of recent dedup keys for non-monotone sources. */
  recentKeys: string[];
  recipients: Record<string, RecipientProgress>;
  entries: {
    seq: number;
    key: string;
    recipientId: string;
    /** Date-encoded signal (as it is stored in the file). */
    signal: Signal;
  }[];
}

/** The dedup key under which record() admits a signal exactly once. */
export function dedupKeyOf(signal: Signal): string {
  const data = signal.data as { updateId?: unknown } | undefined;
  if (typeof data?.updateId === 'string' && data.updateId !== '') {
    return data.updateId;
  }
  return signal.id;
}

/** The recipient a user message is answered to (the commit grouping key). */
export function recipientIdOf(signal: Signal): string {
  const data = signal.data as { recipientId?: unknown } | undefined;
  return typeof data?.recipientId === 'string' ? data.recipientId : '';
}

export interface InboundLogConfig {
  /** Compact committed entries away once this many exist (default 1000). */
  maxEntries?: number;
  /** Size of the recent-keys dedup ring (default 1000). */
  maxRecentKeys?: number;
}

/**
 * The inbound log needs an ACTUAL durability point after every save: the
 * production storage is DeferredStorage, whose awaited flush() is one.
 * Plain Storage implementations that flush on save() also satisfy it; a
 * non-flushing Storage is rejected at construction.
 */
export interface DurablyFlushingStorage extends Storage {
  flush?: () => Promise<void>;
}

export interface InboundLogDeps {
  storage: DurablyFlushingStorage;
  logger: Logger;
  /** Base state path; only used for error messages with the real file path. */
  storagePath: string;
  config?: InboundLogConfig;
}

/**
 * True if both keys are plain integers and seen is strictly newer. Telegram
 * update ids grow monotonically, so "at or below the newest seen id" implies
 * the update was already observed.
 */
function isNewerNumeric(a: string, b: string | null): boolean {
  return /^\d+$/.test(a) && b !== null && /^\d+$/.test(b) && BigInt(a) > BigInt(b);
}

export class InboundLog {
  private readonly storage: DurablyFlushingStorage;
  private readonly logger: Logger;
  private readonly path: string;
  private readonly maxEntries: number;
  private readonly maxRecentKeys: number;

  private envelope: InboundLogEnvelope = InboundLog.freshEnvelope();
  /** seq -> entry index of the current envelope (parallel to entries). */
  private readonly bySeq = new Map<number, { key: string; recipientId: string }>();
  /** signal id -> seq, for ownership mapping from CoreLoop. */
  private readonly seqBySignalId = new Map<string, number>();

  /** Serializes record()/commit() so the file never interleaves. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: InboundLogDeps) {
    this.storage = deps.storage;
    this.logger = deps.logger.child({ component: 'inbound-log' });
    this.path = join(deps.storagePath, 'core', 'inbound_log.json');
    this.maxEntries = deps.config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxRecentKeys = deps.config?.maxRecentKeys ?? DEFAULT_MAX_RECENT_KEYS;
  }

  private static freshEnvelope(): InboundLogEnvelope {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      nextSeq: 1,
      maxUpdateId: null,
      recentKeys: [],
      recipients: {},
      entries: [],
    };
  }

  /**
   * Load the persisted log. A missing file is a fresh log; a corrupt one
   * fails loudly with the file path and the cause - an unreadable inbound
   * log must never be treated as empty.
   */
  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.storage.load(INBOUND_LOG_KEY);
    } catch (error) {
      throw new Error(
        `Failed to read the durable inbound log at ${this.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    if (raw == null) {
      this.envelope = InboundLog.freshEnvelope();
      this.indexEnvelope();
      return;
    }
    const decoded = decodeDates(raw) as Partial<InboundLogEnvelope>;
    if (
      decoded === null ||
      typeof decoded !== 'object' ||
      decoded.version !== ENVELOPE_VERSION ||
      typeof decoded.nextSeq !== 'number' ||
      !Array.isArray(decoded.entries) ||
      typeof decoded.recipients !== 'object' ||
      decoded.recipients === null
    ) {
      throw new Error(`Corrupt durable inbound log at ${this.path}: unexpected envelope shape`, {
        cause: raw instanceof Error ? raw : new Error(JSON.stringify(raw).slice(0, 500)),
      });
    }
    for (const entry of decoded.entries) {
      const e = entry as { seq?: unknown; key?: unknown; recipientId?: unknown; signal?: unknown };
      if (
        typeof e.seq !== 'number' ||
        typeof e.key !== 'string' ||
        typeof e.recipientId !== 'string' ||
        typeof e.signal !== 'object' ||
        e.signal === null
      ) {
        throw new Error(`Corrupt durable inbound log at ${this.path}: invalid entry`, {
          cause: new Error(JSON.stringify(entry).slice(0, 500)),
        });
      }
      const signal = e.signal as Partial<Signal>;
      if (typeof signal.id !== 'string' || typeof signal.type !== 'string') {
        throw new Error(`Corrupt durable inbound log at ${this.path}: entry is not a signal`, {
          cause: new Error(JSON.stringify(entry).slice(0, 500)),
        });
      }
    }
    this.envelope = {
      version: ENVELOPE_VERSION,
      savedAt: typeof decoded.savedAt === 'string' ? decoded.savedAt : new Date().toISOString(),
      nextSeq: decoded.nextSeq,
      maxUpdateId: typeof decoded.maxUpdateId === 'string' ? decoded.maxUpdateId : null,
      recentKeys: Array.isArray(decoded.recentKeys)
        ? decoded.recentKeys.filter((k): k is string => typeof k === 'string')
        : [],
      recipients: decoded.recipients,
      entries: decoded.entries,
    };
    this.indexEnvelope();
  }

  /** Build the in-memory lookup indexes from the envelopes entries. */
  private indexEnvelope(): void {
    this.bySeq.clear();
    this.seqBySignalId.clear();
    for (const entry of this.envelope.entries) {
      this.bySeq.set(entry.seq, { key: entry.key, recipientId: entry.recipientId });
      this.seqBySignalId.set(entry.signal.id, entry.seq);
    }
  }

  /** True if this dedup key was already appended (entry, ring or monotone range). */
  hasKey(key: string): boolean {
    for (const entry of this.bySeq.values()) {
      if (entry.key === key) return true;
    }
    if (this.envelope.recentKeys.includes(key)) return true;
    // Telegram update ids grow monotonically: at or below the newest seen id
    // means the very same update was observed before. Non-numeric keys
    // (signal-id fallback) are only deduplicated by the indexes above.
    if (!/^\d+$/.test(key)) {
      return false;
    }
    return this.envelope.maxUpdateId !== null && !isNewerNumeric(key, this.envelope.maxUpdateId);
  }

  /**
   * Append a user_message signal and make it durable at once. Returns false
   * when the update was seen before (by update_id or signal id): it must not
   * be queued, replayed or answered twice.
   */
  async record(signal: Signal): Promise<boolean> {
    return this.chain.then(() => this.recordNow(signal));
  }

  private async recordNow(signal: Signal): Promise<boolean> {
    const key = dedupKeyOf(signal);
    if (this.hasKey(key)) {
      this.logger.debug({ key, signalId: signal.id }, 'Duplicate inbound update dropped');
      return false;
    }
    const seq = this.envelope.nextSeq;
    this.envelope.nextSeq = seq + 1;
    const entry = {
      seq,
      key,
      recipientId: recipientIdOf(signal),
      signal: signal,
    };
    this.envelope.entries.push(entry);
    this.envelope.recentKeys.push(key);
    if (this.envelope.recentKeys.length > this.maxRecentKeys) {
      this.envelope.recentKeys = this.envelope.recentKeys.slice(-this.maxRecentKeys);
    }
    if (isNewerNumeric(key, this.envelope.maxUpdateId)) {
      this.envelope.maxUpdateId = key;
    }
    this.bySeq.set(seq, { key, recipientId: entry.recipientId });
    this.seqBySignalId.set(signal.id, seq);
    await this.persist();
    this.logger.debug({ seq, recipientId: entry.recipientId }, 'Inbound message logged durably');
    return true;
  }

  /** In-memory seq for a signal id the log holds (or undefined). */
  seqForSignal(signalId: string): number | undefined {
    return this.seqBySignalId.get(signalId);
  }

  /** Whether the entry behind this seq is committed for its recipient. */
  isCommitted(seq: number): boolean {
    const entry = this.bySeq.get(seq);
    if (!entry) return false;
    const progress = this.progressFor(entry.recipientId);
    return seq <= progress.committedThrough || progress.committedBeyond.includes(seq);
  }

  /** Observable size (ops/tests): total entries and uncommitted entries. */
  size(): { total: number; uncommitted: number } {
    const total = this.envelope.entries.length;
    const uncommitted = this.envelope.entries.filter(
      (entry) => !this.isCommitted(entry.seq)
    ).length;
    return { total, uncommitted };
  }

  /**
   * Every uncommitted entry, in sequence order - what a start replays.
   */
  replayable(): ReplayEntry[] {
    const out: ReplayEntry[] = [];
    for (const entry of this.envelope.entries) {
      if (!this.isCommitted(entry.seq)) {
        out.push({ seq: entry.seq, signal: entry.signal });
      }
    }
    return out;
  }

  /**
   * Commit entries by seq (idempotent). Advances each touched recipient's
   * offset, flushes at once, and compacts committed entries away when the
   * file grows past the bound.
   */
  async commit(seqs: number[]): Promise<void> {
    return this.chain.then(() => {
      for (const seq of seqs) {
        const entry = this.bySeq.get(seq);
        if (!entry) {
          this.logger.warn({ seq }, 'Commit asked for an unknown inbound log seq; ignored');
          continue;
        }
        const progress = this.progressFor(entry.recipientId);
        if (seq <= progress.committedThrough || progress.committedBeyond.includes(seq)) {
          continue;
        }
        if (seq > progress.committedThrough) {
          progress.committedBeyond.push(seq);
        }
        this.advanceProgress(entry.recipientId);
      }
      return this.persist();
    });
  }

  /** Sort and trim committedBeyond, raising committedThrough as far as possible. */
  private advanceProgress(recipientId: string): void {
    const progress = this.progressFor(recipientId);
    progress.committedBeyond.sort((a, b) => a - b);
    // committedBeyond members covered by the prefix are redundant
    progress.committedBeyond = progress.committedBeyond.filter(
      (seq) => seq > progress.committedThrough
    );
    const uncommittedSeqs: number[] = [];
    for (const entry of this.envelope.entries) {
      if (entry.recipientId !== recipientId) continue;
      if (entry.seq <= progress.committedThrough) continue;
      if (progress.committedBeyond.includes(entry.seq)) continue;
      uncommittedSeqs.push(entry.seq);
    }
    if (uncommittedSeqs.length === 0) {
      // Everything this recipient has on record is committed.
      const lastSeq = Math.max(progress.committedThrough, ...progress.committedBeyond, 0);
      progress.committedThrough = Math.max(progress.committedThrough, lastSeq);
      progress.committedBeyond = [];
      return;
    }
    // Everything below the lowest uncommitted entry is committed history.
    const firstUncommitted = Math.min(...uncommittedSeqs);
    if (firstUncommitted - 1 > progress.committedThrough) {
      progress.committedThrough = firstUncommitted - 1;
      progress.committedBeyond = progress.committedBeyond.filter(
        (seq) => seq > progress.committedThrough
      );
    }
  }

  private progressFor(recipientId: string): RecipientProgress {
    const existing = this.envelope.recipients[recipientId];
    if (existing) {
      existing.committedBeyond ??= [];
      return existing;
    }
    const created: RecipientProgress = { committedThrough: 0, committedBeyond: [] };
    this.envelope.recipients[recipientId] = created;
    return created;
  }

  private async persist(): Promise<void> {
    if (this.envelope.entries.length > this.maxEntries) {
      this.compact();
    }
    this.envelope.savedAt = new Date().toISOString();
    await this.storage.save(INBOUND_LOG_KEY, encodeDates(this.envelope));
    // createInboundLog() guaranteed a flushing storage: this await is the
    // durability point of every record() and commit().
    await this.storage.flush?.();
  }

  /** Drop committed entries; keep the dedup index bounded (update ids monotone). */
  private compact(): void {
    const before = this.envelope.entries.length;
    this.envelope.entries = this.envelope.entries.filter((entry) => {
      const progress = this.progressFor(entry.recipientId);
      const committed =
        entry.seq <= progress.committedThrough || progress.committedBeyond.includes(entry.seq);
      return !committed;
    });
    // All remaining entries are uncommitted: hole marks beyond the prefix
    // that point at removed entries are moot.
    const remaining = new Set(this.envelope.entries.map((e) => e.seq));
    for (const progress of Object.values(this.envelope.recipients)) {
      progress.committedBeyond = progress.committedBeyond.filter((seq) => remaining.has(seq));
    }
    if (this.envelope.recentKeys.length > this.maxRecentKeys) {
      this.envelope.recentKeys = this.envelope.recentKeys.slice(-this.maxRecentKeys);
    }
    this.indexEnvelope();
    this.logger.info(
      { before, after: this.envelope.entries.length, path: this.path },
      'Inbound log compacted'
    );
  }
}

export function createInboundLog(deps: InboundLogDeps): InboundLog {
  if (typeof deps.storage.flush !== 'function') {
    throw new Error(
      'The durable inbound log requires a storage that flushes on demand ' +
        '(DeferredStorage): an accepted message must be on disk before the signal is queued.'
    );
  }
  return new InboundLog(deps);
}
