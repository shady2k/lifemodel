/**
 * Unit tests for the container shutdown sequence.
 *
 * Pins the stop order the owner decided for lifemodel-ctc.1.1:
 *   1. channel intake stops first
 *   2. the cognition turn in flight is awaited (coreLoop.stop)
 *   3. signals accepted but unprocessed are persisted through DeferredStorage
 *   4. state and registries persist
 *   5. storage flushes LAST
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { shutdownSequence } from '../../../src/core/container.js';
import { loadPendingSignals } from '../../../src/core/pending-signal-journal.js';
import { createJSONStorage, createDeferredStorage } from '../../../src/storage/index.js';
import type { Signal } from '../../../src/types/signal.js';
import { createSignal } from '../../../src/types/signal.js';
import type { Logger } from '../../../src/types/logger.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shutdown-seq-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noopLogger = {
  child: () => noopLogger,
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function thoughtSignal(text: string): Signal {
  return createSignal(
    'thought',
    'cognition.thought',
    { value: 1 },
    { data: { kind: 'thought', text, triggerSource: 'test', depth: 0, rootThoughtId: 'root' } }
  );
}

function makeDoubles() {
  const steps: string[] = [];
  const channel = {
    name: 'test',
    stopIntake: async () => {
      steps.push('channel.stopIntake');
    },
    stop: async () => {
      steps.push('channel.stop');
    },
  };
  const coreLoop = {
    stop: async () => {
      steps.push('coreLoop.stop');
    },
    takePendingSignals: (): Signal[] => [],
  };
  const stateManager = { shutdown: async () => steps.push('stateManager.shutdown') };
  const recipientRegistry = { flush: async () => steps.push('recipientRegistry.flush') };
  const ackRegistry = { flush: async () => steps.push('ackRegistry.flush') };
  return { steps, channel, coreLoop, stateManager, recipientRegistry, ackRegistry };
}

describe('container shutdown sequence', () => {
  it('stops intake first, persists pending signals, flushes storage last', async () => {
    const d = makeDoubles();
    const json = createJSONStorage(dir);
    const storage = createDeferredStorage(json, noopLogger, { flushIntervalMs: 60_000 });
    const steps = d.steps;

    const storageDouble = {
      load: (key: string) => storage.load(key),
      save: (key: string, data: unknown) => storage.save(key, data),
      delete: (key: string) => storage.delete(key),
      exists: (key: string) => storage.exists(key),
      // the final flush must run BEFORE storage.shutdown completes, so the
      // assertion after the sequence observes flushed state, not cache
      shutdown: async () => {
        await storage.flush();
        steps.push('storage.shutdown');
      },
    };

    await shutdownSequence({
      logger: noopLogger,
      channels: [d.channel] as never,
      coreLoop: {
        ...d.coreLoop,
        takePendingSignals: () => {
          steps.push('takePendingSignals');
          return [thoughtSignal('queued')];
        },
      },
      storage: storageDouble as never,
      storagePath: dir,
      stateManager: d.stateManager as never,
      recipientRegistry: d.recipientRegistry as never,
      ackRegistry: d.ackRegistry as never,
    });

    expect(steps).toEqual([
      'channel.stopIntake',
      'coreLoop.stop',
      'takePendingSignals',
      'stateManager.shutdown',
      'recipientRegistry.flush',
      'ackRegistry.flush',
      'channel.stop',
      'storage.shutdown',
    ]);

    // The pending signals were persisted through the DeferredStorage write batch
    // and flushed by storage.shutdown before it returned.
    const persisted = await loadPendingSignals({ load: (k) => storage.load(k) } as never, dir, noopLogger);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.data).toEqual(thoughtSignal('queued').data);
  });
});
