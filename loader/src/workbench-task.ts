/** Durable loader-owned work, independent of the first-start phase ledger. */
import { join } from 'node:path';
import type { Clock } from './clock.js';
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';

import type { WorkbenchImportStatus } from './workbench-status.js';
export type { WorkbenchImportStatus } from './workbench-status.js';
export interface WorkbenchImportTask {
  status(): WorkbenchImportStatus;
  start(): Promise<void>;
  trigger(): Promise<void>;
  stop(): Promise<void>;
}
export interface WorkbenchImportTaskDeps {
  fs: FileSystem;
  config: { loaderDir: string };
  clock: Clock;
  logger: LoaderLogger;
  pinnedDigest: string;
  run(signal: AbortSignal): Promise<void>;
}
const REASONS = new Set([
  'configuration',
  'credential',
  'unauthorized',
  'unavailable',
  'deadline',
  'aborted',
  'redirect',
  'digest-mismatch',
  'size-limit',
  'manifest',
  'protocol',
]);

/** A saved ready state is display state, not authority: every process verifies zot again. */
export function createWorkbenchImportTask(deps: WorkbenchImportTaskDeps): WorkbenchImportTask {
  const path = join(deps.config.loaderDir, 'workbench-import.json');
  let current: WorkbenchImportStatus = {
    state: 'pending',
    pinnedDigest: deps.pinnedDigest,
    lastAttemptAt: null,
  };
  let stopping = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let wake: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  function record(next: WorkbenchImportStatus): Promise<void> {
    const operation = writes.then(async () => {
      await deps.fs.writeFileAtomic(path, `${JSON.stringify(next)}\n`, 0o600);
      current = next;
    });
    writes = operation.catch(() => undefined);
    return operation;
  }
  async function wait(delay?: number): Promise<void> {
    let release!: () => void;
    const signalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    wake = release;
    try {
      await (delay === undefined ? signalled : Promise.race([signalled, deps.clock.sleep(delay)]));
    } finally {
      if (wake === release) wake = undefined;
    }
  }
  async function loop(): Promise<void> {
    let delayMs = 1000;
    while (!stopping) {
      const attemptGeneration = generation;
      const lastAttemptAt = deps.clock.now();
      try {
        await record({ state: 'importing', pinnedDigest: deps.pinnedDigest, lastAttemptAt });
        if (stopping) return;
        if (attemptGeneration !== generation) continue;
        controller = new AbortController();
        await deps.run(controller.signal);
        if (stopping) return;
        if (attemptGeneration !== generation) {
          delayMs = 1000;
          continue;
        }
        await record({ state: 'ready', pinnedDigest: deps.pinnedDigest, lastAttemptAt });
        deps.logger.info({ code: 'ready' }, 'workbench import is ready');
        delayMs = 1000;
        if (attemptGeneration === generation && !stopping) await wait();
      } catch (error) {
        if (stopping) return;
        if (attemptGeneration !== generation) {
          delayMs = 1000;
          continue;
        }
        const match =
          error instanceof Error ? /^workbench-import:([a-z-]+)$/.exec(error.message) : null;
        const reason = match?.[1] !== undefined && REASONS.has(match[1]) ? match[1] : 'unavailable';
        try {
          await record({ state: 'failed', pinnedDigest: deps.pinnedDigest, lastAttemptAt, reason });
        } catch {
          current = {
            state: 'failed',
            pinnedDigest: deps.pinnedDigest,
            lastAttemptAt,
            reason: 'state-store',
          };
        }
        deps.logger.warn({ code: current.reason ?? reason }, 'workbench import failed; retrying');
        if (attemptGeneration === generation && !stopping) await wait(delayMs);
        delayMs = Math.min(delayMs * 2, 60000);
      } finally {
        controller = undefined;
      }
    }
  }
  return {
    status: () => ({ ...current }),
    start: () => {
      starting ??= (async () => {
        // Recover display history only. Every restart checks the destination.
        try {
          const saved = JSON.parse(await deps.fs.readFile(path)) as Partial<WorkbenchImportStatus>;
          if (
            saved.pinnedDigest === deps.pinnedDigest &&
            typeof saved.lastAttemptAt === 'number' &&
            Number.isFinite(saved.lastAttemptAt)
          )
            current.lastAttemptAt = saved.lastAttemptAt;
        } catch {
          /* Missing or invalid status never suppresses an import. */
        }
        // Assign the startup latch before any await, preventing parallel owners.
        if (!stopping) running = loop();
      })();
      return starting;
    },
    trigger: async () => {
      generation++;
      controller?.abort();
      wake?.();
      await record({
        state: 'pending',
        pinnedDigest: deps.pinnedDigest,
        lastAttemptAt: current.lastAttemptAt,
      });
    },
    stop: async () => {
      stopping = true;
      controller?.abort();
      wake?.();
      await starting;
      await running;
      await writes;
    },
  };
}
