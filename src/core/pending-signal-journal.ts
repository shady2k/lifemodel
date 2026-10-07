/**
 * Pending-signal journal.
 *
 * Persists signals that were accepted by the agent but never processed:
 * - pendingSignals at stop, and
 * - the trigger signal of a cognition turn that was still running past the
 *   stop drain deadline (its turn is redone from this signal after restart).
 *
 * The write goes through Storage (DeferredStorage -> JSONStorage) only
 * (AGENTS.md lesson 4: unified storage path). The persisted file is a
 * versioned envelope; a corrupt file fails loudly with its path so a bad
 * journal is never silently ignored with empty input.
 */
import { join } from 'node:path';

import { encodeDates, decodeDates } from '../utils/json-dates.js';

import type { Signal } from '../types/signal.js';
import type { Logger } from '../types/logger.js';
import type { Storage } from '../storage/index.js';

/** Colon-delimited storage key; maps to <statePath>/core/pending_signals.json. */
export const PENDING_SIGNALS_KEY = 'core:pending_signals';

const ENVELOPE_VERSION = 1;

interface PendingSignalRecord {
  signal: Signal;
  /** When the signal was accepted (ISO string in the file) */
  timestamp: string;
}

interface PendingSignalsEnvelope {
  version: 1;
  savedAt: string;
  signals: PendingSignalRecord[];
}

/** The file the journal writes for a state path. */
export function pendingSignalsPath(storagePath: string): string {
  return join(storagePath, 'core', 'pending_signals.json');
}

/** True if the object looks like a Signal we can put back into the loop. */
function isSignalLike(value: unknown): value is Signal {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<Signal>;
  return (
    typeof s.id === 'string' &&
    typeof s.type === 'string' &&
    s.timestamp instanceof Date &&
    (s.expiresAt === undefined || s.expiresAt instanceof Date)
  );
}

/**
 * Persist the current pending signals, overwriting the previous envelope.
 * An empty list is written too: it clears signals a previous run left behind.
 */
export async function persistPendingSignals(
  storage: Storage,
  logger: Logger,
  signals: Signal[]
): Promise<void> {
  if (signals.length > 0) {
    logger.debug({ count: signals.length }, 'Persisting pending signals for the next start');
  }
  const records: PendingSignalRecord[] = signals.map((signal) => ({
    signal: encodeDates(signal) as Signal,
    timestamp: new Date().toISOString(),
  }));
  const envelope = {
    version: ENVELOPE_VERSION,
    savedAt: new Date().toISOString(),
    signals: records,
  } satisfies PendingSignalsEnvelope;
  await storage.save(PENDING_SIGNALS_KEY, envelope);
}

/**
 * Load the pending signals persisted by the previous stop.
 * Returns [] when nothing was persisted.
 * Throws with the file path when the persisted data cannot be used.
 */
export async function loadPendingSignals(
  storage: Storage,
  storagePath: string,
  logger: Logger
): Promise<Signal[]> {
  const path = pendingSignalsPath(storagePath);
  let raw: unknown;
  try {
    raw = await storage.load(PENDING_SIGNALS_KEY);
  } catch (error) {
    throw new Error(
      `Failed to read pending-signal journal at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  if (raw == null) {
    return [];
  }

  const envelope = decodeDates(raw) as Partial<PendingSignalsEnvelope>;
  if (
    typeof envelope !== 'object' ||
    envelope?.version !== ENVELOPE_VERSION ||
    !Array.isArray(envelope.signals)
  ) {
    throw new Error(`Corrupt pending-signal journal at ${path}: unexpected envelope shape`, {
      cause: raw instanceof Error ? raw : new Error(JSON.stringify(raw).slice(0, 500)),
    });
  }

  const signals: Signal[] = [];
  for (const record of envelope.signals) {
    if (typeof record !== 'object' || record === null || typeof record.timestamp !== 'string') {
      throw new Error(`Corrupt pending-signal journal at ${path}: invalid record envelope`, {
        cause: new Error(JSON.stringify(record).slice(0, 500)),
      });
    }
    // decodeDates already ran at the envelope level - validate the signal as is
    const signal = (record as { signal: unknown }).signal;
    if (!isSignalLike(signal)) {
      throw new Error(`Corrupt pending-signal journal at ${path}: entry is not a valid signal`, {
        cause: new Error(JSON.stringify(signal).slice(0, 500)),
      });
    }
    signals.push(signal);
  }

  if (signals.length > 0) {
    logger.debug({ count: signals.length, path }, 'Pending-signal journal loaded');
  }
  return signals;
}

/**
 * Delete the journal (used after a fresh start restored its content, so a
 * crash later in the run cannot restore the same signals a second time).
 */
export async function clearPendingSignals(storage: Storage, logger: Logger): Promise<void> {
  await storage.delete(PENDING_SIGNALS_KEY);
  logger.debug({ key: PENDING_SIGNALS_KEY }, 'Pending-signal journal cleared');
}
