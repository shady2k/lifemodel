/**
 * Unit tests for the durable inbound log (lifemodel-ctc.2.1):
 * append+flush at record time, dedup by update_id / signal id, per-recipient
 * committed offsets with holes, replay, compaction, corrupt-file loudness.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createInboundLog,
  INBOUND_LOG_KEY,
  dedupKeyOf,
  type InboundLog,
} from '../../../src/core/inbound-log.js';
import { createJSONStorage, createDeferredStorage } from '../../../src/storage/index.js';
import { createUserMessageSignal, type Signal } from '../../../src/types/signal.js';
import type { Logger } from '../../../src/types/logger.js';

const noopLogger = {
  child: () => noopLogger,
  level: 'silent',
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const roots: string[] = [];

async function makeStorage(): Promise<{
  storagePath: string;
  makeLog: () => Promise<InboundLog>;
}> {
  const storagePath = await mkdtemp(join(tmpdir(), 'inbound-log-'));
  roots.push(storagePath);
  const makeLog = async (): Promise<InboundLog> => {
    const json = createJSONStorage(storagePath, { logger: noopLogger });
    const storage = createDeferredStorage(json, noopLogger, { flushIntervalMs: 60_000 });
    storage.startAutoFlush();
    const log = createInboundLog({ storage, logger: noopLogger, storagePath });
    await log.load();
    return log;
  };
  await mkdir(join(storagePath, 'core'), { recursive: true });
  return { storagePath, makeLog };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function msg(text: string, updateId?: string, recipientId = 'rec-1'): Signal {
  return createUserMessageSignal({
    text,
    recipientId,
    ...(updateId !== undefined && { updateId }),
  });
}

describe('inbound log', () => {
  it('flushes an appended entry to disk before record() resolves', async () => {
    const { storagePath, makeLog } = await makeStorage();
    const log = await makeLog();

    await expect(log.record(msg('hello', 'u-1'))).resolves.toBe(true);

    const raw = await readFile(join(storagePath, 'core', 'inbound_log.json'), 'utf-8');
    const doc = JSON.parse(raw) as { entries: { key: string }[]; nextSeq: number };
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]?.key).toBe('u-1');
    expect(doc.nextSeq).toBe(2);
    void log;
  });

  it('a missing file is a fresh log; replayable is empty', async () => {
    const { makeLog } = await makeStorage();
    const log = await makeLog();
    expect(log.replayable()).toEqual([]);
    expect(log.size()).toEqual({ total: 0, uncommitted: 0 });
  });

  it('drops the same update_id twice - in one run and across instances', async () => {
    const { storagePath, makeLog } = await makeStorage();
    const log1 = await makeLog();
    await expect(log1.record(msg('hello', 'u-1'))).resolves.toBe(true);
    await expect(log1.record(msg('hello', 'u-1'))).resolves.toBe(false);
    // a signal-id fallback duplicate is dropped too
    const sameSignal = msg('hello', 'u-1');
    await expect(log1.record(sameSignal)).resolves.toBe(false);

    const log2 = await makeLog();
    await expect(log2.record(msg('again', 'u-1'))).resolves.toBe(false);
    expect(log2.size()).toEqual({ total: 1, uncommitted: 1 });
    void storagePath;
  });

  it('a smaller numeric id after a larger one is ADMITTED (no watermark, finding 6)', async () => {
    const { makeLog } = await makeStorage();
    const log = await makeLog();
    await expect(log.record(msg('one', '100'))).resolves.toBe(true);
    await expect(log.record(msg('two', '101'))).resolves.toBe(true);
    // Telegram may pick a RANDOM smaller update_id again after a week of
    // silence (https://core.telegram.org/bots/api#update): it must be
    // admitted, never silently dropped by a numeric high-water mark.
    await expect(log.record(msg('three', '50'))).resolves.toBe(true);
  });

  it('a re-delivered id inside the ring is dropped across compaction and restart', async () => {
    const { storagePath, makeLog: makeFreshLog } = await makeStorage();
    const json = createJSONStorage(storagePath, { logger: noopLogger });
    const storage = createDeferredStorage(json, noopLogger, { flushIntervalMs: 60_000 });
    const log = createInboundLog({
      storage,
      logger: noopLogger,
      storagePath,
      config: { maxEntries: 2 },
    });
    await log.load();
    for (const id of ['100', '101', '102']) {
      await log.record(msg('m', id));
    }
    await log.commit([1, 2, 3]);
    expect(log.size().uncommitted).toBe(0);
    await storage.flush();

    // a fresh instance (restart) loads the compacted file; the committed
    // entries are gone but the recent-keys ring still drops their re-delivery
    const log2 = await makeFreshLog();
    expect(log2.size()).toEqual({ total: 0, uncommitted: 0 });
    await expect(log2.record(msg('m again', '101'))).resolves.toBe(false);
    await expect(log2.record(msg('m again 2', '100'))).resolves.toBe(false);
    expect(log2.size()).toEqual({ total: 0, uncommitted: 0 });
    // a genuinely NEW update passes
    await expect(log2.record(msg('new', '103'))).resolves.toBe(true);
  });

  it('commit advances the per-recipient offset; a hole keeps the earlier entry replayable', async () => {
    const { makeLog } = await makeStorage();
    const log = await makeLog();
    await log.record(msg('a', 'u-a', 'rec-1')); // seq 1
    await log.record(msg('b', 'u-b', 'rec-1')); // seq 2
    await log.record(msg('c', 'u-c', 'rec-2')); // seq 3, other recipient

    // turn answers only seq 2 (seq 1's earlier turn rejected)
    await log.commit([2]);

    expect(log.isCommitted(1)).toBe(false);
    expect(log.isCommitted(2)).toBe(true);
    expect(log.isCommitted(3)).toBe(false);

    const replay = log.replayable().map((e) => e.seq);
    expect(replay).toEqual([1, 3]);

    // answering seq 1 later closes the hole
    await log.commit([1]);
    expect(log.replayable().map((e) => e.seq)).toEqual([3]);
  });

  it('commit is idempotent and ignores unknown seqs', async () => {
    const { makeLog } = await makeStorage();
    const log = await makeLog();
    await log.record(msg('a', 'u-a'));
    await log.commit([1]);
    await log.commit([1]);
    await expect(log.commit([999])).resolves.toBeUndefined();
    expect(log.size()).toEqual({ total: 1, uncommitted: 0 });
  });

  it('compacts committed entries away and keeps the file bounded', async () => {
    const { storagePath, makeLog } = await makeStorage();
    const json = createJSONStorage(storagePath, { logger: noopLogger });
    const storage = createDeferredStorage(json, noopLogger, { flushIntervalMs: 60_000 });
    const log = createInboundLog({
      storage,
      logger: noopLogger,
      storagePath,
      config: { maxEntries: 3 },
    });
    await log.load();
    await log.record(msg('one', 'u-1'));
    await log.record(msg('two', 'u-2'));
    await log.record(msg('three', 'u-3'));
    await log.commit([1, 2]);
    expect(log.size()).toEqual({ total: 3, uncommitted: 1 });

    // the next append compacts: committed entries drop, uncommitted stays
    await log.record(msg('four', 'u-4'));
    expect(log.size()).toEqual({ total: 2, uncommitted: 2 });
    expect(log.replayable().map((e) => e.seq)).toEqual([3, 4]);

    const raw = await readFile(join(storagePath, 'core', 'inbound_log.json'), 'utf-8');
    const doc = JSON.parse(raw) as { entries: unknown[] };
    expect(doc.entries).toHaveLength(2);
  });

  it('replay restores the signals intact (dates survive the round trip)', async () => {
    const { makeLog } = await makeStorage();
    const log1 = await makeLog();
    const signal = msg('hello', 'u-1');
    await log1.record(signal);
    const stored = log1.replayable()[0];
    expect(stored?.signal.id).toBe(signal.id);
    expect(stored?.signal.timestamp).toBeInstanceOf(Date);
    expect(stored?.signal.data && (stored.signal.data as { text?: string }).text).toBe('hello');

    const log2 = await makeLog();
    const replayed = log2.replayable();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.signal.id).toBe(signal.id);
    expect(replayed[0]?.signal.timestamp).toBeInstanceOf(Date);
    expect(dedupKeyOf(replayed[0]?.signal as Signal)).toBe('u-1');
  });

  it('a corrupt log file fails loudly with its path and cause', async () => {
    const { storagePath, makeLog } = await makeStorage();
    await writeFile(join(storagePath, 'core', 'inbound_log.json'), 'this is not json', 'utf-8');
    await expect(makeLog()).rejects.toThrow(/inbound_log\.json/);
    await expect(makeLog()).rejects.toMatchObject({ cause: expect.anything() });
  });

  it('records without updateId dedup on the signal id', async () => {
    const { makeLog } = await makeStorage();
    const log = await makeLog();
    const signal = msg('no update id');
    await expect(log.record(signal)).resolves.toBe(true);
    await expect(log.record(signal)).resolves.toBe(false);
    expect(log.hasKey(signal.id)).toBe(true);
    void INBOUND_LOG_KEY;
  });
  it('a failed flush rolls back the admission and can be retried (finding 8)', async () => {
    const { storagePath } = await makeStorage();
    let flushShouldFail = true;
    const json = createJSONStorage(storagePath, { logger: noopLogger });
    const storage = createDeferredStorage(json, noopLogger, { flushIntervalMs: 60_000 });
    const realFlush = storage.flush.bind(storage);
    (storage as { flush: () => Promise<void> }).flush = () => {
      if (flushShouldFail) {
        return Promise.reject(new Error('disk gone'));
      }
      return realFlush();
    };
    const log = createInboundLog({ storage, logger: noopLogger, storagePath });
    await log.load();

    await expect(log.record(msg('first', 'u-1'))).rejects.toThrow('disk gone');
    // NOTHING was admitted in memory: the retry is not a duplicate
    expect(log.hasKey('u-1')).toBe(false);
    expect(log.size()).toEqual({ total: 0, uncommitted: 0 });

    // the disk comes back: the same update is admitted then
    flushShouldFail = false;
    await expect(log.record(msg('first', 'u-1'))).resolves.toBe(true);
    const raw = await realFlush().then(async () =>
      readFile(join(storagePath, 'core', 'inbound_log.json'), 'utf-8')
    );
    const doc = JSON.parse(raw) as { entries: { key: string }[] };
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]?.key).toBe('u-1');
  });

  it('concurrent record and commit serialize, and a failed flush does not brick the chain (finding 13)', async () => {
    const { storagePath } = await makeStorage();
    const json = createJSONStorage(storagePath, { logger: noopLogger });
    const storage = createDeferredStorage(json, noopLogger, { flushIntervalMs: 60_000 });
    const realFlush = storage.flush.bind(storage);
    const log = createInboundLog({ storage, logger: noopLogger, storagePath });
    await log.load();

    // several CONCURRENT operations: they run one at a time, all succeed,
    // and the shutdown raced neither of them
    const first = log.record(msg('a', 'u-a'));
    const second = log.record(msg('b', 'u-b'));
    const committed = log.commit([1]);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await expect(committed).resolves.toBeUndefined();
    expect(log.size()).toEqual({ total: 2, uncommitted: 1 });

    // a failing flush inside one operation must not brick the chain
    (storage as { flush: () => Promise<void> }).flush = () => {
      return Promise.reject(new Error('boom'));
    };
    await expect(log.record(msg('c', 'u-c'))).rejects.toThrow('boom');
    (storage as { flush: () => Promise<void> }).flush = realFlush;
    await expect(log.record(msg('d', 'u-d'))).resolves.toBe(true);
    expect(log.size()).toEqual({ total: 3, uncommitted: 2 });
    void storagePath;
  });

  it('the entry carries routing and replay exposes it (finding 1)', async () => {
    const { makeLog } = await makeStorage();
    const log = await makeLog();
    const signal = msg('hello', 'u-1');
    await log.record(signal, { channel: 'telegram', destination: '700' });
    const replay = log.replayable();
    expect(replay).toHaveLength(1);
    expect(replay[0]?.routing).toEqual({ channel: 'telegram', destination: '700' });
    expect(replay[0]?.recipientId).toBe(
      signal.data && (replay[0]!.signal.data as { recipientId?: string }).recipientId
    );
  });

  it('a completed photo message REPLACES its uncommitted receipt, one entry per update (finding 7)', async () => {
    const { makeLog } = await makeStorage();
    const log = await makeLog();
    const receipt = createUserMessageSignal({
      text: 'See attached',
      recipientId: 'rec-1',
      updateId: 'u-9',
      pendingPhoto: { fileId: 'f1' },
    });
    await expect(log.record(receipt)).resolves.toBe(true);
    expect(log.size().total).toBe(1);
    // the completed photo (same dedup key) rejoins as its own signal
    const full = createUserMessageSignal({
      text: 'See attached',
      recipientId: 'rec-1',
      updateId: 'u-9',
    });
    await expect(log.record(full)).resolves.toBe(true);
    expect(log.size()).toEqual({ total: 1, uncommitted: 1 });
    const replay = log.replayable();
    expect((replay[0]?.signal.data as { pendingPhoto?: unknown }).pendingPhoto).toBeUndefined();
    // once the receipt committed, a late duplicate cannot resurrect it
    await log.commit([1]);
    await expect(log.record(full)).resolves.toBe(false);
  });
});
