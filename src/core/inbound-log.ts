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
 * entries of the recipient it answers (its first trigger) and of the
 * messages it absorbed mid-loop for that recipient; CoreLoop commits them
 * when the turn settles with that recipient's answer delivered - or when
 * the turn settles with no send at all (the owner decision for zero-send
 * resolution is pending, lifemodel-ctc review round 2 finding 4). A
 * rejecting, overrunning turn or a failed/hung/unsent send never commits:
 * the entry stays in the log and is replayed once at the next start.
 *
 * The file is bounded by compaction: committed entries drop, and the dedup
 * index is a bounded ring of recent keys (review round 2, findings 5-6: no
 * update-id watermark - Telegram may legitimately pick a RANDOM update_id
 * again, smaller than any before it, after a week of silence; exact keys
 * plus the recent ring are the only sound dedup, because Telegram
 * re-delivers only recent unconfirmed updates).
 *
 * Each entry also carries the ROUTING data (channel, destination) that the
 * answer needs: a first message of a new chat can outlive the registry's
 * debounce, so replay re-registers the route from the entry.
 *
 * A durable photo receipt (pendingPhoto) is appended at handler entry; the
 * completed photo message REPLACES that entry in place (still one entry per
 * update) and is queued. A crash mid-download replays the receipt, which
 * the channel then completes by re-fetching the file (or queues it as its
 * caption text on failure).
 *
 * The persisted file is a versioned envelope under the unified storage path;
 * a missing file is a fresh log (first run), a corrupt or foreign-version
 * one fails loudly with its path and the original error as `cause`.
 */
import { join } from 'node:path';

import type { Signal } from '../types/signal.js';
import type { Logger } from '../types/logger.js';
import type { Storage } from '../storage/storage.js';
import { encodeDates, decodeDates } from '../utils/json-dates.js';

/** Colon-delimited storage key; maps to <statePath>/core/inbound_log.json. */
export const INBOUND_LOG_KEY = 'core:inbound_log';

const ENVELOPE_VERSION = 2;

/** Default number of entries before a commit compacts them away. */
const DEFAULT_MAX_ENTRIES = 1_000;

/** Default size of the recent-keys ring (the dedup memory beyond compaction). */
const DEFAULT_MAX_RECENT_KEYS = 1_000;

/** Routing data an answer after a restart needs (review round 2, finding 1). */
export interface EntryRouting {
  channel: string;
  destination: string;
}

export interface InboundLogEntry {
  /** Monotone append-order sequence number across all recipients. */
  seq: number;
  /** Dedup key: the Telegram update_id, or the signal id when it is absent. */
  key: string;
  /** Opaque recipient the answer for this message goes to. */
  recipientId: string;
  /** The routing the answer must use after a restart (null when unknown). */
  routing: EntryRouting | null;
  /** The signal as the channel emitted it. */
  signal: Signal;
}

export interface ReplayEntry {
  seq: number;
  signal: Signal;
  routing: EntryRouting | null;
  recipientId: string;
}

/** A recipient's consumer offset: everything <= committedThrough is committed
 * (a contiguous prefix); entries beyond it that are committed anyway (holes
 * an earlier unresolved turn left) are listed individually. */
export interface RecipientProgress {
  committedThrough: number;
  committedBeyond: number[];
}

