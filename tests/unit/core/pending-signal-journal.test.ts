/**
 * Unit tests for the pending-signal journal.
 *
 * The journal persists signals accepted but not yet processed at stop
 * (pendingSignals + the trigger of a cognition turn that overran its stop
 * deadline) so a fresh start can restore and process them.
 *
 * Contract:
 * - Round trip preserves signal identity, order and Date fields.
 * - A corrupt persisted file fails loudly with its path.
 * - No persisted file means no signals (not an error).
 */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Signal } from '../../../src/types/signal.js';
import { createSignal } from '../../../src/types/signal.js';
import type { Logger } from '../../../src/types/logger.js';
import {
  loadPendingSignals,
  persistPendingSignals,
  pendingSignalsPath,
  PENDING_SIGNALS_KEY,
} from '../../../src/core/pending-signal-journal.js';
import { createJSONStorage, createDeferredStorage } from '../../../src/storage/index.js';

let dir: string;
let storagePath: string;
let logger: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pending-signals-'));
  storagePath = dir; // journal derives <storagePath>/core/pending_signals.json
  logger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function thoughtSignal(text: string, savedMinutesAgo = 0): Signal {
  const s = createSignal('thought', 'cognition.thought', { value: 1 }, {
    data: { kind: 'thought', text, triggerSource: 'test', depth: 0, rootThoughtId: 'root' },
  });
  // Age the signal deterministically instead of sleeping.
  const made = new Date(Date.now() - savedMinutesAgo * 60_000);
  s.timestamp = made;
  s.expiresAt = new Date(made.getTime() + 60_000);
  return s;
}

describe('pending-signal journal', () => {
  it('round-trips signals with order, identity and Date fields', async () => {
    const storage = createJSONStorage(storagePath);
    const s1 = thoughtSignal('first');
    const s2 = thoughtSignal('second', 3);

    await persistPendingSignals(storage, logger, [s1, s2]);

    const restored = await loadPendingSignals(storage, storagePath, logger);

    expect(restored).toHaveLength(2);
    expect(restored[0]?.id).toBe(s1.id);
    expect(restored[1]?.id).toBe(s2.id);
    expect(restored[0]?.timestamp).toBeInstanceOf(Date);
    expect(restored[0]?.timestamp.getTime()).toBe(s1.timestamp.getTime());
    expect(restored[0]?.expiresAt?.getTime()).toBe(s1.expiresAt?.getTime());
    expect(restored[0]?.data).toEqual(s1.data);
  });

  it('persists an empty list to clear earlier signals', async () => {
    const storage = createJSONStorage(storagePath);
    await persistPendingSignals(storage, logger, [thoughtSignal('x')]);
    await persistPendingSignals(storage, logger, []);

    const restored = await loadPendingSignals(storage, storagePath, logger);
    expect(restored).toEqual([]);
  });

  it('returns no signals when nothing was persisted', async () => {
    const storage = createJSONStorage(storagePath);
    const restored = await loadPendingSignals(storage, storagePath, logger);
    expect(restored).toEqual([]);
  });

  it('fails loudly naming the file when the persisted file is corrupt', async () => {
    const path = pendingSignalsPath(storagePath);
    await mkdir(join(storagePath, 'core'), { recursive: true });
    await writeFile(path, 'not json at all', 'utf-8');

    const storage = createJSONStorage(storagePath);
    await expect(loadPendingSignals(storage, storagePath, logger)).rejects.toThrow(path);
  });

  it('fails loudly when the persisted shape is wrong', async () => {
    await mkdir(join(storagePath, 'core'), { recursive: true });
    await writeFile(pendingSignalsPath(storagePath), JSON.stringify({ version: 1, signals: 'nonsense' }), 'utf-8');

    const storage = createJSONStorage(storagePath);
    await expect(loadPendingSignals(storage, storagePath, logger)).rejects.toThrow(
      pendingSignalsPath(storagePath)
    );
  });
});