interface InboundLogEnvelope {
  version: 2;
  savedAt: string;
  nextSeq: number;
  /** Bounded ring of recent dedup keys (the compaction-surviving dedup index). */
  recentKeys: string[];
  recipients: Record<string, RecipientProgress>;
  entries: {
    seq: number;
    key: string;
    recipientId: string;
    routing: EntryRouting | null;
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

/** True while the entry's payload is a photo still being downloaded. */
export function isPhotoReceipt(signal: Signal): boolean {
  const data = signal.data as { pendingPhoto?: unknown } | undefined;
  return data !== undefined && typeof data === 'object' && data.pendingPhoto != null;
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

export class InboundLog {
  private readonly storage: DurablyFlushingStorage;
  private readonly logger: Logger;
  private readonly path: string;
  private readonly maxEntries: number;
  private readonly maxRecentKeys: number;

  private envelope: InboundLogEnvelope = InboundLog.freshEnvelope();
  /** key -> seq, and seq -> array index, both rebuilt on load/compact/change. */
  private readonly keyIndex = new Map<string, number>();
  private readonly seqIndex = new Map<number, number>();
  /** signal id -> seq, for ownership mapping from CoreLoop. */
  private readonly seqBySignalId = new Map<string, number>();

  /**
   * REAL serialization of record()/commit(): every operation runs on the
   * chain; the tail is always reassigned (review round 2, finding 13), and
   * an operation's failure never bricks the chain for later ones.
   */
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
      version: 2,
      savedAt: new Date().toISOString(),
      nextSeq: 1,
      recentKeys: [],
      recipients: {},
      entries: [],
    };
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op);
    // The tail swallows the error so later operations still run; the caller
    // gets the original rejection through `run`.
    this.chain = run.then(
      () => undefined,
      (error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Inbound log operation failed; the chain continues for later operations'
        );
      }
    );
    return run;
  }

  /**
   * Load the persisted log. A missing file is a fresh log; a corrupt one (or
   * a foreign envelope version) fails loudly with the file path and the
   * cause - an unreadable inbound log must never be treated as empty.
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
    const rawVersion = (decoded as { version?: unknown } | null)?.version;
    if (
      decoded === null ||
      typeof decoded !== 'object' ||
      rawVersion !== ENVELOPE_VERSION ||
      typeof decoded.nextSeq !== 'number' ||
      !Array.isArray(decoded.entries) ||
      typeof decoded.recipients !== 'object' ||
      decoded.recipients === null
    ) {
      throw new Error(
        `Corrupt durable inbound log at ${this.path}: unexpected envelope shape (version ${
          typeof rawVersion === 'number' ? String(rawVersion) : 'unknown'
        }, expected ${String(ENVELOPE_VERSION)})`,
        { cause: raw instanceof Error ? raw : new Error(JSON.stringify(raw).slice(0, 500)) }
      );
    }
    for (const entry of decoded.entries) {
      const e = entry as {
        seq?: unknown;
        key?: unknown;
        recipientId?: unknown;
        routing?: unknown;
        signal?: unknown;
      };
      if (
        typeof e.seq !== 'number' ||
        typeof e.key !== 'string' ||
        typeof e.recipientId !== 'string' ||
        typeof e.signal !== 'object' ||
        e.signal === null ||
        !(e.routing === null || (typeof e.routing === 'object' && e.routing !== null))
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
      recentKeys: Array.isArray(decoded.recentKeys)
        ? decoded.recentKeys.filter((k): k is string => typeof k === 'string')
        : [],
      recipients: decoded.recipients,
      entries: decoded.entries,
    };
    this.indexEnvelope();
  }

  /** Rebuild the in-memory lookup indexes from the envelope's entries. */
  private indexEnvelope(): void {
    this.keyIndex.clear();
    this.seqIndex.clear();
    this.seqBySignalId.clear();
    this.envelope.entries.forEach((entry, idx) => {
      this.keyIndex.set(entry.key, entry.seq);
      this.seqIndex.set(entry.seq, idx);
      this.seqBySignalId.set(entry.signal.id, entry.seq);
    });
  }

  /** True if this dedup key was already appended (an entry, or the recent ring). */
  hasKey(key: string): boolean {
    if (this.keyIndex.has(key)) return true;
    return this.envelope.recentKeys.includes(key);
  }

  /**
   * Append a user_message signal and make it durable at once (review round 2,
   * finding 8: a failed flush rolls the in-memory admission back and rejects,
   * so the update is NOT acknowledged as handled).
   *
   * Returns false when the update was seen before (by exact dedup key):
   * it must not be queued, replayed or answered twice.
   */
  record(signal: Signal, routing?: EntryRouting | null): Promise<boolean> {
    return this.enqueue(() => this.recordNow(signal, routing ?? null));
  }

  private async recordNow(signal: Signal, routing: EntryRouting | null): Promise<boolean> {
    const key = dedupKeyOf(signal);
    const existingSeq = this.keyIndex.get(key);
    if (existingSeq !== undefined) {
      return this.admitAgain(existingSeq, signal);
    }
    // The recent-keys ring: an id a compacted entry once carried (or any
    // recently observed key) is a duplicate too (findings 5-6: exact keys
    // govern, no watermark).
    if (this.envelope.recentKeys.includes(key)) {
      this.logger.debug({ key }, 'Duplicate inbound update dropped (recent keys)');
      return false;
    }
    const seq = this.envelope.nextSeq;
    const entry = { seq, key, recipientId: recipientIdOf(signal), routing, signal };

    // Append + index mutations; wiped below if the flush fails.
    this.envelope.nextSeq = seq + 1;
    const recentLenBefore = this.envelope.recentKeys.length;
    this.envelope.entries.push(entry);
    this.envelope.recentKeys.push(key);
    if (this.envelope.recentKeys.length > this.maxRecentKeys) {
      this.envelope.recentKeys.splice(0, this.envelope.recentKeys.length - this.maxRecentKeys);
    }
    this.keyIndex.set(key, seq);
    this.seqIndex.set(seq, this.envelope.entries.length - 1);
    this.seqBySignalId.set(signal.id, seq);
    try {
      await this.persist();
    } catch (error) {
      this.rollbackAppend(seq, signal.id, key, recentLenBefore);
      throw error;
    }
    this.logger.debug(
      { seq, recipientId: entry.recipientId, routing: entry.routing },
      'Inbound message logged durably'
    );
    return true;
  }

  /**
   * The entry behind `seq` exists and its key matched again:
   * - an uncommitted photo receipt is REPLACED by the completed photo
   *   message in place (still one entry per update) and admits again;
   * - anything else is a plain duplicate.
   */
  private async admitAgain(seq: number, signal: Signal): Promise<boolean> {
    const idx = this.seqIndex.get(seq);
    const entry = idx !== undefined ? this.envelope.entries[idx] : undefined;
    if (entry === undefined || !isPhotoReceipt(entry.signal)) {
      this.logger.debug({ key: entry?.key ?? seq }, 'Duplicate inbound update dropped');
      return false;
    }
    if (this.isCommitted(seq)) {
      this.logger.debug({ key: entry.key }, 'Completed photo arrived after its entry committed');
      return false;
    }
    const previousSignal = entry.signal;
    entry.signal = signal;
    try {
      await this.persist();
    } catch (error) {
      // The in-place replacement did not become durable: put the receipt
      // back, so the pending download stays the entry on disk.
      entry.signal = previousSignal;
      throw error;
    }
    this.seqBySignalId.set(signal.id, seq);
    this.logger.debug({ seq, key: entry.key }, 'Pending photo receipt completed in place');
    return true;
  }

  /** Wipe everything recordNow added when the flush failed (finding 8). */
  private rollbackAppend(
    seq: number,
    signalId: string,
    key: string,
    recentLenBefore: number
  ): void {
    const idx = this.seqIndex.get(seq);
    if (idx !== undefined && this.envelope.entries[idx]?.seq === seq) {
      this.envelope.entries.splice(idx, 1);
    }
    this.envelope.nextSeq = Math.min(this.envelope.nextSeq, seq);
    if (this.envelope.recentKeys.length > recentLenBefore) {
      this.envelope.recentKeys.length = recentLenBefore;
    }
    if (this.keyIndex.get(key) === seq) {
      this.keyIndex.delete(key);
    }
    this.seqIndex.delete(seq);
    if (this.seqBySignalId.get(signalId) === seq) {
      this.seqBySignalId.delete(signalId);
    }
    this.logger.warn({ seq, key }, 'Inbound append rolled back: the durable flush failed');
  }

  /** In-memory seq for a signal id the log holds (or undefined). */
  seqForSignal(signalId: string): number | undefined {
    return this.seqBySignalId.get(signalId);
  }

  /** Whether the entry behind this seq is committed for its recipient. */
  isCommitted(seq: number): boolean {
    const idx = this.seqIndex.get(seq);
    const entry = idx !== undefined ? this.envelope.entries[idx] : undefined;
    if (entry === undefined) return false;
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
        out.push({
          seq: entry.seq,
          signal: entry.signal,
          routing: entry.routing,
          recipientId: entry.recipientId,
        });
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
    return this.enqueue(() => this.commitNow(seqs));
  }

  private async commitNow(seqs: number[]): Promise<void> {
    for (const seq of seqs) {
      const idx = this.seqIndex.get(seq);
      const entry = idx !== undefined ? this.envelope.entries[idx] : undefined;
      if (entry === undefined) {
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
    await this.persist();
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
    this.envelope.savedAt = new Date().toISOString();
    await this.storage.save(INBOUND_LOG_KEY, encodeDates(this.envelope));
    // createInboundLog() guaranteed a flushing storage: this await is the
    // durability point of every record() and commit().
    await this.storage.flush?.();
    // Compaction only runs after a SUCCESSFUL flush: its own in-memory
    // rewrite can then never diverge from what record() will roll back.
    if (this.envelope.entries.length > this.maxEntries) {
      this.compact();
      await this.storage.save(INBOUND_LOG_KEY, encodeDates(this.envelope));
      await this.storage.flush?.();
    }
  }

  /** Drop committed entries; the recent-keys ring keeps the dedup memory bounded. */
  private compact(): void {
    const before = this.envelope.entries.length;
    this.envelope.entries = this.envelope.entries.filter((entry) => !this.isCommitted(entry.seq));
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
